import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, fresh } from './durable-fixture.ts';
import { leaseChild, untilExpired, terminationName } from './lease-fixture.ts';
import { RecoveryReader } from '../services/coordination/durable/index.ts';

const saved = (f: ReturnType<typeof fixture>, workflow = 'run') => f.db.read(tx => ({
  lease: tx.get('SELECT * FROM runtime_leases WHERE workflow_run_id=?', workflow),
  audit: tx.all("SELECT * FROM runtime_audit_events WHERE workflow_run_id=? AND event_kind LIKE 'LEASE_%' ORDER BY audit_sequence", workflow),
  journal: tx.all('SELECT * FROM journal_events ORDER BY sequence'),
}));
test('Independent Node processes racing Acquire grant exactly one owner; active contention remains rejected', async t => {
  const f = fixture(t); f.release();
  const [a, b] = await Promise.all([leaseChild(t, f.path, 2000), leaseChild(t, f.path, 2000)]);
  assert.notEqual(a.runtimeInstanceId, b.runtimeInstanceId);
  const outcomes = await Promise.all([a.request('acquire'), b.request('acquire')]);
  assert.equal(outcomes.filter(o => o.value).length, 1);
  assert.equal(outcomes.filter(o => o.code === 'LEASE_HELD').length, 1);
  const owner = outcomes[0].value ? a : b, contender = owner === a ? b : a;
  assert.equal((await contender.request('acquire')).code, 'LEASE_HELD');
  assert.equal((await owner.request('renew')).code, undefined);
  assert.equal(saved(f).lease!.owner_instance_id, owner.runtimeInstanceId);
  assert.equal(saved(f).audit.filter(row => row.runtime_generation === 2).length, 1);
  assert.notEqual(new RecoveryReader(f.db).inspect('run').disposition, 'RECOVERY_FAILED');
});
test('Expired owner returns after takeover: old write, delayed heartbeat and delayed release cannot affect new generation', async t => {
  const f = fixture(t); f.release();
  const [old, next] = await Promise.all([leaseChild(t, f.path, 500), leaseChild(t, f.path, 2000)]);
  const acquired = (await old.request('acquire')).value; await untilExpired(acquired.expiresAt);
  const current = (await next.request('acquire')).value;
  assert.equal(current.generation, acquired.generation + 1);
  const before = saved(f);
  for (const command of ['append','renew','release']) assert.equal((await old.request(command)).code, 'LEASE_FENCED');
  assert.deepEqual(saved(f), before);
  assert.equal((await next.request('append')).value, 2);
  assert.equal(saved(f).lease!.owner_instance_id, next.runtimeInstanceId);
  const row = saved(f).audit.at(-1)!;
  assert.equal(row.event_kind, 'LEASE_TAKEN_OVER'); assert.equal(row.reason_code, 'LEASE_EXPIRED');
  assert.equal(row.previous_state, 'EXPIRED'); assert.equal(row.runtime_generation, current.generation);
  assert.equal(new RecoveryReader(f.db).inspect('run').executionAllowed, false);
});
test('DB Busy never creates a second owner; failed heartbeat invalidates the retained handle', async t => {
  const f = fixture(t); f.release();
  const [owner, blocked, locker] = await Promise.all([leaseChild(t, f.path, 2000), leaseChild(t, f.path, 2000), leaseChild(t, f.path, 2000)]);
  await owner.request('acquire'); const before = saved(f);
  await locker.request('lock');
  assert.equal((await blocked.request('acquire')).code, 'DATABASE_BUSY');
  assert.equal((await owner.request('renew')).code, 'DATABASE_BUSY');
  await locker.request('unlock');
  assert.equal((await owner.request('append')).code, 'LEASE_FENCED');
  assert.equal((await blocked.request('acquire')).code, 'LEASE_HELD');
  assert.deepEqual(saved(f), before);
});
for (const [operation, boundary, committed] of [
  ['acquire','before',false], ['acquire','after',true], ['renew','before',false],
  ['takeover','before',false], ['takeover','after',true],
] as const) test(`${terminationName} ${operation}/${boundary}: Lease and Audit recover at one COMMIT`, async t => {
  const f = fixture(t); f.release();
  const old = await leaseChild(t, f.path, 400);
  const workflow = operation === 'acquire' ? 'new' : 'run';
  if (operation === 'acquire') f.store.createWorkflow(fresh(workflow));
  let actor = old;
  if (operation !== 'acquire') {
    const held = (await old.request('acquire')).value;
    if (operation === 'takeover') { actor = await leaseChild(t, f.path, 1000); await untilExpired(held.expiresAt); }
  }
  const before = saved(f, workflow);
  const pending = actor.request(operation === 'renew' ? 'renew' : 'acquire', { workflow, crash: `${operation}-${boundary}` });
  assert.equal(await actor.stage, `${operation}-${boundary}`);
  await actor.kill(); await pending;
  const after = saved(f, workflow);
  if (!committed) assert.deepEqual(after, before);
  else {
    assert.equal(Number(after.lease!.generation), Number(before.lease?.generation ?? 0) + 1);
    assert.equal(after.audit.length, before.audit.length + 1);
    assert.equal(after.lease!.owner_instance_id, actor.runtimeInstanceId);
  }
  assert.deepEqual(after.journal, before.journal);
  assert.notEqual(new RecoveryReader(f.db).inspect('run').disposition, 'RECOVERY_FAILED');
  // COMMIT-after/response-before death leaves a real lease; there is no implicit re-acquisition.
  if (committed) {
    const contender = await leaseChild(t, f.path, 1000);
    if (Number(after.lease!.expires_at) > Date.now()) assert.equal((await contender.request('acquire', { workflow })).code, 'LEASE_HELD');
  }
});
