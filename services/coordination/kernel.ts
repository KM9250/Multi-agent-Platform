import type {
  CoordinationEvent, CoordinationEventType, CoordinationPolicy, CoordinationSession,
  CoordinationSnapshot, CoordinationTask, SessionResolution, TaskCompletedPayload,
  TaskFailedPayload, WorkflowBlockedPayload, WorkflowResumePayload, WorkflowRun, WorkflowStatus,
} from './types';
import { validatePolicy } from './policy';

const emptyUsage = () => ({ rounds: 0, llmCalls: 0, inputTokens: 0, outputTokens: 0, estimatedCost: 0, consecutiveErrors: 0, noProgressCycles: 0 });
const TERMINAL_WORKFLOW_STATUSES = new Set<WorkflowStatus>(['RESOLVED', 'CANCELLED', 'FAILED']);
const STOPPED_WORKFLOW_STATUSES = new Set<WorkflowStatus>(['SUSPENDED', 'BLOCKED']);
const ALLOWED_WHILE_STOPPED = new Set<CoordinationEventType>(['WorkflowResumed', 'WorkflowCancelled', 'ErrorRecorded']);
const SESSION_SCOPED_EVENTS = new Set<CoordinationEventType>([
  'SessionSuspended', 'SessionResumed', 'SessionResolved', 'SessionCancelled', 'SessionExpired',
  'TaskAssigned', 'TaskCompleted', 'TaskFailed', 'TaskCancelled', 'EvaluationAdded', 'PolicyEvaluated',
  'CommitmentRequested', 'CommitmentAccepted',
]);

const clone = <T>(value: T): T => {
  if (Array.isArray(value)) return value.map(entry => clone(entry)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)])) as T;
  }
  return value;
};

const clonePolicy = (policy: CoordinationPolicy): CoordinationPolicy => clone(policy);
const stableSerialize = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`).join(',')}}`;
};
const isSameSemanticEvent = (left: CoordinationEvent, right: CoordinationEvent): boolean =>
  left.type === right.type && left.workflowRunId === right.workflowRunId
  && left.sessionId === right.sessionId && left.actorAgentId === right.actorAgentId
  && stableSerialize(left.payload) === stableSerialize(right.payload);

const requireExistingSession = (sessions: Record<string, CoordinationSession>, event: CoordinationEvent): CoordinationSession => {
  if (!event.sessionId) throw new Error(`${event.type} requires a sessionId.`);
  const session = sessions[event.sessionId];
  if (!session) throw new Error(`Session does not exist: ${event.sessionId}`);
  return session;
};
const requireSupervisor = (run: WorkflowRun, event: CoordinationEvent): void => {
  if (event.actorAgentId !== run.supervisorAgentId) throw new Error('Only the configured supervisor may perform this transition.');
};
const requireTaskSession = (session: CoordinationSession): void => {
  if (session.mode !== 'map.coord.task.v1') throw new Error('Session mode does not accept tasks.');
};
const requireOpenSession = (session: CoordinationSession): void => {
  if (session.state !== 'OPEN') throw new Error('Session is not open.');
};
const validateRefs = (refs: string[] | undefined, name: string): string[] | undefined => {
  if (!refs) return undefined;
  const normalized = refs.map(ref => ref.trim());
  if (normalized.some(ref => !ref)) throw new Error(`${name} cannot contain empty references.`);
  if (new Set(normalized).size !== normalized.length) throw new Error(`${name} cannot contain duplicate references.`);
  return normalized;
};
const requireTask = (tasks: Record<string, CoordinationTask>, event: CoordinationEvent): CoordinationTask => {
  const taskId = (event.payload as { taskId?: string } | undefined)?.taskId;
  if (!taskId || !tasks[taskId]) throw new Error('Task does not exist.');
  return tasks[taskId];
};

export interface CreateWorkflowInput {
  runId: string; roomId: string; goal: string; acceptanceCriteria: string[];
  supervisorAgentId: string; participantAgentIds: string[];
  executionMode: WorkflowRun['executionMode']; policy: CoordinationPolicy; now?: number;
}

export const createWorkflow = (input: CreateWorkflowInput): CoordinationSnapshot => {
  validatePolicy(input.policy);
  const participants = input.participantAgentIds.map(id => id.trim());
  if (participants.some(id => !id)) throw new Error('Participant IDs cannot be empty.');
  if (!participants.includes(input.supervisorAgentId)) throw new Error('Supervisor must be a Persona participant.');
  if (!input.goal.trim()) throw new Error('Workflow goal is required.');
  const criteria = input.acceptanceCriteria.map(value => value.trim());
  if (criteria.some(value => !value)) throw new Error('Acceptance criteria cannot be empty.');
  if (new Set(criteria).size !== criteria.length) throw new Error('Acceptance criteria cannot contain duplicates.');
  const now = input.now ?? Date.now();
  const policy = clonePolicy(input.policy);
  const run: WorkflowRun = {
    runId: input.runId, roomId: input.roomId, goal: input.goal.trim(), acceptanceCriteria: criteria,
    satisfiedCriteria: [], supervisorAgentId: input.supervisorAgentId,
    participantAgentIds: [...new Set(participants)], executionMode: input.executionMode,
    policyId: policy.policyId, policyVersion: policy.version, status: 'RUNNING', budget: clone(policy.budgets),
    usage: emptyUsage(), createdAt: now, updatedAt: now,
  };
  const payload = { roomId: run.roomId, goal: run.goal, acceptanceCriteria: [...criteria], supervisorAgentId: run.supervisorAgentId,
    participantAgentIds: [...run.participantAgentIds], executionMode: run.executionMode, policyId: run.policyId, policyVersion: run.policyVersion };
  return appendEvent({ run, policy, sessions: {}, tasks: {}, events: [] }, {
    eventId: `${input.runId}:created`, sequence: 1, type: 'WorkflowRunCreated', workflowRunId: input.runId,
    actorAgentId: input.supervisorAgentId, timestamp: now, payload,
  });
};

/** Validates and applies one event, then records an isolated journal copy. */
export const appendEvent = (snapshot: CoordinationSnapshot, event: CoordinationEvent): CoordinationSnapshot => {
  if (event.workflowRunId !== snapshot.run.runId) throw new Error('Event belongs to another workflow.');
  const existingById = snapshot.events.find(existing => existing.eventId === event.eventId);
  if (existingById) {
    if (isSameSemanticEvent(existingById, event)) return snapshot;
    throw new Error('Event ID collision.');
  }
  if (event.idempotencyKey) {
    const existing = snapshot.events.find(candidate => candidate.idempotencyKey === event.idempotencyKey);
    if (existing) {
      if (isSameSemanticEvent(existing, event)) return snapshot;
      throw new Error('Idempotency key collision.');
    }
  }
  if (TERMINAL_WORKFLOW_STATUSES.has(snapshot.run.status)) throw new Error(`Workflow is already terminal: ${snapshot.run.status}`);
  if (STOPPED_WORKFLOW_STATUSES.has(snapshot.run.status) && !ALLOWED_WHILE_STOPPED.has(event.type)) throw new Error(`Workflow is stopped: ${snapshot.run.status}`);
  const expected = snapshot.events.length ? snapshot.events.at(-1)!.sequence + 1 : 1;
  if (event.sequence !== expected) throw new Error(`Expected event sequence ${expected}.`);

  const run = { ...snapshot.run, updatedAt: event.timestamp };
  const sessions = { ...snapshot.sessions };
  const tasks = { ...snapshot.tasks };

  if (event.type === 'SessionStarted') {
    const value = event.payload as CoordinationSession;
    if (!value || typeof value !== 'object') throw new Error('SessionStarted requires a session payload.');
    if (!value.sessionId?.trim()) throw new Error('Session ID is required.');
    if (sessions[value.sessionId]) throw new Error(`Duplicate session ID: ${value.sessionId}`);
    if (event.sessionId && event.sessionId !== value.sessionId) throw new Error('Event and payload session IDs must match.');
    if (value.workflowRunId !== run.runId) throw new Error('Session belongs to another workflow.');
    if (value.policyId !== run.policyId || value.policyVersion !== run.policyVersion) throw new Error('Session policy must match the workflow policy.');
    if (value.supervisor !== run.supervisorAgentId) throw new Error('Session supervisor must match the workflow supervisor.');
    if (value.state !== 'OPEN') throw new Error('A new session must be OPEN.');
    if (!value.goal.trim()) throw new Error('Session goal is required.');
    if (!value.participants.length) throw new Error('Session must have at least one participant.');
    if (value.participants.some(id => !id.trim())) throw new Error('Session participant IDs cannot be empty.');
    if (new Set(value.participants).size !== value.participants.length) throw new Error('Session participants cannot contain duplicates.');
    if (value.participants.some(id => !run.participantAgentIds.includes(id))) throw new Error('Only workflow Persona participants may join a session.');
    if (!run.participantAgentIds.includes(value.initiator)) throw new Error('Session initiator must be a workflow participant.');
    if (!value.participants.includes(run.supervisorAgentId)) throw new Error('Session participants must include the supervisor.');
    sessions[value.sessionId] = clone(value); run.currentSessionId = value.sessionId;
  } else if (event.type.startsWith('Session')) {
    const session = requireExistingSession(sessions, event); requireSupervisor(run, event);
    if (event.type === 'SessionSuspended') {
      requireOpenSession(session); sessions[session.sessionId] = { ...session, state: 'SUSPENDED', updatedAt: event.timestamp };
    } else if (event.type === 'SessionResumed') {
      if (run.status !== 'RUNNING') throw new Error('Workflow must be running to resume a session.');
      if (session.state !== 'SUSPENDED') throw new Error('Session is not suspended.');
      sessions[session.sessionId] = { ...session, state: 'OPEN', updatedAt: event.timestamp };
    } else if (event.type === 'SessionCancelled' || event.type === 'SessionExpired') {
      if (session.state !== 'OPEN' && session.state !== 'SUSPENDED') throw new Error('Session is already terminal.');
      sessions[session.sessionId] = { ...session, state: event.type === 'SessionCancelled' ? 'CANCELLED' : 'EXPIRED', updatedAt: event.timestamp };
    } else if (event.type === 'SessionResolved') {
      requireOpenSession(session);
      const resolution = event.payload as SessionResolution;
      if (!resolution || (resolution.outcome !== 'SUCCEEDED' && resolution.outcome !== 'FAILED')) throw new Error('Session resolution outcome is invalid.');
      if (session.mode !== 'map.coord.task.v1') throw new Error('Session mode is not resolvable in COORD-2A.');
      const sessionTasks = Object.values(tasks).filter(task => task.sessionId === session.sessionId);
      if (!sessionTasks.length) throw new Error('Session resolution requires at least one task.');
      if (sessionTasks.some(task => task.status === 'ASSIGNED')) throw new Error('All session tasks must be terminal.');
      if (resolution.outcome === 'SUCCEEDED' && !sessionTasks.some(task => task.status === 'COMPLETED')) throw new Error('Successful session requires a completed task.');
      const evidenceRefs = validateRefs(resolution.evidenceRefs, 'evidenceRefs');
      sessions[session.sessionId] = { ...session, state: 'RESOLVED', resolution: { ...clone(resolution), evidenceRefs }, updatedAt: event.timestamp };
    }
    run.currentSessionId = session.sessionId;
  } else if (event.type === 'TaskAssigned') {
    const session = requireExistingSession(sessions, event); requireOpenSession(session); requireTaskSession(session);
    const task = event.payload as CoordinationTask;
    if (!task?.taskId?.trim()) throw new Error('Task ID is required.');
    if (tasks[task.taskId]) throw new Error(`Duplicate task ID: ${task.taskId}`);
    if (task.workflowRunId !== run.runId) throw new Error('Task belongs to another workflow.');
    if (task.sessionId !== event.sessionId) throw new Error('Event and task session IDs must match.');
    if (!task.title?.trim() || !task.goal?.trim()) throw new Error('Task title and goal are required.');
    if (!session.participants.includes(task.assigneeAgentId) || !run.participantAgentIds.includes(task.assigneeAgentId)) throw new Error('Task assignee must be a Persona participant.');
    if (!session.participants.includes(task.assignedByAgentId) || task.assignedByAgentId !== event.actorAgentId) throw new Error('Task assigner must match the participating actor.');
    if (task.status !== 'ASSIGNED') throw new Error('A new task must be ASSIGNED.');
    if (task.resultRef !== undefined || task.evidenceRefs !== undefined || task.failureReason !== undefined) throw new Error('A new task cannot contain terminal result fields.');
    tasks[task.taskId] = { ...clone(task), title: task.title.trim(), goal: task.goal.trim(), inputRefs: validateRefs(task.inputRefs, 'inputRefs') };
  } else if (event.type === 'TaskCompleted' || event.type === 'TaskFailed' || event.type === 'TaskCancelled') {
    const session = requireExistingSession(sessions, event); requireOpenSession(session); requireTaskSession(session);
    const task = requireTask(tasks, event);
    if (task.sessionId !== session.sessionId) throw new Error('Task does not belong to the event session.');
    if (task.status !== 'ASSIGNED') throw new Error('Task is not active.');
    if (event.type === 'TaskCompleted') {
      if (event.actorAgentId !== task.assigneeAgentId) throw new Error('Task assignee mismatch.');
      const payload = event.payload as TaskCompletedPayload & { taskId: string };
      const resultRef = payload.resultRef?.trim(); const evidenceRefs = validateRefs(payload.evidenceRefs, 'evidenceRefs');
      if (!resultRef && !evidenceRefs?.length) throw new Error('Task completion requires a result or evidence.');
      tasks[task.taskId] = { ...task, status: 'COMPLETED', resultRef, evidenceRefs, updatedAt: event.timestamp };
    } else if (event.type === 'TaskFailed') {
      if (event.actorAgentId !== task.assigneeAgentId && event.actorAgentId !== run.supervisorAgentId) throw new Error('Only the task assignee or supervisor may fail a task.');
      const payload = event.payload as TaskFailedPayload & { taskId: string };
      if (!payload.failureReason?.trim()) throw new Error('Task failure reason is required.');
      tasks[task.taskId] = { ...task, status: 'FAILED', failureReason: payload.failureReason.trim(), evidenceRefs: validateRefs(payload.evidenceRefs, 'evidenceRefs'), updatedAt: event.timestamp };
    } else {
      requireSupervisor(run, event); tasks[task.taskId] = { ...task, status: 'CANCELLED', updatedAt: event.timestamp };
    }
  } else if (event.type === 'WorkflowSuspended' || event.type === 'WorkflowBlocked') {
    requireSupervisor(run, event);
    if (run.status !== 'RUNNING') throw new Error('Workflow must be running to stop.');
    const reason = (event.payload as WorkflowBlockedPayload | undefined)?.reason?.trim();
    if (event.type === 'WorkflowBlocked' && !reason) throw new Error('Workflow block reason is required.');
    run.status = event.type === 'WorkflowBlocked' ? 'BLOCKED' : 'SUSPENDED'; run.statusReason = reason || 'NEEDS_USER';
    for (const session of Object.values(sessions)) if (session.state === 'OPEN') sessions[session.sessionId] = { ...session, state: 'SUSPENDED', updatedAt: event.timestamp };
  } else if (event.type === 'WorkflowResumed') {
    requireSupervisor(run, event);
    if (!STOPPED_WORKFLOW_STATUSES.has(run.status)) throw new Error('Workflow is not stopped.');
    const payload = event.payload as WorkflowResumePayload | undefined;
    if (payload?.authorization?.type !== 'user') throw new Error('User authorization is required to resume workflow.');
    run.status = 'RUNNING'; delete run.statusReason;
    for (const session of Object.values(sessions)) if (session.state === 'SUSPENDED') sessions[session.sessionId] = { ...session, state: 'OPEN', updatedAt: event.timestamp };
  } else if (event.type === 'WorkflowCancelled') {
    run.status = 'CANCELLED';
    for (const session of Object.values(sessions)) if (session.state === 'OPEN' || session.state === 'SUSPENDED') sessions[session.sessionId] = { ...session, state: 'CANCELLED', updatedAt: event.timestamp };
    for (const task of Object.values(tasks)) if (task.status === 'ASSIGNED') tasks[task.taskId] = { ...task, status: 'CANCELLED', updatedAt: event.timestamp };
  } else if (event.type === 'CommitmentAccepted') {
    if (event.actorAgentId !== run.supervisorAgentId) throw new Error('Only the configured supervisor may accept a commitment.');
    if (run.status !== 'RUNNING') throw new Error(`Workflow is not commit-ready: ${run.status}`);
    const session = requireExistingSession(sessions, event);
    if (session.state !== 'OPEN') throw new Error(`Session is not commit-ready: ${session.state}`);
    const other = Object.values(sessions).some(candidate => candidate.sessionId !== session.sessionId && (candidate.state === 'OPEN' || candidate.state === 'SUSPENDED'));
    if (other) throw new Error('Cannot resolve workflow while other sessions remain unresolved.');
    run.status = 'RESOLVED'; delete run.statusReason; sessions[session.sessionId] = { ...session, state: 'RESOLVED', updatedAt: event.timestamp };
    for (const task of Object.values(tasks)) if (task.status === 'ASSIGNED') tasks[task.taskId] = { ...task, status: 'CANCELLED', updatedAt: event.timestamp };
  } else if (SESSION_SCOPED_EVENTS.has(event.type)) {
    requireExistingSession(sessions, event);
  }
  return { run, policy: snapshot.policy, sessions, tasks, events: [...snapshot.events, clone(event)] };
};
