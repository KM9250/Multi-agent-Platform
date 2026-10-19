import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { join } from 'node:path';
import { statSync } from 'node:fs';
import { fixture, fresh, event, history, saveHistory, plain, usage } from './durable-fixture.ts';
import { DurableDatabase, SqliteCoordinationRunnerStore } from '../services/coordination/durable/index.ts';
import type { DurableTransaction } from '../services/coordination/durable/index.ts';
import { createCoordinationRunner, projectCoordinationNotifications } from '../services/coordination/index.ts';
import { browserFixture } from './browser-fixture.ts';

test('seed and original creation identity survive a fresh connection; repeated initialization is idempotent', t => {
  const seed = fresh(); seed.events[0].eventId = 'custom-creation'; seed.events[0].idempotencyKey = 'creation';
  const f = fixture(t, seed); f.db.close();
  const reopened = f.open(); assert.deepEqual(reopened.store.getSnapshot('run'), seed);
  assert.equal(f.raw().prepare('SELECT count(*) AS n FROM schema_migrations').get()!.n, 1);
  assert.equal(f.raw().prepare('PRAGMA user_version').get()!.user_version, 1);
});
test('all projections, usage/progress and terminal commitment equal Kernel replay', t => {
  const f = fixture(t), expected = history(); saveHistory(f.store, expected); f.db.close();
  assert.deepEqual(plain(f.open().store.restoreWorkflow('run')), plain(expected));
  assert.deepEqual(projectCoordinationNotifications(f.open().store.getSnapshot('run')), projectCoordinationNotifications(expected));
});
test('seed, event and returned snapshot mutations cannot change persisted state', t => {
  const seed = fresh(), f = fixture(t, seed); seed.policy.riskRules = { bad: 'ALLOW' }; seed.run.goal = 'changed';
  const e = usage(fresh()), original = structuredClone(e), next = f.store.append(e);
  assert.deepEqual(e, original);
  (e.payload as any).llmCalls = 100; next.run.usage.llmCalls = 100; next.events.length = 0;
  const restored = f.open().store.getSnapshot('run'); assert.equal(restored.run.usage.llmCalls, 1);
  assert.deepEqual(restored.policy, fresh().policy); assert.equal(restored.events.length, 2);
});
test('idempotent retries ignore new sequence/time/ID and preserve original committed event', t => {
  const f = fixture(t), e = usage(fresh()), first = f.store.append(e);
  assert.deepEqual(f.store.append({ ...e, eventId: 'retry', sequence: 99, timestamp: 100 }), first);
  assert.deepEqual(f.store.append({ ...e, idempotencyKey: 'another-key', sequence: 1 }), first);
  assert.deepEqual(f.open().store.getSnapshot('run').events.at(-1), e);
});
test('both event ID and idempotency key collisions are checked, even on simultaneous identity matches', t => {
  const f = fixture(t), a = usage(fresh(), 'a'), first = f.store.append(a), b = usage(first, 'b');
  b.payload = { llmCalls: 2, inputTokens: 0, outputTokens: 0, estimatedCost: 0 }; f.store.append(b);
  for (const e of [{ ...a, payload: {} }, { ...a, eventId: 'other', payload: {} }, { ...a, idempotencyKey: 'b' }]) {
    assert.throws(() => f.store.append(e), { code: 'EVENT_COLLISION' });
  }
  assert.equal(f.store.getSnapshot('run').events.length, 3);
});

function identicalCommittedOperations(t: TestContext) {
  const f = fixture(t);
  const a = { ...usage(fresh(), 'event-A'), idempotencyKey: 'key-A' };
  const b = { ...usage(f.store.append(a), 'event-B'), idempotencyKey: 'key-B' };
  assert.deepEqual(a.payload, b.payload);
  f.store.append(b);
  f.store.createCheckpoint('run');
  f.store.append(event(f.store.getSnapshot('run'), 'ProgressRecorded', { outcome: 'PROGRESS', summary: 'later progress' }));
  const persisted = () => ({
    rows: f.db.read(tx => ({
      journal: tx.all('SELECT * FROM journal_events ORDER BY sequence'),
      seeds: tx.all('SELECT * FROM workflow_seeds ORDER BY workflow_run_id'),
      checkpoints: tx.all('SELECT * FROM workflow_checkpoints ORDER BY checkpoint_id'),
    })),
    snapshot: f.store.getSnapshot('run'),
  });
  return { ...f, a, b, persisted };
}

for (const direction of ['A-ID/B-key', 'B-ID/A-key'] as const) {
  test(`identical-content cross collision ${direction} leaves Journal, head, checkpoint and projections unchanged`, t => {
    const f = identicalCommittedOperations(t), before = f.persisted();
    const crossed = direction === 'A-ID/B-key'
      ? { ...f.a, idempotencyKey: f.b.idempotencyKey }
      : { ...f.b, idempotencyKey: f.a.idempotencyKey };
    assert.throws(() => f.store.append(crossed), { code: 'EVENT_COLLISION' });
    assert.deepEqual(f.persisted(), before);
  });
}

for (const match of ['both', 'ID only', 'key only'] as const) {
  test(`legitimate retry matching ${match} returns latest state and preserves original committed identity`, t => {
    const f = identicalCommittedOperations(t), before = f.persisted();
    const retry = { ...f.a, sequence: 99, timestamp: 100,
      ...(match === 'ID only' ? { idempotencyKey: 'unused-key' } : {}),
      ...(match === 'key only' ? { eventId: 'unused-ID' } : {}),
    };
    assert.deepEqual(f.store.append(retry), before.snapshot);
    assert.deepEqual(f.store.getSnapshot('run').events[1], f.a);
    assert.deepEqual(f.persisted(), before);
  });
}

test('same key with different content still collides without changing persisted state', t => {
  const f = identicalCommittedOperations(t), before = f.persisted();
  const retry = { ...f.a, eventId: 'unused-ID', payload: { llmCalls: 2, inputTokens: 2, outputTokens: 3, estimatedCost: 0.01 } };
  assert.throws(() => f.store.append(retry), { code: 'EVENT_COLLISION' });
  assert.deepEqual(f.persisted(), before);
});

test('unused identifiers still append a new operation with identical semantic content', t => {
  const f = identicalCommittedOperations(t), before = f.persisted();
  const nextEvent = usage(before.snapshot, 'unused-ID-and-key');
  assert.deepEqual(nextEvent.payload, f.a.payload);
  const next = f.store.append(nextEvent), after = f.persisted();
  assert.equal(next.events.length, before.snapshot.events.length + 1);
  assert.deepEqual(next.events.at(-1), nextEvent);
  assert.equal(next.run.usage.llmCalls, before.snapshot.run.usage.llmCalls + 1);
  assert.equal(after.rows.seeds[0].last_sequence, nextEvent.sequence);
  assert.notEqual(after.rows.seeds[0].journal_anchor, before.rows.seeds[0].journal_anchor);
  assert.deepEqual(after.rows.checkpoints, before.rows.checkpoints);
});

test('cross collisions remain rejected after closing and reopening the SQLite connection', t => {
  const f = identicalCommittedOperations(t), before = f.persisted();
  f.db.close();
  const reopened = f.open();
  for (const crossed of [{ ...f.a, idempotencyKey: f.b.idempotencyKey }, { ...f.b, idempotencyKey: f.a.idempotencyKey }]) {
    assert.throws(() => reopened.store.append(crossed), { code: 'EVENT_COLLISION' });
  }
  assert.deepEqual(reopened.store.getSnapshot('run'), before.snapshot);
  assert.deepEqual(reopened.db.read(tx => ({
    journal: tx.all('SELECT * FROM journal_events ORDER BY sequence'),
    seeds: tx.all('SELECT * FROM workflow_seeds ORDER BY workflow_run_id'),
    checkpoints: tx.all('SELECT * FROM workflow_checkpoints ORDER BY checkpoint_id'),
  })), before.rows);
});

test('cross collision propagates through shared writer and rolls back preceding participant writes', t => {
  const f = identicalCommittedOperations(t), before = f.persisted(), raw = f.raw();
  raw.exec('CREATE TABLE extension_fixture (id TEXT PRIMARY KEY)');
  assert.throws(() => f.db.write(tx => {
    tx.run('INSERT INTO extension_fixture VALUES (?)', 'provisional');
    f.store.appendInTransaction(tx, usage(before.snapshot, 'provisional-event'));
    f.store.appendInTransaction(tx, { ...f.a, idempotencyKey: f.b.idempotencyKey });
  }), { code: 'EVENT_COLLISION' });
  assert.equal(raw.prepare('SELECT count(*) AS n FROM extension_fixture').get()!.n, 0);
  assert.deepEqual(f.persisted(), before);
});
test('stale sequence and invalid Kernel transitions cannot advance the Journal', t => {
  const f = fixture(t), e = usage(fresh()); f.store.append(e);
  assert.throws(() => f.open().store.append({ ...e, eventId: 'other', idempotencyKey: 'other' }), { code: 'SEQUENCE_CONFLICT' });
  assert.throws(() => f.store.append(event(f.store.getSnapshot('run'), 'WorkflowResumed', {})), { code: 'INVALID_EVENT' });
  assert.equal(f.store.getSnapshot('run').events.length, 2);
});
test('workflow ownership, listing, missing IDs and duplicate seed refusal', t => {
  const f = fixture(t); f.store.createWorkflow(fresh('other'));
  assert.deepEqual(f.store.listWorkflowIds(), ['other', 'run']);
  assert.throws(() => f.store.createWorkflow(fresh()), { code: 'WORKFLOW_EXISTS' });
  assert.throws(() => f.store.append({ ...usage(fresh()), workflowRunId: 'missing' }), { code: 'WORKFLOW_NOT_FOUND' });
  f.store.append(usage(fresh())); assert.deepEqual(f.store.getSnapshot('other'), fresh('other'));
});
test('only canonical initial snapshots can be registered', t => {
  const f = fixture(t);
  assert.throws(() => f.store.createWorkflow(history(fresh('progressed'))));
  const ghost = fresh('ghost'); ghost.sessions.phantom = {} as never;
  assert.throws(() => f.store.createWorkflow(ghost));
  assert.deepEqual(f.store.listWorkflowIds(), ['run']);
});
test('non-JSON values fail closed without payload-bearing errors', t => {
  const f = fixture(t), cycle: any = {}; cycle.self = cycle;
  const getter = Object.defineProperty({}, 'private-goal', { enumerable: true, get() { throw new Error('private-goal'); } });
  for (const payload of [undefined, NaN, Infinity, 1n, () => {}, Symbol('private-goal'), new Date(), new Map(), cycle, [undefined], Array(2), getter]) {
    assert.throws(() => f.store.append({ ...usage(fresh()), payload }), (e: any) => e.code === 'INVALID_JSON' && !String(e).includes('private-goal'));
  }
  assert.deepEqual(f.store.getSnapshot('run'), fresh());
});
test('late SQL failure rolls back inserted event and shared writer participants', t => {
  const f = fixture(t), raw = f.raw();
  raw.exec("CREATE TRIGGER fail_head BEFORE UPDATE OF last_sequence ON workflow_seeds BEGIN SELECT RAISE(ABORT, 'private-goal'); END");
  assert.throws(() => f.store.append(usage(fresh())), { code: 'DATABASE_ERROR', message: 'DATABASE_ERROR' });
  assert.deepEqual(f.store.getSnapshot('run'), fresh()); raw.exec('DROP TRIGGER fail_head');
  raw.exec('CREATE TABLE extension_fixture (id TEXT PRIMARY KEY)');
  assert.throws(() => f.db.write(tx => {
    f.store.appendInTransaction(tx, usage(fresh())); tx.run('INSERT INTO extension_fixture VALUES (?)', 'x'); throw new Error('private-goal');
  }), { code: 'DATABASE_ERROR' });
  assert.equal(raw.prepare('SELECT count(*) AS n FROM extension_fixture').get()!.n, 0);
  assert.deepEqual(f.store.getSnapshot('run'), fresh());
  f.db.write(tx => { f.store.appendInTransaction(tx, usage(fresh())); tx.run('INSERT INTO extension_fixture VALUES (?)', 'x'); });
  assert.equal(f.store.getSnapshot('run').events.length, 2);
  assert.equal(raw.prepare('SELECT count(*) AS n FROM extension_fixture').get()!.n, 1);
});
test('transaction capabilities expire, reject nesting/async/control SQL and foreign connections', t => {
  const f = fixture(t); let leaked!: DurableTransaction;
  f.db.write(tx => { leaked = tx; });
  assert.throws(() => f.store.appendInTransaction(leaked, usage(fresh())), { code: 'INVALID_TRANSACTION' });
  assert.throws(() => f.db.write(() => f.store.append(usage(fresh()))), { code: 'INVALID_TRANSACTION' });
  assert.throws(() => f.db.write(async () => 1), { code: 'INVALID_TRANSACTION' });
  assert.throws(() => f.db.write(tx => tx.run('COMMIT')), { code: 'INVALID_TRANSACTION' });
  assert.throws(() => f.db.read(tx => f.store.appendInTransaction(tx, usage(fresh()))), { code: 'INVALID_TRANSACTION' });
  const other = f.open(); assert.throws(() => other.db.write(tx => f.store.appendInTransaction(tx, usage(fresh()))), { code: 'INVALID_TRANSACTION' });
});
test('bounded busy writer fails safely and can be retried after lock release', t => {
  const f = fixture(t), contender = new DurableDatabase({ path: f.path, busyTimeoutMs: 10 });
  t.after(() => contender.close()); const store = new SqliteCoordinationRunnerStore(contender);
  const raw = f.raw(); raw.exec('BEGIN IMMEDIATE');
  assert.throws(() => store.append(usage(fresh())), { code: 'DATABASE_BUSY' }); raw.exec('ROLLBACK');
  assert.equal(store.append(usage(fresh())).events.length, 2);
});
test('immutable SQL constraints and ownership foreign keys protect committed rows', t => {
  const f = fixture(t), raw = f.raw(); raw.exec('PRAGMA foreign_keys=ON');
  for (const sql of ["DELETE FROM journal_events", "UPDATE journal_events SET event_id='changed'", "UPDATE workflow_seeds SET policy_payload='{}'", 'DELETE FROM workflow_seeds']) assert.throws(() => raw.exec(sql));
  assert.throws(() => raw.prepare('INSERT INTO journal_events SELECT ?,sequence,event_id,event_type,session_id,actor_agent_id,event_timestamp,idempotency_key,payload,payload_digest FROM journal_events').run('missing'));
  assert.throws(() => raw.exec('INSERT INTO journal_events SELECT * FROM journal_events'));
});
test('connection settings, private files, backup including WAL and configuration checks', t => {
  const f = fixture(t); f.store.append(usage(fresh()));
  const backup = join(f.dir, 'backup.sqlite'); f.db.backup(backup);
  const db = new DurableDatabase({ path: backup }); t.after(() => db.close());
  assert.deepEqual(new SqliteCoordinationRunnerStore(db).getSnapshot('run'), f.store.getSnapshot('run'));
  assert.throws(() => f.db.backup(backup), { code: 'INVALID_CONFIGURATION' });
  if (process.platform !== 'win32') assert.equal(statSync(f.path).mode & 0o777, 0o600);
  assert.equal(f.raw().prepare('PRAGMA journal_mode').get()!.journal_mode, 'wal');
  assert.throws(() => new DurableDatabase({ path: 'relative.sqlite' }), { code: 'INVALID_CONFIGURATION' });
  assert.throws(() => new DurableDatabase({ path: f.path, busyTimeoutMs: Infinity }), { code: 'INVALID_CONFIGURATION' });
});
test('actual Browser Runner accepts synchronous durable store; reads never auto-start actions', async t => {
  const browser = browserFixture(), f = fixture(t, browser.get());
  const runner = createCoordinationRunner({ ...browser.deps, store: f.store });
  assert.equal((await runner.runOneRound('run')).reason, 'round_completed');
  assert.equal(browser.calls.execute, 1);
  const before = { ...browser.calls }, snapshot = f.store.getSnapshot('run'); f.db.close();
  assert.deepEqual(plain(f.open().store.getSnapshot('run')), plain(snapshot)); assert.deepEqual(browser.calls, before);
});
