import assert from 'node:assert/strict';
import test from 'node:test';
import { appendEvent, createWorkflow, evaluateQuorumOutcome, requiredQuorumApprovals, validateCoordinationSnapshot } from '../services/coordination/index.ts';
import type { CoordinationDecision, CoordinationPolicy, CoordinationQuorum, CoordinationSession, CoordinationTask } from '../services/coordination/index.ts';

const policy: CoordinationPolicy = { policyId: 'p', version: '1', schemaVersion: 1, budgets: { maxWallTimeMs: 1, maxRounds: 1, maxLlmCalls: 1, maxInputTokens: 1, maxOutputTokens: 1, maxEstimatedCost: 1, maxConsecutiveErrors: 1, maxNoProgressCycles: 1 }, riskRules: {}, completionRules: { commitAuthority: 'supervisor', requireAllAcceptanceCriteria: true }, schedulerRules: { sameModelConcurrency: 1 }, retryRules: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 } };
const fresh = () => createWorkflow({ runId: 'r', roomId: 'room', goal: 'goal', acceptanceCriteria: [], supervisorAgentId: 'supervisor', participantAgentIds: ['supervisor', 'a', 'b', 'c', 'd'], executionMode: 'interactive', policy, now: 0 });
const ev = (state: ReturnType<typeof fresh>, type: Parameters<typeof appendEvent>[1]['type'], payload: unknown, sessionId?: string, actorAgentId = 'supervisor') => ({ eventId: `e${state.events.length + 1}`, sequence: state.events.length + 1, type, workflowRunId: 'r', sessionId, actorAgentId, timestamp: state.events.length + 1, payload });
const openSession = (state: ReturnType<typeof fresh>, id: string, mode: CoordinationSession['mode']) => appendEvent(state, ev(state, 'SessionStarted', { sessionId: id, workflowRunId: 'r', mode, participants: ['supervisor', 'a', 'b', 'c', 'd'], initiator: 'supervisor', supervisor: 'supervisor', state: 'OPEN', policyId: 'p', policyVersion: '1', goal: id, createdAt: 1, updatedAt: 1 } satisfies CoordinationSession, id));
const decision = (overrides: Partial<CoordinationDecision> = {}): CoordinationDecision => ({ decisionId: 'd1', workflowRunId: 'r', sessionId: 'dec', question: ' A or B? ', authorityAgentId: 'a', options: [' A ', 'B'], status: 'OPEN', createdAt: 2, updatedAt: 2, ...overrides });
const quorum = (overrides: Partial<CoordinationQuorum> = {}): CoordinationQuorum => ({ quorumId: 'q1', workflowRunId: 'r', sessionId: 'quo', question: 'Ship?', eligibleAgentIds: ['a', 'b', 'c'], threshold: { kind: 'majority' }, votes: {}, status: 'OPEN', createdAt: 2, updatedAt: 2, ...overrides });

test('decision authority, options, evidence, cancellation, and session gates', () => {
  let state = openSession(fresh(), 'dec', 'map.coord.decision.v1');
  assert.throws(() => appendEvent(state, ev(state, 'DecisionOpened', decision(), 'dec', 'a')), /supervisor/);
  state = appendEvent(state, ev(state, 'DecisionOpened', decision(), 'dec'));
  assert.deepEqual(state.decisions.d1.options, ['A', 'B']);
  assert.throws(() => appendEvent(state, ev(state, 'DecisionResolved', { decisionId: 'd1', value: 'A' }, 'dec')), /authority mismatch/);
  assert.throws(() => appendEvent(state, ev(state, 'DecisionResolved', { decisionId: 'd1', value: 'C' }, 'dec', 'a')), /configured option/);
  assert.throws(() => appendEvent(state, ev(state, 'SessionResolved', { outcome: 'SUCCEEDED' }, 'dec')), /terminal/);
  state = appendEvent(state, ev(state, 'DecisionResolved', { decisionId: 'd1', value: ' A ', rationaleRef: ' why ', evidenceRefs: [' proof '] }, 'dec', 'a'));
  assert.deepEqual(state.decisions.d1, { ...state.decisions.d1, value: 'A', rationaleRef: 'why', evidenceRefs: ['proof'] });
  assert.throws(() => appendEvent(state, ev(state, 'DecisionCancelled', { decisionId: 'd1' }, 'dec')), /not open/);
  state = appendEvent(state, ev(state, 'SessionResolved', { outcome: 'SUCCEEDED' }, 'dec'));
  assert.equal(state.sessions.dec.state, 'RESOLVED');

  let cancelled = openSession(fresh(), 'dec', 'map.coord.decision.v1');
  cancelled = appendEvent(cancelled, ev(cancelled, 'DecisionOpened', decision(), 'dec'));
  cancelled = appendEvent(cancelled, ev(cancelled, 'DecisionCancelled', { decisionId: 'd1' }, 'dec'));
  assert.throws(() => appendEvent(cancelled, ev(cancelled, 'SessionResolved', { outcome: 'SUCCEEDED' }, 'dec')), /resolved decision/);
  cancelled = appendEvent(cancelled, ev(cancelled, 'SessionResolved', { outcome: 'FAILED' }, 'dec'));
  assert.equal(cancelled.sessions.dec.resolution?.outcome, 'FAILED');
});

test('quorum thresholds, revisions, deterministic resolution, and journal isolation', () => {
  for (const [threshold, count] of [[{ kind: 'all' }, 4], [{ kind: 'majority' }, 3], [{ kind: 'count', count: 1 }, 1], [{ kind: 'count', count: 4 }, 4]] as const) assert.equal(evaluateQuorumOutcome(quorum({ eligibleAgentIds: ['a', 'b', 'c', 'd'], threshold })).requiredApprovals, count);
  for (const threshold of [{ kind: 'count', count: 0 }, { kind: 'count', count: 4 }, { kind: 'count', count: 1.5 }] as const) assert.throws(() => evaluateQuorumOutcome(quorum({ threshold })), /threshold/);
  let state = openSession(fresh(), 'quo', 'map.coord.quorum.v1'); const payload = quorum();
  state = appendEvent(state, ev(state, 'QuorumOpened', payload, 'quo')); payload.eligibleAgentIds.push('d'); assert.deepEqual((state.events.at(-1)!.payload as CoordinationQuorum).eligibleAgentIds, ['a', 'b', 'c']);
  assert.throws(() => appendEvent(state, ev(state, 'QuorumVoteCast', { quorumId: 'q1', vote: 'APPROVE' }, 'quo', 'd')), /not eligible/);
  state = appendEvent(state, ev(state, 'QuorumVoteCast', { quorumId: 'q1', vote: 'REJECT' }, 'quo', 'a'));
  state = appendEvent(state, ev(state, 'QuorumVoteCast', { quorumId: 'q1', vote: 'APPROVE' }, 'quo', 'a'));
  state = appendEvent(state, ev(state, 'QuorumVoteCast', { quorumId: 'q1', vote: 'APPROVE' }, 'quo', 'b'));
  assert.equal(state.quorums.q1.votes.a, 'APPROVE'); assert.equal(state.events.filter(e => e.type === 'QuorumVoteCast').length, 3);
  assert.equal(evaluateQuorumOutcome(state.quorums.q1).state, 'APPROVED');
  assert.throws(() => appendEvent(state, ev(state, 'QuorumResolved', { quorumId: 'q1', outcome: 'REJECTED' }, 'quo')), /does not match/);
  state = appendEvent(state, ev(state, 'QuorumResolved', { quorumId: 'q1', outcome: 'APPROVED' }, 'quo'));
  state = appendEvent(state, ev(state, 'SessionResolved', { outcome: 'SUCCEEDED' }, 'quo')); assert.equal(state.sessions.quo.state, 'RESOLVED');
});

test('rejection waits for every eligible voter and failed quorum sessions resolve', () => {
  let state = openSession(fresh(), 'quo', 'map.coord.quorum.v1'); state = appendEvent(state, ev(state, 'QuorumOpened', quorum({ threshold: { kind: 'all' } }), 'quo'));
  state = appendEvent(state, ev(state, 'QuorumVoteCast', { quorumId: 'q1', vote: 'REJECT' }, 'quo', 'a')); state = appendEvent(state, ev(state, 'QuorumVoteCast', { quorumId: 'q1', vote: 'APPROVE' }, 'quo', 'b'));
  assert.equal(evaluateQuorumOutcome(state.quorums.q1).state, 'PENDING'); assert.throws(() => appendEvent(state, ev(state, 'QuorumResolved', { quorumId: 'q1', outcome: 'REJECTED' }, 'quo')), /pending/);
  state = appendEvent(state, ev(state, 'QuorumVoteCast', { quorumId: 'q1', vote: 'ABSTAIN' }, 'quo', 'c')); assert.equal(evaluateQuorumOutcome(state.quorums.q1).state, 'REJECTED');
  state = appendEvent(state, ev(state, 'QuorumResolved', { quorumId: 'q1', outcome: 'REJECTED' }, 'quo')); assert.throws(() => appendEvent(state, ev(state, 'SessionResolved', { outcome: 'SUCCEEDED' }, 'quo')), /approved quorum/);
  state = appendEvent(state, ev(state, 'SessionResolved', { outcome: 'FAILED' }, 'quo')); assert.equal(state.sessions.quo.state, 'RESOLVED');
});

test('evaluations are advisory and cancellation propagates to new principals', () => {
  let state = openSession(fresh(), 'dec', 'map.coord.decision.v1'); state = appendEvent(state, ev(state, 'DecisionOpened', decision(), 'dec'));
  state = appendEvent(state, ev(state, 'EvaluationAdded', { evaluationId: 'e1', workflowRunId: 'r', sessionId: 'dec', evaluatorAgentId: 'b', target: { type: 'decision', id: 'd1' }, outcome: 'PASS', summary: ' good ', evidenceRefs: [' ref '] }, 'dec', 'b'));
  assert.equal(state.decisions.d1.status, 'OPEN'); assert.equal(state.sessions.dec.state, 'OPEN'); assert.equal(state.run.status, 'RUNNING'); assert.equal(state.evaluations.e1.summary, 'good');
  assert.throws(() => appendEvent(state, ev(state, 'EvaluationAdded', { evaluationId: 'e2', workflowRunId: 'r', sessionId: 'dec', evaluatorAgentId: 'a', target: { type: 'decision', id: 'missing' }, outcome: 'PASS' }, 'dec', 'a')), /target does not exist/);
  state = appendEvent(state, ev(state, 'SessionExpired', {}, 'dec')); assert.equal(state.decisions.d1.status, 'CANCELLED');
  validateCoordinationSnapshot(state);
});

test('workflow cancellation closes decisions and quorums while suspension preserves them', () => {
  let state = openSession(fresh(), 'dec', 'map.coord.decision.v1'); state = appendEvent(state, ev(state, 'DecisionOpened', decision(), 'dec')); state = openSession(state, 'quo', 'map.coord.quorum.v1'); state = appendEvent(state, ev(state, 'QuorumOpened', quorum(), 'quo'));
  let stopped = appendEvent(state, ev(state, 'WorkflowSuspended', {}, undefined)); assert.equal(stopped.decisions.d1.status, 'OPEN'); assert.equal(stopped.quorums.q1.status, 'OPEN'); assert.throws(() => appendEvent(stopped, ev(stopped, 'QuorumVoteCast', { quorumId: 'q1', vote: 'APPROVE' }, 'quo', 'a')), /stopped/);
  stopped = appendEvent(stopped, ev(stopped, 'WorkflowResumed', { authorization: { type: 'user' } }, undefined)); stopped = appendEvent(stopped, ev(stopped, 'QuorumVoteCast', { quorumId: 'q1', vote: 'APPROVE' }, 'quo', 'a')); assert.equal(stopped.quorums.q1.votes.a, 'APPROVE');
  state = appendEvent(state, ev(state, 'WorkflowCancelled', {}, undefined)); assert.equal(state.decisions.d1.status, 'CANCELLED'); assert.equal(state.quorums.q1.status, 'CANCELLED');
});

test('quorum thresholds fail closed at helper and event boundaries', () => {
  assert.throws(() => requiredQuorumApprovals({ kind: 'unknown', count: 1 } as never, 3), /Unknown quorum threshold kind/);
  for (const eligibleCount of [0, -1, 1.5]) {
    assert.throws(() => requiredQuorumApprovals({ kind: 'all' }, eligibleCount), /eligible count/);
  }
  assert.throws(() => evaluateQuorumOutcome(quorum({ eligibleAgentIds: [] })), /eligible count/);

  const state = openSession(fresh(), 'quo', 'map.coord.quorum.v1');
  assert.throws(
    () => appendEvent(state, ev(state, 'QuorumOpened', quorum({ threshold: { kind: 'unknown', count: 1 } as never }), 'quo')),
    /Unknown quorum threshold kind/,
  );
});

test('principal opening rejects wrong modes, duplicate IDs, and invalid participants', () => {
  const taskState = openSession(fresh(), 'task', 'map.coord.task.v1');
  assert.throws(() => appendEvent(taskState, ev(taskState, 'DecisionOpened', decision({ sessionId: 'task' }), 'task')), /does not accept decisions/);
  assert.throws(() => appendEvent(taskState, ev(taskState, 'QuorumOpened', quorum({ sessionId: 'task' }), 'task')), /does not accept quorums/);

  let decisions = openSession(fresh(), 'dec', 'map.coord.decision.v1');
  assert.throws(() => appendEvent(decisions, ev(decisions, 'DecisionOpened', decision({ authorityAgentId: 'outsider' }), 'dec')), /Persona participant/);
  decisions = appendEvent(decisions, ev(decisions, 'DecisionOpened', decision(), 'dec'));
  assert.throws(() => appendEvent(decisions, ev(decisions, 'DecisionOpened', decision(), 'dec')), /Duplicate decision ID/);

  const quorums = openSession(fresh(), 'quo', 'map.coord.quorum.v1');
  assert.throws(() => appendEvent(quorums, ev(quorums, 'QuorumOpened', quorum({ eligibleAgentIds: ['a', 'a'] }), 'quo')), /unique/);
  assert.throws(() => appendEvent(quorums, ev(quorums, 'QuorumOpened', quorum({ eligibleAgentIds: ['a', 'outsider'] }), 'quo')), /Persona participant/);
});

test('quorum terminal actions remain supervisor-only', () => {
  let resolvable = openSession(fresh(), 'quo', 'map.coord.quorum.v1');
  resolvable = appendEvent(resolvable, ev(resolvable, 'QuorumOpened', quorum({ eligibleAgentIds: ['a'], threshold: { kind: 'all' } }), 'quo'));
  resolvable = appendEvent(resolvable, ev(resolvable, 'QuorumVoteCast', { quorumId: 'q1', vote: 'APPROVE' }, 'quo', 'a'));
  assert.throws(() => appendEvent(resolvable, ev(resolvable, 'QuorumResolved', { quorumId: 'q1', outcome: 'APPROVED' }, 'quo', 'a')), /supervisor/);

  let cancellable = openSession(fresh(), 'quo', 'map.coord.quorum.v1');
  cancellable = appendEvent(cancellable, ev(cancellable, 'QuorumOpened', quorum(), 'quo'));
  assert.throws(() => appendEvent(cancellable, ev(cancellable, 'QuorumCancelled', { quorumId: 'q1' }, 'quo', 'a')), /supervisor/);
});

test('evaluation event validation rejects invalid actors, participants, targets, and artifacts', () => {
  let state = openSession(fresh(), 'dec', 'map.coord.decision.v1');
  state = appendEvent(state, ev(state, 'DecisionOpened', decision(), 'dec'));
  const evaluation = { evaluationId: 'eval', workflowRunId: 'r', sessionId: 'dec', evaluatorAgentId: 'a', target: { type: 'decision', id: 'd1' }, outcome: 'PASS' };
  assert.throws(() => appendEvent(state, ev(state, 'EvaluationAdded', evaluation, 'dec', 'b')), /actor must match/);
  assert.throws(() => appendEvent(state, ev(state, 'EvaluationAdded', { ...evaluation, evaluatorAgentId: 'outsider' }, 'dec', 'outsider')), /session participant/);
  assert.throws(() => appendEvent(state, ev(state, 'EvaluationAdded', { ...evaluation, target: { type: 'artifact', ref: ' ' } }, 'dec', 'a')), /artifact reference/);

  state = openSession(state, 'other', 'map.coord.decision.v1');
  assert.throws(() => appendEvent(state, ev(state, 'EvaluationAdded', { ...evaluation, sessionId: 'other' }, 'other', 'a')), /another session/);
});

test('snapshot validation rejects unknown evaluation values and malformed quorum questions', () => {
  let state = openSession(fresh(), 'quo', 'map.coord.quorum.v1');
  state = appendEvent(state, ev(state, 'QuorumOpened', quorum(), 'quo'));
  state = appendEvent(state, ev(state, 'EvaluationAdded', { evaluationId: 'eval', workflowRunId: 'r', sessionId: 'quo', evaluatorAgentId: 'a', target: { type: 'quorum', id: 'q1' }, outcome: 'PASS' }, 'quo', 'a'));

  assert.throws(() => validateCoordinationSnapshot({ ...state, quorums: { q1: { ...state.quorums.q1, question: '   ' } } }), /question/);
  assert.throws(() => validateCoordinationSnapshot({ ...state, evaluations: { eval: { ...state.evaluations.eval, outcome: 'UNKNOWN' as never } } }), /outcome/);
  assert.throws(
    () => validateCoordinationSnapshot({ ...state, evaluations: { eval: { ...state.evaluations.eval, target: { type: 'unknown', id: 'q1' } as never } } }),
    /target type/,
  );
});

test('snapshot validation replays mode-specific successful session gates', () => {
  const resolvedSession = (state: ReturnType<typeof fresh>, sessionId: string) => ({
    ...state.sessions[sessionId], state: 'RESOLVED' as const, resolution: { outcome: 'SUCCEEDED' as const },
  });

  const taskState = openSession(fresh(), 'task', 'map.coord.task.v1');
  const cancelledTask: CoordinationTask = { taskId: 't1', workflowRunId: 'r', sessionId: 'task', title: 'Task', goal: 'work', assigneeAgentId: 'a', assignedByAgentId: 'supervisor', status: 'CANCELLED', createdAt: 2, updatedAt: 2 };
  assert.throws(
    () => validateCoordinationSnapshot({ ...taskState, sessions: { task: resolvedSession(taskState, 'task') }, tasks: { t1: cancelledTask } }),
    /completed task/,
  );

  let decisionState = openSession(fresh(), 'dec', 'map.coord.decision.v1');
  decisionState = appendEvent(decisionState, ev(decisionState, 'DecisionOpened', decision(), 'dec'));
  decisionState = appendEvent(decisionState, ev(decisionState, 'DecisionCancelled', { decisionId: 'd1' }, 'dec'));
  decisionState = appendEvent(decisionState, ev(decisionState, 'SessionResolved', { outcome: 'FAILED' }, 'dec'));
  validateCoordinationSnapshot(decisionState);
  assert.throws(
    () => validateCoordinationSnapshot({ ...decisionState, sessions: { dec: { ...decisionState.sessions.dec, resolution: { outcome: 'SUCCEEDED' } } } }),
    /resolved decision/,
  );

  let quorumState = openSession(fresh(), 'quo', 'map.coord.quorum.v1');
  quorumState = appendEvent(quorumState, ev(quorumState, 'QuorumOpened', quorum({ eligibleAgentIds: ['a'], threshold: { kind: 'all' } }), 'quo'));
  quorumState = appendEvent(quorumState, ev(quorumState, 'QuorumVoteCast', { quorumId: 'q1', vote: 'REJECT' }, 'quo', 'a'));
  quorumState = appendEvent(quorumState, ev(quorumState, 'QuorumResolved', { quorumId: 'q1', outcome: 'REJECTED' }, 'quo'));
  quorumState = appendEvent(quorumState, ev(quorumState, 'SessionResolved', { outcome: 'FAILED' }, 'quo'));
  validateCoordinationSnapshot(quorumState);
  assert.throws(
    () => validateCoordinationSnapshot({ ...quorumState, sessions: { quo: { ...quorumState.sessions.quo, resolution: { outcome: 'SUCCEEDED' } } } }),
    /approved quorum/,
  );
});

test('snapshot validation enforces decision terminal fields and principal status allowlists', () => {
  let decisionState = openSession(fresh(), 'dec', 'map.coord.decision.v1');
  decisionState = appendEvent(decisionState, ev(decisionState, 'DecisionOpened', decision(), 'dec'));
  const openDecision = decisionState.decisions.d1;
  assert.throws(() => validateCoordinationSnapshot({ ...decisionState, decisions: { d1: { ...openDecision, evidenceRefs: ['proof'] } } }), /terminal result fields/);
  assert.throws(() => validateCoordinationSnapshot({ ...decisionState, decisions: { d1: { ...openDecision, status: 'UNKNOWN' as never } } }), /Decision status/);

  decisionState = appendEvent(decisionState, ev(decisionState, 'DecisionCancelled', { decisionId: 'd1' }, 'dec'));
  for (const result of [{ value: 'A' }, { rationaleRef: 'why' }, { evidenceRefs: ['proof'] }]) {
    assert.throws(
      () => validateCoordinationSnapshot({ ...decisionState, decisions: { d1: { ...decisionState.decisions.d1, ...result } } }),
      /Cancelled decision cannot contain terminal result fields/,
    );
  }

  let quorumState = openSession(fresh(), 'quo', 'map.coord.quorum.v1');
  quorumState = appendEvent(quorumState, ev(quorumState, 'QuorumOpened', quorum(), 'quo'));
  assert.throws(() => validateCoordinationSnapshot({ ...quorumState, quorums: { q1: { ...quorumState.quorums.q1, status: 'UNKNOWN' as never } } }), /Quorum status/);
});
