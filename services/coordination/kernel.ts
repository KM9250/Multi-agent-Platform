import type { CoordinationEvent, CoordinationPolicy, CoordinationSession, CoordinationSnapshot, WorkflowRun } from './types';
import { validatePolicy } from './policy';

const emptyUsage = () => ({ rounds: 0, llmCalls: 0, inputTokens: 0, outputTokens: 0, estimatedCost: 0, consecutiveErrors: 0, noProgressCycles: 0 });

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
  if (snapshot.events.some(existing => existing.eventId === event.eventId || (event.idempotencyKey && existing.idempotencyKey === event.idempotencyKey))) return snapshot;
  const expected = snapshot.events.length ? snapshot.events.at(-1)!.sequence + 1 : 1;
  if (event.sequence !== expected) throw new Error(`Expected event sequence ${expected}.`);
  const run = { ...snapshot.run, updatedAt: event.timestamp };
  const sessions = { ...snapshot.sessions };

  if (event.type === 'SessionStarted') {
    const session = event.payload as CoordinationSession;
    if (session.policyId !== run.policyId || session.policyVersion !== run.policyVersion) throw new Error('Session policy must match the workflow policy.');
    if (session.participants.some(id => !run.participantAgentIds.includes(id))) throw new Error('Only workflow Persona participants may join a session.');
    sessions[session.sessionId] = { ...session, participants: [...session.participants] };
    run.currentSessionId = session.sessionId;
  } else if (event.type === 'WorkflowSuspended') {
    run.status = 'SUSPENDED'; run.statusReason = String((event.payload as { reason?: string }).reason || 'NEEDS_USER');
  } else if (event.type === 'WorkflowCancelled') {
    run.status = 'CANCELLED';
    for (const session of Object.values(sessions)) if (session.state === 'OPEN' || session.state === 'SUSPENDED') sessions[session.sessionId] = { ...session, state: 'CANCELLED', updatedAt: event.timestamp };
  } else if (event.type === 'CommitmentAccepted') {
    if (event.actorAgentId !== run.supervisorAgentId) throw new Error('Only the configured supervisor may accept a commitment.');
    run.status = 'RESOLVED'; delete run.statusReason;
    if (event.sessionId && sessions[event.sessionId]) sessions[event.sessionId] = { ...sessions[event.sessionId], state: 'RESOLVED', updatedAt: event.timestamp };
  }
  // Deliberately, TaskCompleted never transitions a Session or Workflow to RESOLVED.
  return { run, sessions, events: [...snapshot.events, event] };
};
