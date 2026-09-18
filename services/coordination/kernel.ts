import type { CoordinationEvent, CoordinationEventType, CoordinationPolicy, CoordinationSession, CoordinationSnapshot, WorkflowRun, WorkflowStatus } from './types';
import { validatePolicy } from './policy';

const emptyUsage = () => ({ rounds: 0, llmCalls: 0, inputTokens: 0, outputTokens: 0, estimatedCost: 0, consecutiveErrors: 0, noProgressCycles: 0 });

// BLOCKED is intentionally non-terminal because a future explicit user action may resume it.
// This foundation rejects every new event after the irreversible terminal states below.
const TERMINAL_WORKFLOW_STATUSES = new Set<WorkflowStatus>(['RESOLVED', 'CANCELLED', 'FAILED']);
const SESSION_SCOPED_EVENTS = new Set<CoordinationEventType>([
  'TaskAssigned', 'TaskCompleted', 'EvaluationAdded', 'PolicyEvaluated',
  'CommitmentRequested', 'CommitmentAccepted',
]);

const stableSerialize = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`).join(',')}}`;
};

const isSameSemanticEvent = (left: CoordinationEvent, right: CoordinationEvent): boolean =>
  left.type === right.type
  && left.workflowRunId === right.workflowRunId
  && left.sessionId === right.sessionId
  && left.actorAgentId === right.actorAgentId
  && stableSerialize(left.payload) === stableSerialize(right.payload);

const requireExistingSession = (
  sessions: Record<string, CoordinationSession>,
  event: CoordinationEvent,
): CoordinationSession => {
  if (!event.sessionId) throw new Error(`${event.type} requires a sessionId.`);
  const session = sessions[event.sessionId];
  if (!session) throw new Error(`Session does not exist: ${event.sessionId}`);
  return session;
};

export interface CreateWorkflowInput {
  runId: string; roomId: string; goal: string; acceptanceCriteria: string[];
  supervisorAgentId: string; participantAgentIds: string[];
  executionMode: WorkflowRun['executionMode']; policy: CoordinationPolicy; now?: number;
}

export const createWorkflow = (input: CreateWorkflowInput): CoordinationSnapshot => {
  validatePolicy(input.policy);
  if (!input.participantAgentIds.includes(input.supervisorAgentId)) throw new Error('Supervisor must be a Persona participant.');
  if (!input.goal.trim()) throw new Error('Workflow goal is required.');
  const now = input.now ?? Date.now();
  const run: WorkflowRun = {
    runId: input.runId, roomId: input.roomId, goal: input.goal,
    acceptanceCriteria: [...input.acceptanceCriteria], satisfiedCriteria: [],
    supervisorAgentId: input.supervisorAgentId, participantAgentIds: [...new Set(input.participantAgentIds)],
    executionMode: input.executionMode, policyId: input.policy.policyId, policyVersion: input.policy.version,
    status: 'RUNNING', budget: { ...input.policy.budgets }, usage: emptyUsage(), createdAt: now, updatedAt: now,
  };
  return appendEvent({ run, sessions: {}, events: [] }, {
    eventId: `${input.runId}:created`, sequence: 1, type: 'WorkflowRunCreated', workflowRunId: input.runId,
    actorAgentId: input.supervisorAgentId, timestamp: now, payload: { goal: input.goal },
  });
};

/** Append-only journal insertion with sequence and idempotency enforcement. */
export const appendEvent = (snapshot: CoordinationSnapshot, event: CoordinationEvent): CoordinationSnapshot => {
  if (event.workflowRunId !== snapshot.run.runId) throw new Error('Event belongs to another workflow.');
  if (snapshot.events.some(existing => existing.eventId === event.eventId)) return snapshot;
  if (event.idempotencyKey) {
    const existing = snapshot.events.find(candidate => candidate.idempotencyKey === event.idempotencyKey);
    if (existing) {
      if (isSameSemanticEvent(existing, event)) return snapshot;
      throw new Error('Idempotency key collision.');
    }
  }
  if (TERMINAL_WORKFLOW_STATUSES.has(snapshot.run.status)) {
    throw new Error(`Workflow is already terminal: ${snapshot.run.status}`);
  }
  const expected = snapshot.events.length ? snapshot.events.at(-1)!.sequence + 1 : 1;
  if (event.sequence !== expected) throw new Error(`Expected event sequence ${expected}.`);
  const run = { ...snapshot.run, updatedAt: event.timestamp };
  const sessions = { ...snapshot.sessions };

  if (event.type === 'SessionStarted') {
    const session = event.payload as CoordinationSession;
    if (!session || typeof session !== 'object') throw new Error('SessionStarted requires a session payload.');
    if (!session.sessionId.trim()) throw new Error('Session ID is required.');
    if (sessions[session.sessionId]) throw new Error(`Duplicate session ID: ${session.sessionId}`);
    if (event.sessionId && event.sessionId !== session.sessionId) throw new Error('Event and payload session IDs must match.');
    if (session.workflowRunId !== run.runId) throw new Error('Session belongs to another workflow.');
    if (session.policyId !== run.policyId || session.policyVersion !== run.policyVersion) throw new Error('Session policy must match the workflow policy.');
    if (session.supervisor !== run.supervisorAgentId) throw new Error('Session supervisor must match the workflow supervisor.');
    if (session.state !== 'OPEN') throw new Error('A new session must be OPEN.');
    if (!session.goal.trim()) throw new Error('Session goal is required.');
    if (session.participants.length === 0) throw new Error('Session must have at least one participant.');
    if (session.participants.some(id => !run.participantAgentIds.includes(id))) throw new Error('Only workflow Persona participants may join a session.');
    if (!run.participantAgentIds.includes(session.initiator)) throw new Error('Session initiator must be a workflow participant.');
    if (!session.participants.includes(run.supervisorAgentId)) throw new Error('Session participants must include the supervisor.');
    sessions[session.sessionId] = { ...session, participants: [...session.participants] };
    run.currentSessionId = session.sessionId;
  } else if (event.type === 'WorkflowSuspended') {
    run.status = 'SUSPENDED'; run.statusReason = String((event.payload as { reason?: string }).reason || 'NEEDS_USER');
  } else if (event.type === 'WorkflowCancelled') {
    run.status = 'CANCELLED';
    for (const session of Object.values(sessions)) if (session.state === 'OPEN' || session.state === 'SUSPENDED') sessions[session.sessionId] = { ...session, state: 'CANCELLED', updatedAt: event.timestamp };
  } else if (event.type === 'CommitmentAccepted') {
    if (event.actorAgentId !== run.supervisorAgentId) throw new Error('Only the configured supervisor may accept a commitment.');
    if (run.status !== 'RUNNING') throw new Error(`Workflow is not commit-ready: ${run.status}`);
    const session = requireExistingSession(sessions, event);
    if (session.state !== 'OPEN') throw new Error(`Session is not commit-ready: ${session.state}`);
    if (session.supervisor !== run.supervisorAgentId) throw new Error('Session supervisor must match the workflow supervisor.');
    if (session.workflowRunId !== run.runId) throw new Error('Session belongs to another workflow.');
    run.status = 'RESOLVED'; delete run.statusReason;
    sessions[event.sessionId!] = { ...session, state: 'RESOLVED', updatedAt: event.timestamp };
  } else if (SESSION_SCOPED_EVENTS.has(event.type)) {
    requireExistingSession(sessions, event);
  }
  // Deliberately, TaskCompleted never transitions a Session or Workflow to RESOLVED.
  return { run, sessions, events: [...snapshot.events, event] };
};
