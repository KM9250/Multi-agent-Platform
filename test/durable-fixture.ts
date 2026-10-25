import { waitForLeaseAvailability } from './lease-fixture.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { TestContext } from 'node:test';
import { DurableDatabase, SqliteCoordinationRunnerStore, createRuntimeLeaseManager } from '../services/coordination/durable/index.ts';
import { appendEvent, evaluateCommitmentGate } from '../services/coordination/index.ts';
import type { CoordinationEvent, CoordinationEventType, CoordinationSession, CoordinationSnapshot } from '../services/coordination/types.ts';
import { fresh, event } from './notification-fixture.ts';
export { fresh, event };
export function fixture(t: TestContext, seed = fresh()) {
  const dir = mkdtempSync(join(tmpdir(), 'map-durable-')), path = join(dir, 'journal.sqlite');
  const connections: { close(): void }[] = [];
  t.after(() => { for (const c of connections.reverse()) c.close(); rmSync(dir, { recursive: true, force: true }); });
  let lease: import('../services/coordination/durable/runtimeLease.ts').WorkflowLease | undefined;
  const open = () => { const db = new DurableDatabase({ path }); connections.push(db); return { db, store: new SqliteCoordinationRunnerStore(db, lease) }; };
  const raw = () => { const db = new DatabaseSync(path); connections.push(db); return db; };
  const current = open(); current.store.createWorkflow(seed);
  const manager = createRuntimeLeaseManager(current.db);
  lease = manager.acquire(seed.run.runId);
  current.store = current.store.withLease(lease);
  const release = () => manager.release(lease!);
  const acquire = (db = current.db) => { lease = createRuntimeLeaseManager(db).acquire(seed.run.runId); return lease; };
  const openOwned = async () => {
    await waitForLeaseAvailability(path);
    const connection = open();
    connection.store = connection.store.withLease(acquire(connection.db));
    return connection;
  };
  return { dir, path, open, openOwned, raw, manager, lease, release, acquire, ...current };
}
export function history(seed = fresh()): CoordinationSnapshot {
  let s = seed;
  const add = (type: CoordinationEventType, payload: unknown, sessionId?: string) => {
    s = appendEvent(s, { ...event(s, type, payload), ...(sessionId ? { sessionId } : {}) });
  };
  const session = (id: string, mode: CoordinationSession['mode']) => add('SessionStarted', {
    sessionId: id, workflowRunId: s.run.runId, mode, participants: ['supervisor'], initiator: 'supervisor',
    supervisor: 'supervisor', state: 'OPEN', policyId: s.policy.policyId, policyVersion: s.policy.version,
    goal: id, createdAt: s.events.length + 1, updatedAt: s.events.length + 1,
  }, id);
  session('task', 'map.coord.task.v1');
  add('TaskAssigned', { taskId: 't', workflowRunId: s.run.runId, sessionId: 'task', title: 'Work', goal: 'Work',
    assigneeAgentId: 'supervisor', assignedByAgentId: 'supervisor', status: 'ASSIGNED', createdAt: 3, updatedAt: 3 }, 'task');
  add('TaskCompleted', { taskId: 't', resultRef: 'artifact:t', evidenceRefs: ['proof'] }, 'task');
  add('EvaluationAdded', { evaluationId: 'eval', workflowRunId: s.run.runId, sessionId: 'task', evaluatorAgentId: 'supervisor',
    target: { type: 'task', id: 't' }, outcome: 'PASS', createdAt: 5 }, 'task');
  add('SessionResolved', { outcome: 'SUCCEEDED' }, 'task');
  session('decision', 'map.coord.decision.v1');
  add('DecisionOpened', { decisionId: 'd', workflowRunId: s.run.runId, sessionId: 'decision', question: 'Which?',
    authorityAgentId: 'supervisor', options: ['A', 'B'], status: 'OPEN', createdAt: 8, updatedAt: 8 }, 'decision');
  add('DecisionResolved', { decisionId: 'd', value: 'A' }, 'decision');
  add('SessionResolved', { outcome: 'SUCCEEDED' }, 'decision');
  session('quorum', 'map.coord.quorum.v1');
  add('QuorumOpened', { quorumId: 'q', workflowRunId: s.run.runId, sessionId: 'quorum', question: 'Ship?',
    eligibleAgentIds: ['supervisor'], threshold: { kind: 'all' }, votes: {}, status: 'OPEN', createdAt: 12, updatedAt: 12 }, 'quorum');
  add('QuorumVoteCast', { quorumId: 'q', vote: 'APPROVE' }, 'quorum');
  add('QuorumResolved', { quorumId: 'q', outcome: 'APPROVED' }, 'quorum');
  add('SessionResolved', { outcome: 'SUCCEEDED' }, 'quorum');
  add('UsageRecorded', { llmCalls: 2, inputTokens: 7, outputTokens: 3, estimatedCost: 0.02 });
  add('ProgressRecorded', { outcome: 'PROGRESS', summary: 'done' });
  add('PolicyEvaluated', { scope: 'commitment', result: evaluateCommitmentGate(s, s.events.length + 1) });
  add('CommitmentRequested', { commitmentId: 'c', summary: 'complete' });
  add('CommitmentAccepted', { commitmentId: 'c' });
  return s;
}
export function saveHistory(store: SqliteCoordinationRunnerStore, snapshot: CoordinationSnapshot): void {
  for (const e of snapshot.events.slice(1)) store.append(e);
}
export const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export function usage(s: CoordinationSnapshot, id = 'usage'): CoordinationEvent {
  return { ...event(s, 'UsageRecorded', { llmCalls: 1, inputTokens: 2, outputTokens: 3, estimatedCost: 0.01 }), eventId: id, idempotencyKey: id };
}

/** Test-only corruption requires bypassing DB protections deliberately; never normal writes. */
export function bypassFencingForCorruption(raw: DatabaseSync): void {
  for (const row of raw.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND (name LIKE 'fence_%' OR name = 'ledger_audit_update')").all()) {
    raw.exec(`DROP TRIGGER "${String(row.name).replaceAll('"', '""')}"`);
  }
}
