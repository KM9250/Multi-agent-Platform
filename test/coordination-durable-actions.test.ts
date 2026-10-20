import assert from 'node:assert/strict';
import test from 'node:test';
import { DurableExecutionCoordinator } from '../services/coordination/durable/index.ts';
import { executionFixture, registration, record, prepared, clock } from './durable-execution-fixture.ts';
import { executionJson, EXECUTION_LIMITS } from '../services/coordination/durable/executionIntegrity.ts';

test('registration atomically commits Action, Session, Task and PREPARED and retains round context', t => {
  const f = executionFixture(t), task = f.register();
  assert.equal(task.status, 'ASSIGNED'); assert.equal(f.snapshot().sessions.session.contextRef, 'map.runner.v1:round');
  assert.equal(f.coordinator.inspectExecution('run','action')!.state, 'PREPARED');
  assert.deepEqual(f.coordinator.pendingActions.get('run','action'), record);
  assert.deepEqual(f.snapshot().events.map(e => e.type), ['WorkflowRunCreated','SessionStarted','TaskAssigned']);
});
for (const target of ['pending_actions','execution_ledger','journal_events']) test(`registration rolls back all participants when ${target} insert fails`, t => {
  const f = executionFixture(t);
  f.raw().exec(`CREATE TRIGGER fail_insert BEFORE INSERT ON ${target} BEGIN SELECT RAISE(ABORT,'private-payload'); END`);
  assert.throws(() => f.register(), { code: 'DATABASE_ERROR', message: 'DATABASE_ERROR' });
  assert.equal(f.snapshot().events.length, 1);
  for (const table of ['pending_actions','execution_ledger']) assert.equal(f.raw().prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n, 0);
});
test('reconnection restores prepared payload without altering Fingerprint and scoped lookup refuses other workflow', t => {
  const f = executionFixture(t); f.register(); f.db.close();
  const reopened = f.open(), c = new DurableExecutionCoordinator(reopened.store, f.registry, { clock });
  assert.deepEqual(c.pendingActions.get('run','action'), record);
  assert.equal(c.pendingActions.get('other','action'), undefined);
  assert.throws(() => c.getResult('other', reopened.store.getSnapshot('run').tasks.task));
});
test('same registration reuses committed identities after response loss; conflicting retries fail closed', t => {
  const f = executionFixture(t), request = registration(f.store);
  const put = () => f.coordinator.registerAction(record, request.expected, request.sessionEvent, request.taskEvent);
  put(); assert.deepEqual(put(), record); assert.equal(f.snapshot().events.length, 3);
  assert.throws(() => f.coordinator.registerAction({ ...record, action: { ...prepared, fingerprint: 'other' } }, request.expected, request.sessionEvent, request.taskEvent));
  assert.throws(() => f.coordinator.registerAction({ ...record, action: { ...prepared, actionId: 'other' } }, request.expected, request.sessionEvent, request.taskEvent));
  assert.equal(f.snapshot().events.length, 3);
});
test('prepare cursor, policy and Action/Task association are revalidated inside registration transaction', t => {
  const f = executionFixture(t), request = registration(f.store);
  f.add('UsageRecorded', { llmCalls: 1, inputTokens: 0, outputTokens: 0, estimatedCost: 0 });
  assert.throws(() => f.coordinator.registerAction(record, request.expected, request.sessionEvent, request.taskEvent), { code: 'SEQUENCE_CONFLICT' });
  const latest = registration(f.store); latest.expected.policy = {...latest.expected.policy,riskRules:{read:'DENY'}};
  assert.throws(() => f.coordinator.registerAction(record, latest.expected, latest.sessionEvent, latest.taskEvent));
  const invalid = registration(f.store); (invalid.taskEvent.payload as any).inputRefs = ['map.runner.action.v1:wrong:fingerprint'];
  assert.throws(() => f.coordinator.registerAction(record, invalid.expected, invalid.sessionEvent, invalid.taskEvent));
  assert.equal(f.snapshot().events.length, 2); assert.equal(f.coordinator.pendingActions.get('run','action'), undefined);
});
for (const [label,payload] of [
  ['large',{ input: 'x'.repeat(256 * 1024) }], ['deep', Array.from({length:34}).reduce(v => ({ nested:v }), {})],
  ['credential',{ apiKey:'raw-token' }], ['invalid reference',{ credentialRef: { kind:'secret-reference', reference:'raw-token' } }],
  ['invalid JSON',{value: Infinity}], ['accessor',Object.defineProperty({},'value',{enumerable:true,get(){throw Error('raw-token');}})],
] as const) test(`rejects ${label} prepared payload before registration without raw errors`, t => {
  const f = executionFixture(t), r = { ...record, action: { ...prepared, payload } }, request = registration(f.store, r);
  assert.throws(() => f.coordinator.registerAction(r, request.expected, request.sessionEvent, request.taskEvent), (e: any) => !String(e).includes('raw-token'));
  assert.equal(f.snapshot().events.length,1);
});
test('explicit secret references are persisted without resolving credentials', t => {
  const f = executionFixture(t), r = { ...record, action: { ...prepared, payload: { credentialRef: { kind: 'secret-reference', reference: 'map.secret.v1:service/account' } } } };
  f.register(r); assert.deepEqual(f.coordinator.pendingActions.get('run','action'),r);
});
test('JSON budgets preserve canonical fingerprint inputs and reject huge/sparse containers before encoding', () => {
  assert.equal(executionJson({ z:2,a:1 }, EXECUTION_LIMITS.action), '{"a":1,"z":2}');
  for (const bad of [new Array(10000000), [undefined], 1n, new Date(), NaN]) assert.throws(() => executionJson(bad, EXECUTION_LIMITS.action));
});
