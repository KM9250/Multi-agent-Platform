import type {
  CoordinationEvent, CoordinationEventType, CoordinationPolicy, CoordinationSession,
  CoordinationSnapshot, CoordinationTask, CoordinationDecision, CoordinationQuorum, CoordinationEvaluation,
  DecisionResolvedPayload, QuorumVoteCastPayload, QuorumResolvedPayload, SessionResolution, TaskCompletedPayload,
  TaskFailedPayload, WorkflowBlockedPayload, WorkflowResumePayload, WorkflowRun,
  AcceptanceCriterionEvaluatedPayload, CommitmentPolicyEvaluationPayload, CommitmentRequestedPayload,
  CommitmentAcceptedPayload, CommitmentRejectedPayload,
  UsageRecordedPayload, ProgressRecordedPayload,
} from './types';
import { ALLOWED_WHILE_STOPPED, COORDINATION_EVENT_TYPES, STOPPED_WORKFLOW_STATUSES, TERMINAL_WORKFLOW_STATUSES } from './types';
import { validatePolicy } from './policy';
import { evaluateQuorumOutcome, requiredQuorumApprovals } from './quorum';
import { commitmentGateResultsEqual, evaluateCommitmentGate } from './completion';
import { applyProgress, applyUsageDelta, emptyWorkflowUsage, validateProgressPayload, validateUsagePayload } from './usage';

const SESSION_SCOPED_EVENTS = new Set<CoordinationEventType>([
  'SessionSuspended', 'SessionResumed', 'SessionResolved', 'SessionCancelled', 'SessionExpired',
  'TaskAssigned', 'TaskCompleted', 'TaskFailed', 'TaskCancelled', 'EvaluationAdded',
  'DecisionOpened', 'DecisionResolved', 'DecisionCancelled',
  'QuorumOpened', 'QuorumVoteCast', 'QuorumResolved', 'QuorumCancelled',
]);
const ACCEPTANCE_EVIDENCE_TYPES = new Set<CoordinationEventType>(['TaskCompleted', 'TaskFailed', 'DecisionResolved', 'QuorumResolved', 'EvaluationAdded', 'SessionResolved']);

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
const requireWorkflowScopedEvent = (event: CoordinationEvent): void => {
  if (event.sessionId !== undefined) throw new Error(`${event.type} must not include a sessionId.`);
};
const requireTaskSession = (session: CoordinationSession): void => {
  if (session.mode !== 'map.coord.task.v1') throw new Error('Session mode does not accept tasks.');
};
const requireDecisionSession = (session: CoordinationSession): void => {
  if (session.mode !== 'map.coord.decision.v1') throw new Error('Session mode does not accept decisions.');
};
const requireQuorumSession = (session: CoordinationSession): void => {
  if (session.mode !== 'map.coord.quorum.v1') throw new Error('Session mode does not accept quorums.');
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

const validateTaskSessionResolution = (
  session: CoordinationSession,
  tasks: Record<string, CoordinationTask>,
  outcome: SessionResolution['outcome'],
): void => {
  if (session.mode !== 'map.coord.task.v1') throw new Error('Session mode is not resolvable in COORD-2A.');
  const sessionTasks = Object.values(tasks).filter(task => task.sessionId === session.sessionId);
  if (!sessionTasks.length) throw new Error('Session resolution requires at least one task.');
  if (sessionTasks.some(task => task.status === 'ASSIGNED')) throw new Error('All session tasks must be terminal.');
  if (outcome === 'SUCCEEDED' && !sessionTasks.some(task => task.status === 'COMPLETED')) {
    throw new Error('Successful session requires a completed task.');
  }
};

const validateSessionResolution = (session: CoordinationSession, snapshot: Pick<CoordinationSnapshot, 'tasks' | 'decisions' | 'quorums'>, outcome: SessionResolution['outcome']): void => {
  if (session.mode === 'map.coord.task.v1') return validateTaskSessionResolution(session, snapshot.tasks, outcome);
  if (session.mode === 'map.coord.decision.v1') {
    const values = Object.values(snapshot.decisions).filter(value => value.sessionId === session.sessionId);
    if (!values.length) throw new Error('Session resolution requires at least one decision.');
    if (values.some(value => value.status === 'OPEN')) throw new Error('All session decisions must be terminal.');
    if (outcome === 'SUCCEEDED' && !values.some(value => value.status === 'RESOLVED')) throw new Error('Successful session requires a resolved decision.');
    return;
  }
  const values = Object.values(snapshot.quorums).filter(value => value.sessionId === session.sessionId);
  if (!values.length) throw new Error('Session resolution requires at least one quorum.');
  if (values.some(value => value.status === 'OPEN')) throw new Error('All session quorums must be terminal.');
  if (outcome === 'SUCCEEDED' && !values.some(value => value.status === 'RESOLVED' && value.outcome === 'APPROVED')) {
    throw new Error('Successful session requires an approved quorum.');
  }
};

const cancelActiveSessionTasks = (
  tasks: Record<string, CoordinationTask>,
  sessionId: string,
  timestamp: number,
): void => {
  for (const task of Object.values(tasks)) {
    if (task.sessionId === sessionId && task.status === 'ASSIGNED') {
      tasks[task.taskId] = { ...task, status: 'CANCELLED', updatedAt: timestamp };
    }
  }
};
const cancelOpenPrincipals = (decisions: Record<string, CoordinationDecision>, quorums: Record<string, CoordinationQuorum>, sessionId: string, timestamp: number): void => {
  for (const value of Object.values(decisions)) if (value.sessionId === sessionId && value.status === 'OPEN') decisions[value.decisionId] = { ...value, status: 'CANCELLED', updatedAt: timestamp };
  for (const value of Object.values(quorums)) if (value.sessionId === sessionId && value.status === 'OPEN') quorums[value.quorumId] = { ...value, status: 'CANCELLED', updatedAt: timestamp };
};

export interface CreateWorkflowInput {
  runId: string; roomId: string; goal: string; acceptanceCriteria: string[];
  supervisorAgentId: string; participantAgentIds: string[];
  executionMode: WorkflowRun['executionMode']; policy: CoordinationPolicy; now?: number;
}

export const createWorkflow = (input: CreateWorkflowInput): CoordinationSnapshot => {
  validatePolicy(input.policy);
  if (!['interactive', 'supervised_autonomous'].includes(input.executionMode)) throw new Error('Execution mode is invalid.');
  const participants = input.participantAgentIds.map(id => id.trim());
  if (!participants.length) throw new Error('Workflow requires at least one participant.');
  if (participants.some(id => !id)) throw new Error('Participant IDs cannot be empty.');
  if (new Set(participants).size !== participants.length) throw new Error('Participant IDs cannot contain duplicates.');
  if (!participants.includes(input.supervisorAgentId)) throw new Error('Supervisor must be a Persona participant.');
  if (!input.goal.trim()) throw new Error('Workflow goal is required.');
  const criteria = input.acceptanceCriteria.map(value => value.trim());
  if (criteria.some(value => !value)) throw new Error('Acceptance criteria cannot be empty.');
  if (new Set(criteria).size !== criteria.length) throw new Error('Acceptance criteria cannot contain duplicates.');
  const now = input.now ?? Date.now();
  if (!Number.isFinite(now) || now < 0) throw new Error('Workflow timestamp must be finite and non-negative.');
  const policy = clonePolicy(input.policy);
  const run: WorkflowRun = {
    runId: input.runId, roomId: input.roomId, goal: input.goal.trim(), acceptanceCriteria: criteria,
    satisfiedCriteria: [], supervisorAgentId: input.supervisorAgentId,
    participantAgentIds: [...new Set(participants)], executionMode: input.executionMode,
    policyId: policy.policyId, policyVersion: policy.version, status: 'RUNNING', budget: clone(policy.budgets),
    usage: emptyWorkflowUsage(), createdAt: now, updatedAt: now,
  };
  const payload = { roomId: run.roomId, goal: run.goal, acceptanceCriteria: [...criteria], supervisorAgentId: run.supervisorAgentId,
    participantAgentIds: [...run.participantAgentIds], executionMode: run.executionMode, policyId: run.policyId, policyVersion: run.policyVersion };
  return appendEvent({ run, policy, sessions: {}, tasks: {}, decisions: {}, quorums: {}, evaluations: {}, events: [] }, {
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
  if (!COORDINATION_EVENT_TYPES.has(event.type)) throw new Error('Coordination event type is invalid.');
  if (event.type === 'WorkflowRunCreated' && snapshot.events.length > 0) throw new Error('WorkflowRunCreated may only begin the journal.');
  if (!Number.isFinite(event.timestamp) || event.timestamp < 0) throw new Error('Event timestamp must be finite and non-negative.');
  const lastTimestamp = snapshot.events.at(-1)?.timestamp;
  if (lastTimestamp !== undefined && event.timestamp < lastTimestamp) throw new Error('Event timestamp cannot move backwards.');
  if (TERMINAL_WORKFLOW_STATUSES.has(snapshot.run.status)) throw new Error(`Workflow is already terminal: ${snapshot.run.status}`);
  if (STOPPED_WORKFLOW_STATUSES.has(snapshot.run.status) && !ALLOWED_WHILE_STOPPED.has(event.type)) throw new Error(`Workflow is stopped: ${snapshot.run.status}`);
  const expected = snapshot.events.length ? snapshot.events.at(-1)!.sequence + 1 : 1;
  if (event.sequence !== expected) throw new Error(`Expected event sequence ${expected}.`);
  const journalEvent = clone(event);

  const run = { ...snapshot.run, updatedAt: event.timestamp };
  const sessions = { ...snapshot.sessions };
  const tasks = { ...snapshot.tasks };
  const decisions = { ...snapshot.decisions };
  const quorums = { ...snapshot.quorums };
  const evaluations = { ...snapshot.evaluations };
  let commitment = snapshot.commitment ? clone(snapshot.commitment) : undefined;

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
    if (!['map.coord.task.v1', 'map.coord.decision.v1', 'map.coord.quorum.v1'].includes(value.mode)) throw new Error('Session mode is invalid.');
    if (!Number.isFinite(value.createdAt) || !Number.isFinite(value.updatedAt)
      || value.createdAt < run.createdAt || value.createdAt > value.updatedAt || value.updatedAt > event.timestamp) throw new Error('Session timestamps are invalid.');
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
      cancelActiveSessionTasks(tasks, session.sessionId, event.timestamp);
      cancelOpenPrincipals(decisions, quorums, session.sessionId, event.timestamp);
    } else if (event.type === 'SessionResolved') {
      requireOpenSession(session);
      const resolution = event.payload as SessionResolution;
      if (!resolution || (resolution.outcome !== 'SUCCEEDED' && resolution.outcome !== 'FAILED')) throw new Error('Session resolution outcome is invalid.');
      validateSessionResolution(session, { tasks, decisions, quorums }, resolution.outcome);
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
    if (!Number.isFinite(task.createdAt) || !Number.isFinite(task.updatedAt)
      || task.createdAt < run.createdAt || task.createdAt > task.updatedAt || task.updatedAt > event.timestamp) throw new Error('Task timestamps are invalid.');
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
  } else if (event.type === 'DecisionOpened') {
    const session = requireExistingSession(sessions, event); requireOpenSession(session); requireDecisionSession(session); requireSupervisor(run, event);
    const value = event.payload as CoordinationDecision;
    if (!value?.decisionId?.trim()) throw new Error('Decision ID is required.');
    if (decisions[value.decisionId]) throw new Error(`Duplicate decision ID: ${value.decisionId}`);
    if (value.workflowRunId !== run.runId || value.sessionId !== event.sessionId) throw new Error('Decision ownership does not match the event.');
    if (!value.question?.trim()) throw new Error('Decision question is required.');
    if (!session.participants.includes(value.authorityAgentId) || !run.participantAgentIds.includes(value.authorityAgentId)) throw new Error('Decision authority must be a Persona participant.');
    if (value.status !== 'OPEN') throw new Error('A new decision must be OPEN.');
    if (!Number.isFinite(value.createdAt) || !Number.isFinite(value.updatedAt)
      || value.createdAt < run.createdAt || value.createdAt > value.updatedAt || value.updatedAt > event.timestamp) throw new Error('Decision timestamps are invalid.');
    if (value.value !== undefined || value.rationaleRef !== undefined || value.evidenceRefs !== undefined) throw new Error('A new decision cannot contain terminal result fields.');
    const options = value.options?.map(option => option.trim());
    if (options && (!options.length || options.some(option => !option) || new Set(options).size !== options.length)) throw new Error('Decision options must be non-empty and unique.');
    decisions[value.decisionId] = { ...clone(value), question: value.question.trim(), options };
  } else if (event.type === 'DecisionResolved' || event.type === 'DecisionCancelled') {
    const session = requireExistingSession(sessions, event); requireOpenSession(session); requireDecisionSession(session);
    const id = (event.payload as { decisionId?: string })?.decisionId; const value = id ? decisions[id] : undefined;
    if (!value) throw new Error('Decision does not exist.');
    if (value.sessionId !== session.sessionId) throw new Error('Decision does not belong to the event session.');
    if (value.status !== 'OPEN') throw new Error('Decision is not open.');
    if (event.type === 'DecisionCancelled') { requireSupervisor(run, event); decisions[value.decisionId] = { ...value, status: 'CANCELLED', updatedAt: event.timestamp }; }
    else {
      if (event.actorAgentId !== value.authorityAgentId) throw new Error('Decision authority mismatch.');
      const payload = event.payload as DecisionResolvedPayload; const resolved = payload.value?.trim();
      if (!resolved) throw new Error('Decision value is required.');
      if (value.options && !value.options.includes(resolved)) throw new Error('Decision value must match a configured option.');
      const rationaleRef = payload.rationaleRef?.trim(); if (payload.rationaleRef !== undefined && !rationaleRef) throw new Error('rationaleRef cannot be empty.');
      decisions[value.decisionId] = { ...value, status: 'RESOLVED', value: resolved, rationaleRef, evidenceRefs: validateRefs(payload.evidenceRefs, 'evidenceRefs'), updatedAt: event.timestamp };
    }
  } else if (event.type === 'QuorumOpened') {
    const session = requireExistingSession(sessions, event); requireOpenSession(session); requireQuorumSession(session); requireSupervisor(run, event);
    const value = event.payload as CoordinationQuorum;
    if (!value?.quorumId?.trim()) throw new Error('Quorum ID is required.');
    if (quorums[value.quorumId]) throw new Error(`Duplicate quorum ID: ${value.quorumId}`);
    if (value.workflowRunId !== run.runId || value.sessionId !== event.sessionId) throw new Error('Quorum ownership does not match the event.');
    if (!value.question?.trim()) throw new Error('Quorum question is required.');
    if (!value.eligibleAgentIds?.length || value.eligibleAgentIds.some(id => !id.trim()) || new Set(value.eligibleAgentIds).size !== value.eligibleAgentIds.length) throw new Error('Eligible agents must be non-empty and unique.');
    if (value.eligibleAgentIds.some(id => !session.participants.includes(id) || !run.participantAgentIds.includes(id))) throw new Error('Eligible agent must be a Persona participant.');
    requiredQuorumApprovals(value.threshold, value.eligibleAgentIds.length);
    if (!Number.isFinite(value.createdAt) || !Number.isFinite(value.updatedAt)
      || value.createdAt < run.createdAt || value.createdAt > value.updatedAt || value.updatedAt > event.timestamp) throw new Error('Quorum timestamps are invalid.');
    if (Object.keys(value.votes ?? {}).length || value.status !== 'OPEN' || value.outcome !== undefined) throw new Error('A new quorum must be OPEN without votes or outcome.');
    quorums[value.quorumId] = { ...clone(value), question: value.question.trim(), eligibleAgentIds: [...value.eligibleAgentIds], votes: {} };
  } else if (event.type === 'QuorumVoteCast' || event.type === 'QuorumResolved' || event.type === 'QuorumCancelled') {
    const session = requireExistingSession(sessions, event); requireOpenSession(session); requireQuorumSession(session);
    const id = (event.payload as { quorumId?: string })?.quorumId; const value = id ? quorums[id] : undefined;
    if (!value) throw new Error('Quorum does not exist.');
    if (value.sessionId !== session.sessionId) throw new Error('Quorum does not belong to the event session.');
    if (value.status !== 'OPEN') throw new Error('Quorum is not open.');
    if (event.type === 'QuorumVoteCast') {
      const payload = event.payload as QuorumVoteCastPayload;
      if (!event.actorAgentId || !value.eligibleAgentIds.includes(event.actorAgentId)) throw new Error('Agent is not eligible to vote.');
      if (!['APPROVE', 'REJECT', 'ABSTAIN'].includes(payload.vote)) throw new Error('Quorum vote is invalid.');
      quorums[value.quorumId] = { ...value, votes: { ...value.votes, [event.actorAgentId]: payload.vote }, updatedAt: event.timestamp };
    } else if (event.type === 'QuorumCancelled') { requireSupervisor(run, event); quorums[value.quorumId] = { ...value, status: 'CANCELLED', updatedAt: event.timestamp }; }
    else {
      requireSupervisor(run, event); const payload = event.payload as QuorumResolvedPayload; const calculated = evaluateQuorumOutcome(value);
      if (calculated.state === 'PENDING') throw new Error('Quorum outcome is still pending.');
      if (payload.outcome !== calculated.state) throw new Error('Quorum outcome does not match calculated result.');
      quorums[value.quorumId] = { ...value, status: 'RESOLVED', outcome: calculated.state, updatedAt: event.timestamp };
    }
  } else if (event.type === 'EvaluationAdded') {
    const session = requireExistingSession(sessions, event); requireOpenSession(session); const value = event.payload as CoordinationEvaluation;
    if (!value?.evaluationId?.trim()) throw new Error('Evaluation ID is required.');
    if (evaluations[value.evaluationId]) throw new Error(`Duplicate evaluation ID: ${value.evaluationId}`);
    if (value.workflowRunId !== run.runId || value.sessionId !== event.sessionId) throw new Error('Evaluation ownership does not match the event.');
    if (event.actorAgentId !== value.evaluatorAgentId) throw new Error('Evaluation actor must match evaluator.');
    if (!session.participants.includes(value.evaluatorAgentId)) throw new Error('Evaluator must be a session participant.');
    if (!['PASS', 'FAIL', 'INCONCLUSIVE'].includes(value.outcome)) throw new Error('Evaluation outcome is invalid.');
    const target = value.target; let normalizedTarget = clone(target);
    if (target?.type === 'artifact') { const ref = target.ref?.trim(); if (!ref) throw new Error('Evaluation artifact reference is required.'); normalizedTarget = { ...target, ref }; }
    else { const entity = target?.type === 'task' ? tasks[target.id] : target?.type === 'decision' ? decisions[target.id] : target?.type === 'quorum' ? quorums[target.id] : undefined; if (!entity) throw new Error('Evaluation target does not exist.'); if (entity.sessionId !== session.sessionId) throw new Error('Evaluation target belongs to another session.'); }
    const summary = value.summary?.trim(); if (value.summary !== undefined && !summary) throw new Error('Evaluation summary cannot be empty.');
    const createdAt = value.createdAt ?? event.timestamp;
    if (!Number.isFinite(createdAt) || createdAt < run.createdAt || createdAt > event.timestamp) throw new Error('Evaluation timestamp is invalid.');
    evaluations[value.evaluationId] = { ...clone(value), createdAt, target: normalizedTarget, summary, evidenceRefs: validateRefs(value.evidenceRefs, 'evidenceRefs') };
  } else if (event.type === 'AcceptanceCriterionEvaluated') {
    requireWorkflowScopedEvent(event); requireSupervisor(run, event);
    const payload = event.payload as AcceptanceCriterionEvaluatedPayload;
    const criterion = payload?.criterion?.trim();
    if (!criterion || !run.acceptanceCriteria.includes(criterion)) throw new Error('Acceptance criterion is unknown.');
    if (payload.outcome !== 'SATISFIED' && payload.outcome !== 'UNSATISFIED') throw new Error('Acceptance outcome is invalid.');
    const evidenceEventIds = validateRefs(payload.evidenceEventIds, 'evidenceEventIds') ?? [];
    if (payload.outcome === 'SATISFIED' && !evidenceEventIds.length) throw new Error('Satisfied criterion requires evidence.');
    for (const id of evidenceEventIds) { const evidence = snapshot.events.find(candidate => candidate.eventId === id); if (!evidence) throw new Error('Acceptance evidence must reference a prior event.'); if (!ACCEPTANCE_EVIDENCE_TYPES.has(evidence.type)) throw new Error('Acceptance evidence type is not allowed.'); }
    const note = payload.note?.trim(); if (payload.note !== undefined && !note) throw new Error('Acceptance note cannot be empty.');
    const satisfied = new Set(run.satisfiedCriteria); if (payload.outcome === 'SATISFIED') satisfied.add(criterion); else satisfied.delete(criterion);
    run.satisfiedCriteria = run.acceptanceCriteria.filter(value => satisfied.has(value));
  } else if (event.type === 'UsageRecorded') {
    requireWorkflowScopedEvent(event); requireSupervisor(run, event);
    validateUsagePayload(event.payload as UsageRecordedPayload);
    run.usage = applyUsageDelta(run.usage, event.payload as UsageRecordedPayload);
  } else if (event.type === 'ProgressRecorded') {
    requireWorkflowScopedEvent(event); requireSupervisor(run, event);
    const payload = validateProgressPayload(event.payload as ProgressRecordedPayload);
    for (const id of payload.evidenceEventIds ?? []) if (!snapshot.events.some(candidate => candidate.eventId === id)) throw new Error('Progress evidence must reference a prior event.');
    run.usage = applyProgress(run.usage, payload);
  } else if (event.type === 'PolicyEvaluated') {
    requireWorkflowScopedEvent(event); requireSupervisor(run, event);
    const payload = event.payload as CommitmentPolicyEvaluationPayload;
    if (payload?.scope !== 'commitment') throw new Error('Policy evaluation scope must be commitment.');
    const actual = evaluateCommitmentGate(snapshot, event.timestamp);
    if (!commitmentGateResultsEqual(payload.result, actual)) throw new Error('Policy evaluation does not match the current commitment gate.');
  } else if (event.type === 'CommitmentRequested') {
    requireWorkflowScopedEvent(event);
    if (!event.actorAgentId || !run.participantAgentIds.includes(event.actorAgentId)) throw new Error('Commitment requester must be a workflow participant.');
    if (commitment?.status === 'REQUESTED') throw new Error('A commitment request is already pending.');
    const payload = event.payload as CommitmentRequestedPayload; const commitmentId = payload?.commitmentId?.trim();
    if (!commitmentId) throw new Error('Commitment ID is required.');
    if (snapshot.events.some(candidate => candidate.type === 'CommitmentRequested' && (candidate.payload as CommitmentRequestedPayload)?.commitmentId?.trim() === commitmentId)) throw new Error('Commitment ID has already been used.');
    const previous = snapshot.events.at(-1); const previousPayload = previous?.payload as CommitmentPolicyEvaluationPayload | undefined;
    if (previous?.type !== 'PolicyEvaluated' || previousPayload?.scope !== 'commitment' || previousPayload.result?.allowed !== true) throw new Error('Commitment request requires an immediately preceding allowed policy evaluation.');
    const actual = evaluateCommitmentGate(snapshot, event.timestamp); if (!actual.allowed) throw new Error('Current commitment gate does not allow a request.');
    const summary = payload.summary?.trim(); if (payload.summary !== undefined && !summary) throw new Error('Commitment summary cannot be empty.');
    const evidenceRefs = validateRefs(payload.evidenceRefs, 'evidenceRefs');
    commitment = { commitmentId, status: 'REQUESTED', requestedByAgentId: event.actorAgentId, requestedAt: event.timestamp, ...(summary ? { summary } : {}), ...(evidenceRefs ? { evidenceRefs } : {}) };
  } else if (event.type === 'CommitmentAccepted') {
    requireWorkflowScopedEvent(event); requireSupervisor(run, event);
    const commitmentId = (event.payload as CommitmentAcceptedPayload)?.commitmentId?.trim();
    if (!commitment || commitment.status !== 'REQUESTED') throw new Error('No commitment request is pending.');
    if (!commitmentId || commitmentId !== commitment.commitmentId) throw new Error('Commitment ID does not match the pending request.');
    if (run.status !== 'RUNNING') throw new Error(`Workflow is not commit-ready: ${run.status}`);
    const actual = evaluateCommitmentGate(snapshot, event.timestamp); if (!actual.allowed) throw new Error('Current commitment gate does not allow acceptance.');
    commitment = { ...commitment, status: 'ACCEPTED', decidedByAgentId: event.actorAgentId, decidedAt: event.timestamp };
    run.status = 'RESOLVED'; delete run.statusReason;
  } else if (event.type === 'CommitmentRejected') {
    requireWorkflowScopedEvent(event); requireSupervisor(run, event);
    const payload = event.payload as CommitmentRejectedPayload; const commitmentId = payload?.commitmentId?.trim(); const reason = payload?.reason?.trim();
    if (!commitment || commitment.status !== 'REQUESTED') throw new Error('No commitment request is pending.');
    if (!commitmentId || commitmentId !== commitment.commitmentId) throw new Error('Commitment ID does not match the pending request.');
    if (!reason) throw new Error('Commitment rejection reason is required.');
    commitment = { ...commitment, status: 'REJECTED', decidedByAgentId: event.actorAgentId, decidedAt: event.timestamp, rejectionReason: reason };
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
    for (const session of Object.values(sessions)) cancelOpenPrincipals(decisions, quorums, session.sessionId, event.timestamp);
    if (commitment?.status === 'REQUESTED') commitment = { ...commitment, status: 'CANCELLED', decidedAt: event.timestamp };
  } else if (SESSION_SCOPED_EVENTS.has(event.type)) {
    requireExistingSession(sessions, event);
  }
  return { run, policy: snapshot.policy, sessions, tasks, decisions, quorums, evaluations, ...(commitment ? { commitment } : {}), events: [...snapshot.events, journalEvent] };
};
