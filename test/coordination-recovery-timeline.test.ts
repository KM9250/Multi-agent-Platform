import assert from 'node:assert/strict';
import test from 'node:test';
import { executionFixture, executionSeed, record, registration } from './durable-execution-fixture.ts';
import { reader, contents } from './recovery-fixture.ts';

test('timeline separates Journal, audit transitions and current Ledger; Action filter includes Task events', async t => {
  const f = executionFixture(t), task = f.register(); await f.coordinator.dispatch('run', task); f.coordinator.finalizeResult('run', task);
  const page = reader(f).getActionHistory('run', 'action');
  assert.equal(page.ledgerHistoricalCoverage, 'PARTIAL'); assert.equal(page.crossSourceClockOrderGuaranteed, false);
  assert.ok(page.entries.some(e => e.source === 'JOURNAL' && e.eventKind === 'TaskAssigned'));
  assert.deepEqual(page.entries.filter(e => e.source === 'EXECUTION_AUDIT').map(e => e.nextState), ['PREPARED','DISPATCH_RESERVED','RESULT_RECORDED','FINALIZED']);
  assert.equal(page.entries.at(-1)!.source, 'CURRENT_SNAPSHOT'); assert.equal(page.entries.at(-1)!.historicalCoverage, 'CURRENT_ONLY');
  assert.equal(page.entries.at(-1)!.nextState, 'FINALIZED');
});
test('cursor pages contain no duplicates and upper bounds exclude later appended events', t => {
  const f = executionFixture(t); f.register(); const r = reader(f), expected = r.getWorkflowTimeline('run').entries;
  let page = r.getWorkflowTimeline('run', { limit: 2 }); const entries = [...page.entries];
  f.add('UsageRecorded', { llmCalls: 1, inputTokens: 1, outputTokens: 1, estimatedCost: 0 });
  while (page.nextCursor) { page = r.getWorkflowTimeline('run', { limit: 2, cursor: page.nextCursor }); entries.push(...page.entries); }
  assert.deepEqual(entries, expected); assert.ok(r.getWorkflowTimeline('run').entries.length > entries.length);
});
test('filters for Workflow, Action, Event Kind and inclusive occurred-time range are applied in SQL', t => {
  const f = executionFixture(t); f.register(); f.store.createWorkflow(executionSeed('ALLOW', 'second'));
  const other = { ...record, workflowRunId: 'second' }, request = registration(f.store, other); f.coordinator.registerAction(other, request.expected, request.sessionEvent, request.taskEvent);
  const r = reader(f), page = r.getWorkflowTimeline('run', { actionId: 'action', eventKind: 'TaskAssigned', fromTimestamp: 10, toTimestamp: 10 });
  assert.equal(page.entries.length, 1); assert.equal(page.entries[0].workflowRunId, 'run'); assert.equal(page.entries[0].eventKind, 'TaskAssigned');
  assert.equal(r.getWorkflowTimeline('run', { fromTimestamp: 11 }).entries.length, 0);
  assert.equal(r.getActionHistory('run', 'missing').entries.length, 0);
});
for (const options of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { fromTimestamp: -1 }, { fromTimestamp: 11, toTimestamp: 10 }, { cursor: 'bad' }, { eventKind: 'x;SELECT' }])
  test(`rejects invalid timeline query ${JSON.stringify(options)}`, t => { const f = executionFixture(t); assert.throws(() => reader(f).getWorkflowTimeline('run', options), { code: 'INVALID_CONFIGURATION' }); });
test('cursor is bound to Workflow and filters, and page size remains capped', t => {
  const f = executionFixture(t); f.register(); f.store.createWorkflow(executionSeed('ALLOW', 'second')); const r = reader(f);
  const cursor = r.getWorkflowTimeline('run', { limit: 1 }).nextCursor!;
  assert.throws(() => r.getWorkflowTimeline('second', { cursor }), { code: 'INVALID_CONFIGURATION' });
  assert.throws(() => r.getWorkflowTimeline('run', { cursor, actionId: 'action' }), { code: 'INVALID_CONFIGURATION' });
});
test('large histories use bounded SELECT results and do not materialize raw Journal/Result/Evidence payloads', t => {
  const f = executionFixture(t); f.register();
  for (let i = 0; i < 125; i++) f.add('UsageRecorded', { llmCalls: 1, inputTokens: 0, outputTokens: 0, estimatedCost: 0 });
  const before = contents(f), page = reader(f).getWorkflowTimeline('run'); assert.equal(page.entries.length, 100); assert.ok(page.nextCursor);
  assert.deepEqual(contents(f), before);
});
test('sensitive payloads, summaries, paths and tokens do not appear in inspection or timeline DTOs', async t => {
  const f = executionFixture(t), secret = 'RAW_PRIVATE_MARKER_/private/data/token';
  f.executor.execute = async () => ({ status: 'succeeded', summary: secret }); const task = f.register(); await f.coordinator.dispatch('run', task);
  const r = reader(f), json = JSON.stringify([r.inspect('run'), r.getWorkflowTimeline('run'), r.getActionHistory('run', 'action')]);
  assert.equal(json.includes(secret), false);
  for (const field of ['payload','content_json','prepared_action_json','result_json','resultDigest']) assert.equal(json.includes(`"${field}"`), false);
});
