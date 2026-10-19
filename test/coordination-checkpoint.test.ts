import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, fresh, usage, history, saveHistory, plain } from './durable-fixture.ts';
import { digest } from '../services/coordination/durable/integrity.ts';

test('checkpoint records the committed sequence, digest and journal chain anchor', t => {
  const f = fixture(t); const state = f.store.append(usage(fresh()));
  const cp = f.store.createCheckpoint('run'), head = f.raw().prepare('SELECT * FROM workflow_seeds').get()!;
  assert.equal(cp.lastSequence, 2); assert.equal(cp.journalAnchor, head.journal_anchor);
  assert.equal(cp.snapshotDigest, digest(state)); assert.deepEqual(cp.snapshot, state);
  assert.deepEqual(f.store.loadCheckpoint('run'), cp);
  cp.snapshot.run.goal = 'mutated'; assert.deepEqual(f.store.getSnapshot('run'), state);
});
test('old checkpoint restores every later committed projection and remains deterministic', t => {
  const f = fixture(t), expected = history();
  for (const e of expected.events.slice(1, 7)) f.store.append(e);
  const cp = f.store.createCheckpoint('run');
  for (const e of expected.events.slice(7)) f.store.append(e);
  f.db.close(); const reopened = f.open();
  assert.equal(reopened.store.loadCheckpoint('run')!.lastSequence, cp.lastSequence);
  for (let n = 0; n < 3; n++) assert.deepEqual(plain(reopened.store.restoreWorkflow('run')), plain(expected));
});
test('absent checkpoints replay the Journal', t => {
  const f = fixture(t); assert.equal(f.store.loadCheckpoint('run'), undefined);
  assert.deepEqual(f.store.getSnapshot('run'), fresh());
});
for (const [name, sql, params] of [
  ['invalid JSON', 'snapshot_payload = ?', ['{']],
  ['digest', 'snapshot_digest = ?', ['wrong']],
  ['anchor', 'journal_anchor = ?', ['wrong']],
  ['unsupported version', 'schema_version = ?', [99]],
  ['missing sequence', 'last_sequence = ?', [999]],
] as const) {
  test(`corrupt checkpoint ${name} falls back to an older checkpoint or full replay`, t => {
    const f = fixture(t), first = f.store.createCheckpoint('run');
    const expected = f.store.append(usage(fresh())), second = f.store.createCheckpoint('run');
    const raw = f.raw(); raw.exec('PRAGMA foreign_keys=OFF');
    raw.prepare(`UPDATE workflow_checkpoints SET ${sql} WHERE checkpoint_id = ?`).run(...params, second.checkpointId);
    assert.equal(f.store.loadCheckpoint('run')!.checkpointId, first.checkpointId);
    assert.deepEqual(f.store.getSnapshot('run'), expected);
    raw.prepare('DELETE FROM workflow_checkpoints WHERE checkpoint_id = ?').run(first.checkpointId);
    assert.equal(f.store.loadCheckpoint('run'), undefined);
    assert.deepEqual(f.store.getSnapshot('run'), expected);
    // Reconnect must not let a corrupt derived FK prevent Journal recovery.
    f.db.close(); assert.deepEqual(f.open().store.getSnapshot('run'), expected);
  });
}
test('a recomputed digest cannot legitimize a projection or foreign-workflow mismatch', t => {
  const f = fixture(t), expected = history(); saveHistory(f.store, expected);
  const cp = f.store.createCheckpoint('run'), raw = f.raw();
  for (const changed of [
    { ...cp.snapshot, tasks: { ...cp.snapshot.tasks, t: { ...cp.snapshot.tasks.t, title: 'invented' } } },
    { ...cp.snapshot, run: { ...cp.snapshot.run, runId: 'foreign' } },
    { ...cp.snapshot, policy: { ...cp.snapshot.policy, riskRules: { injected: 'ALLOW' } } },
  ]) {
    raw.prepare('UPDATE workflow_checkpoints SET snapshot_payload = ?, snapshot_digest = ?').run(JSON.stringify(changed), digest(changed));
    assert.equal(f.store.loadCheckpoint('run'), undefined);
    assert.deepEqual(plain(f.store.getSnapshot('run')), plain(expected));
  }
});
test('checkpoint write failure never rolls back previously committed events', t => {
  const f = fixture(t), expected = f.store.append(usage(fresh()));
  f.raw().exec("CREATE TRIGGER checkpoint_failure BEFORE INSERT ON workflow_checkpoints BEGIN SELECT RAISE(ABORT, 'private'); END");
  assert.throws(() => f.store.createCheckpoint('run'), { code: 'DATABASE_ERROR' });
  assert.deepEqual(f.open().store.getSnapshot('run'), expected);
});
test('checkpoint cannot conceal a damaged Journal prefix or a missing committed tail', t => {
  const f = fixture(t); f.store.append(usage(fresh())); f.store.createCheckpoint('run');
  const raw = f.raw(); raw.exec('PRAGMA foreign_keys=OFF; DROP TRIGGER journal_no_delete; DELETE FROM journal_events WHERE sequence = 2');
  assert.throws(() => f.store.getSnapshot('run'), { code: 'INTEGRITY_ERROR' });
  assert.throws(() => f.store.loadCheckpoint('run'), { code: 'INTEGRITY_ERROR' });
  assert.equal(raw.prepare('SELECT count(*) AS n FROM journal_events').get()!.n, 1);
});
