import assert from 'node:assert/strict';
import test from 'node:test';
import { appendEvent, createWorkflow, evaluateRisk, findExhaustedBudget, validateCoordinationSnapshot } from '../services/coordination/index.ts';
import type { CoordinationPolicy, CoordinationSession, CoordinationTask } from '../services/coordination/index.ts';

const policy = (): CoordinationPolicy => ({
  policyId: 'safe', version: '1', schemaVersion: 1,
  budgets: { maxWallTimeMs: 1000, maxRounds: 3, maxLlmCalls: 10, maxInputTokens: 1000, maxOutputTokens: 1000, maxEstimatedCost: 1, maxConsecutiveErrors: 2, maxNoProgressCycles: 3 },
  riskRules: { read_local_data: 'ALLOW', purchase: 'DENY' },
  completionRules: { commitAuthority: 'supervisor', requireAllAcceptanceCriteria: true },
  schedulerRules: { sameModelConcurrency: 2 }, retryRules: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 },
});
const workflow = (p = policy()) => createWorkflow({ runId: 'run', roomId: 'room', goal: 'produce a reviewed answer', acceptanceCriteria: [' reviewed '], supervisorAgentId: 'supervisor', participantAgentIds: ['supervisor', 'worker', 'reviewer'], executionMode: 'supervised_autonomous', policy: p, now: 1 });
const event = (sequence: number, type: Parameters<typeof appendEvent>[1]['type'], payload: unknown = {}, extra = {}) => ({ eventId: `e${sequence}`, sequence, type, workflowRunId: 'run', timestamp: sequence, payload, ...extra });
const session = (overrides: Partial<CoordinationSession> = {}): CoordinationSession => ({ sessionId: 'task', workflowRunId: 'run', mode: 'map.coord.task.v1', participants: ['supervisor', 'worker', 'reviewer'], initiator: 'supervisor', supervisor: 'supervisor', state: 'OPEN', policyId: 'safe', policyVersion: '1', goal: 'draft', createdAt: 2, updatedAt: 2, ...overrides });
const task = (taskId = 't1', overrides: Partial<CoordinationTask> = {}): CoordinationTask => ({ taskId, workflowRunId: 'run', sessionId: 'task', title: 'Draft', goal: 'Draft answer', assigneeAgentId: 'worker', assignedByAgentId: 'supervisor', status: 'ASSIGNED', createdAt: 3, updatedAt: 3, ...overrides });
const start = (state = workflow(), value = session()) => appendEvent(state, event(state.events.length + 1, 'SessionStarted', value, { sessionId: value.sessionId, actorAgentId: 'supervisor' }));
const assign = (state = start(), value = task()) => appendEvent(state, event(state.events.length + 1, 'TaskAssigned', value, { sessionId: value.sessionId, actorAgentId: value.assignedByAgentId }));
const taskEvent = (state: ReturnType<typeof workflow>, type: 'TaskCompleted' | 'TaskFailed' | 'TaskCancelled', taskId: string, payload: object, actorAgentId = 'worker', sessionId = 'task') => appendEvent(state, event(state.events.length + 1, type, { taskId, ...payload }, { sessionId, actorAgentId }));

test('policy is bounded, cloned deeply, and unknown risk fails closed', () => {
  const source = policy(); const state = workflow(source); source.budgets.maxRounds = 999; (source.riskRules as Record<string, string>).read_local_data = 'DENY';
  assert.equal(state.policy.budgets.maxRounds, 3); assert.equal(state.policy.riskRules.read_local_data, 'ALLOW');
  assert.equal(state.run.acceptanceCriteria[0], 'reviewed'); assert.equal(evaluateRisk(policy(), 'unknown'), 'NEEDS_USER');
  assert.equal(findExhaustedBudget(policy().budgets, { rounds: 3, llmCalls: 0, inputTokens: 0, outputTokens: 0, estimatedCost: 0, consecutiveErrors: 0, noProgressCycles: 0 }, 0), 'maxRounds');
  const invalid = policy(); invalid.budgets.maxRounds = 0;
  assert.throws(() => workflow(invalid), /maxRounds/);
  assert.throws(() => createWorkflow({ runId: 'x', roomId: 'r', goal: 'g', acceptanceCriteria: [' ', 'x'], supervisorAgentId: 's', participantAgentIds: ['s'], executionMode: 'interactive', policy: policy() }), /cannot be empty/);
  assert.throws(() => createWorkflow({ runId: 'x', roomId: 'r', goal: 'g', acceptanceCriteria: ['x', ' x '], supervisorAgentId: 's', participantAgentIds: ['s'], executionMode: 'interactive', policy: policy() }), /duplicates/);
});

test('multiple active sessions are supported and resolved independently', () => {
  let state = start(); state = start(state, session({ sessionId: 'second', goal: 'review' }));
  assert.equal(state.sessions.task.state, 'OPEN'); assert.equal(state.sessions.second.state, 'OPEN');
  state = assign(state); state = taskEvent(state, 'TaskCompleted', 't1', { resultRef: 'artifact:1' });
  state = appendEvent(state, event(6, 'SessionResolved', { outcome: 'SUCCEEDED', evidenceRefs: ['artifact:1'] }, { sessionId: 'task', actorAgentId: 'supervisor' }));
  assert.equal(state.sessions.task.state, 'RESOLVED'); assert.equal(state.sessions.second.state, 'OPEN'); assert.equal(state.run.status, 'RUNNING');
});

test('failed session leaves workflow running and permits a retry session', () => {
  let state = assign(); state = taskEvent(state, 'TaskFailed', 't1', { failureReason: 'unavailable' });
  state = appendEvent(state, event(5, 'SessionResolved', { outcome: 'FAILED' }, { sessionId: 'task', actorAgentId: 'supervisor' }));
  state = start(state, session({ sessionId: 'retry' }));
  assert.equal(state.sessions.task.resolution?.outcome, 'FAILED'); assert.equal(state.sessions.retry.state, 'OPEN'); assert.equal(state.run.status, 'RUNNING');
});

test('task lifecycle enforces assignment and completion authority', () => {
  let state = assign(); assert.equal(state.tasks.t1.status, 'ASSIGNED');
  assert.throws(() => taskEvent(state, 'TaskCompleted', 't1', { resultRef: 'x' }, 'reviewer'), /assignee mismatch/);
  assert.throws(() => taskEvent(state, 'TaskCompleted', 't1', {}, 'worker'), /result or evidence/);
  state = taskEvent(state, 'TaskCompleted', 't1', { evidenceRefs: ['e:1'] });
  assert.equal(state.tasks.t1.status, 'COMPLETED'); assert.equal(state.run.status, 'RUNNING'); assert.equal(state.sessions.task.state, 'OPEN');
  assert.throws(() => taskEvent(state, 'TaskCancelled', 't1', {}, 'supervisor'), /not active/);
});

test('task failure supports assignee or supervisor and cancellation is supervisor-only', () => {
  let state = assign(); state = taskEvent(state, 'TaskFailed', 't1', { failureReason: 'bad' }); assert.equal(state.tasks.t1.status, 'FAILED');
  let bySupervisor = assign(undefined, task('t2')); bySupervisor = taskEvent(bySupervisor, 'TaskFailed', 't2', { failureReason: 'stopped' }, 'supervisor'); assert.equal(bySupervisor.tasks.t2.status, 'FAILED');
  const unrelated = assign(undefined, task('t3')); assert.throws(() => taskEvent(unrelated, 'TaskFailed', 't3', { failureReason: 'no' }, 'reviewer'), /assignee or supervisor/);
  assert.throws(() => taskEvent(unrelated, 'TaskCancelled', 't3', {}, 'worker'), /supervisor/);
  const cancelled = taskEvent(unrelated, 'TaskCancelled', 't3', {}, 'supervisor'); assert.equal(cancelled.tasks.t3.status, 'CANCELLED');
});

test('task events require task-mode open sessions and Persona participants', () => {
  for (const mode of ['map.coord.decision.v1', 'map.coord.quorum.v1'] as const) {
    const state = start(workflow(), session({ mode }));
    assert.throws(() => assign(state), /mode does not accept tasks/);
  }
  assert.throws(() => assign(start(), task('x', { assigneeAgentId: 'private-subagent' })), /Persona participant/);
  assert.throws(() => assign(start(), task('x', { assignedByAgentId: 'worker', inputRefs: ['', 'x'] })), /empty references/);
});

test('task session resolution gates terminal tasks and successful evidence', () => {
  let state = assign(); state = assign(state, task('t2'));
  state = taskEvent(state, 'TaskCompleted', 't1', { resultRef: 'a' });
  assert.throws(() => appendEvent(state, event(6, 'SessionResolved', { outcome: 'SUCCEEDED' }, { sessionId: 'task', actorAgentId: 'supervisor' })), /terminal/);
  state = taskEvent(state, 'TaskCompleted', 't2', { resultRef: 'b' });
  state = appendEvent(state, event(7, 'SessionResolved', { outcome: 'SUCCEEDED' }, { sessionId: 'task', actorAgentId: 'supervisor' }));
  assert.equal(state.sessions.task.resolution?.outcome, 'SUCCEEDED');

  let failed = assign(); failed = assign(failed, task('t2')); failed = taskEvent(failed, 'TaskFailed', 't1', { failureReason: 'x' }); failed = taskEvent(failed, 'TaskCancelled', 't2', {}, 'supervisor');
  assert.throws(() => appendEvent(failed, event(7, 'SessionResolved', { outcome: 'SUCCEEDED' }, { sessionId: 'task', actorAgentId: 'supervisor' })), /completed task/);
  failed = appendEvent(failed, event(7, 'SessionResolved', { outcome: 'FAILED' }, { sessionId: 'task', actorAgentId: 'supervisor' })); assert.equal(failed.sessions.task.state, 'RESOLVED');
});

test('session lifecycle is supervisor controlled', () => {
  let state = start();
  assert.throws(() => appendEvent(state, event(3, 'SessionSuspended', {}, { sessionId: 'task', actorAgentId: 'worker' })), /supervisor/);
  state = appendEvent(state, event(3, 'SessionSuspended', {}, { sessionId: 'task', actorAgentId: 'supervisor' })); assert.equal(state.sessions.task.state, 'SUSPENDED');
  assert.throws(() => assign(state), /not open/);
  state = appendEvent(state, event(4, 'SessionResumed', {}, { sessionId: 'task', actorAgentId: 'supervisor' })); assert.equal(state.sessions.task.state, 'OPEN');
  state = appendEvent(state, event(5, 'SessionExpired', {}, { sessionId: 'task', actorAgentId: 'supervisor' })); assert.equal(state.sessions.task.state, 'EXPIRED');
  assert.throws(() => appendEvent(state, event(6, 'SessionCancelled', {}, { sessionId: 'task', actorAgentId: 'supervisor' })), /terminal/);
});

test('workflow suspension and blocking propagate, and explicit user resume reopens sessions', () => {
  for (const type of ['WorkflowSuspended', 'WorkflowBlocked'] as const) {
    let state = start(); state = start(state, session({ sessionId: 'second' }));
    state = appendEvent(state, event(4, type, { reason: 'wait' }, { actorAgentId: 'supervisor' }));
    assert.equal(state.run.status, type === 'WorkflowBlocked' ? 'BLOCKED' : 'SUSPENDED'); assert.equal(state.sessions.task.state, 'SUSPENDED'); assert.equal(state.sessions.second.state, 'SUSPENDED');
    assert.throws(() => assign(state), /Workflow is stopped/);
    assert.throws(() => appendEvent(state, event(5, 'WorkflowResumed', {}, { actorAgentId: 'supervisor' })), /User authorization/);
    state = appendEvent(state, event(5, 'WorkflowResumed', { authorization: { type: 'user', reference: 'approval:1' } }, { actorAgentId: 'supervisor' }));
    assert.equal(state.run.status, 'RUNNING'); assert.equal(state.sessions.task.state, 'OPEN'); assert.equal(state.sessions.second.state, 'OPEN'); assert.equal(state.run.statusReason, undefined);
  }
});

test('resume fails closed for running workflows, invalid authorization, and non-supervisors', () => {
  assert.throws(() => appendEvent(workflow(), event(2, 'WorkflowResumed', { authorization: { type: 'user' } }, { actorAgentId: 'supervisor' })), /not stopped/);
  let state = appendEvent(workflow(), event(2, 'WorkflowSuspended', {}, { actorAgentId: 'supervisor' }));
  assert.throws(() => appendEvent(state, event(3, 'WorkflowResumed', { authorization: { type: 'system' } }, { actorAgentId: 'supervisor' })), /User authorization/);
  assert.throws(() => appendEvent(state, event(3, 'WorkflowResumed', { authorization: { type: 'user' } }, { actorAgentId: 'worker' })), /supervisor/);
});

test('workflow cancellation closes active sessions and tasks but preserves terminal tasks', () => {
  let state = assign(); state = assign(state, task('complete')); state = assign(state, task('failed')); state = assign(state, task('active'));
  state = taskEvent(state, 'TaskCompleted', 'complete', { resultRef: 'x' }); state = taskEvent(state, 'TaskFailed', 'failed', { failureReason: 'x' });
  state = appendEvent(state, event(9, 'WorkflowCancelled', {}, { actorAgentId: 'supervisor' }));
  assert.equal(state.sessions.task.state, 'CANCELLED'); assert.equal(state.tasks.active.status, 'CANCELLED'); assert.equal(state.tasks.complete.status, 'COMPLETED'); assert.equal(state.tasks.failed.status, 'FAILED');
});

test('journal ordering, semantic retries, collisions, and payload isolation are preserved', () => {
  const state = start(); const payload = task(); const assigned = event(3, 'TaskAssigned', payload, { sessionId: 'task', actorAgentId: 'supervisor', idempotencyKey: 'assign:1' });
  const recorded = appendEvent(state, assigned);
  assert.equal(appendEvent(recorded, { ...assigned, sequence: 4, timestamp: 99 }), recorded);
  assert.equal(appendEvent(recorded, { ...assigned, eventId: 'alternate', sequence: 4, timestamp: 99 }), recorded);
  payload.goal = 'MUTATED'; assert.equal((recorded.events.at(-1)?.payload as CoordinationTask).goal, 'Draft answer');
  assert.throws(() => appendEvent(recorded, { ...assigned, payload: { ...payload, goal: 'different' } }), /Event ID collision/);
  assert.throws(() => appendEvent(recorded, event(5, 'ErrorRecorded')), /sequence 4/);
});

test('legacy commitment authority and unresolved-session guard remain intact', () => {
  let state = start(); state = start(state, session({ sessionId: 'second' }));
  assert.throws(() => appendEvent(state, event(4, 'CommitmentAccepted', {}, { sessionId: 'task', actorAgentId: 'worker' })), /supervisor/);
  assert.throws(() => appendEvent(state, event(4, 'CommitmentAccepted', {}, { sessionId: 'task', actorAgentId: 'supervisor' })), /other sessions/);
});

test('terminal workflow and stopped workflow guards retain retry and audit behavior', () => {
  let state = start(); const cancellation = event(3, 'WorkflowCancelled', {}, { actorAgentId: 'supervisor' }); state = appendEvent(state, cancellation);
  assert.equal(appendEvent(state, cancellation), state); assert.throws(() => appendEvent(state, event(4, 'ErrorRecorded')), /already terminal/);
  let stopped = appendEvent(workflow(), event(2, 'WorkflowSuspended', {}, { actorAgentId: 'supervisor' })); stopped = appendEvent(stopped, event(3, 'ErrorRecorded', { message: 'waiting' })); assert.equal(stopped.run.status, 'SUSPENDED');
});

test('snapshot validation rejects broken cross-object invariants', () => {
  const base = assign(); validateCoordinationSnapshot(base);
  assert.throws(() => validateCoordinationSnapshot({ ...base, policy: { ...base.policy, version: '2' } }), /policy identity/);
  assert.throws(() => validateCoordinationSnapshot({ ...base, tasks: { t1: { ...base.tasks.t1, sessionId: 'missing' } } }), /missing session/);
  assert.throws(() => validateCoordinationSnapshot({ ...base, sessions: { task: { ...base.sessions.task, mode: 'map.coord.decision.v1' } } }), /task mode/);
  assert.throws(() => validateCoordinationSnapshot({ ...base, tasks: { t1: { ...base.tasks.t1, assigneeAgentId: 'outsider' } } }), /session participant/);
  assert.throws(() => validateCoordinationSnapshot({ ...base, run: { ...base.run, status: 'CANCELLED' } }), /active session/);
  const noActiveSession = { ...base, run: { ...base.run, status: 'CANCELLED' as const }, sessions: { task: { ...base.sessions.task, state: 'CANCELLED' as const } } };
  assert.throws(() => validateCoordinationSnapshot(noActiveSession), /active task/);
});
