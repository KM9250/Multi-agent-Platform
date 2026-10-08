import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BROWSER_RISK_RULES, browserFingerprint, browserObservation, browserStateToken, canonicalSerialize, createBrowserPocExecutor,
  createCoordinationRunner, normalizeBrowserCommand,
} from '../services/coordination/index.ts';
import type { BrowserPocCommand, BrowserPreparedPayloadV1 } from '../services/coordination/index.ts';
import { browserFixture, executionContext, proposal } from './browser-fixture.ts';

for (const [op, args] of [
  ['unknown', {}], ['read', null], ['read', []], ['input', { targetId: 'query-input' }], ['input', { targetId: 'query-input', value: 12 }],
  ['input', { targetId: 'query-input', value: 'x'.repeat(10001) }], ['interact', { targetId: 'confirm-checkbox', interaction: 'submit' }],
  ['interact', { targetId: 'confirm-checkbox', interaction: 'toggle', value: 'yes' }], ['read', { selector: 'body' }], ['read', { xpath: '//input' }],
  ...['https://example.com', 'http://example.com', 'javascript:alert(1)', 'data:text/html,foo', 'file:///tmp/file'].map(pageId => ['navigate', { pageId }]),
] as Array<[string, unknown]>) test(`runtime rejects ${op} ${JSON.stringify(args).slice(0,100)}`, () => {
  assert.throws(() => normalizeBrowserCommand(op, args));
});
for (const command of [
  { operation: 'read', targetId: 'unknown' }, { operation: 'navigate', pageId: 'unknown' },
  { operation: 'input', targetId: 'confirm-checkbox', value: 'no' },
  { operation: 'interact', targetId: 'submit-button', interaction: 'click' },
  { operation: 'interact', targetId: 'category-select', interaction: 'select', value: 'not-allowed' },
  { operation: 'submit', targetId: 'preview-button' },
] as BrowserPocCommand[]) test(`capability boundary rejects ${JSON.stringify(command)}`, async () => {
  const f = browserFixture(); await assert.rejects(f.executor.prepare(proposal(command))); assert.equal(f.controller.getState().revision, 0);
});
test('prepare is side effect free, cloneable, normalizes hints and fixes observed state', async () => {
  const f = browserFixture(); const command = proposal({ operation: 'input', targetId: 'query-input', value: 'private-input' });
  const action = await f.executor.prepare({ ...command, arguments: { ...command.arguments, actionClass: 'browser.read', fingerprint: 'forged', expectedStateToken: 'forged' } });
  assert.equal(action.actionClass, 'browser.input'); assert.notEqual(action.fingerprint, 'forged'); assert.deepEqual(action, structuredClone(action));
  assert.equal(f.controller.getState().query, ''); assert.equal(f.controller.getState().revision, 0);
  assert.equal(action.retrySafety, 'never'); assert.ok(!action.publicSummary.includes('private-input'));
  assert.equal((action.payload as BrowserPreparedPayloadV1).stateToken, await browserStateToken(await f.driver.inspect()));
});
test('canonical serialization and fingerprint ignore object key insertion order', async () => {
  const f = browserFixture(); const a = await f.executor.prepare(proposal({ operation: 'input', targetId: 'query-input', value: 'a' }));
  const b = await f.executor.prepare({ executorId: 'browser', operation: 'input', arguments: { value: 'a', targetId: 'query-input' } });
  assert.equal(a.fingerprint, b.fingerprint); assert.notEqual(a.actionId, b.actionId);
  assert.equal(canonicalSerialize({ z: 1, a: { b: 2, a: 3 } }), canonicalSerialize({ a: { a: 3, b: 2 }, z: 1 }));
});
test('operation, target, value, state, surface and classification are bound to fingerprint', async () => {
  const f = browserFixture(); const action = await f.executor.prepare(proposal({ operation: 'input', targetId: 'query-input', value: 'a' }));
  const payload = action.payload as BrowserPreparedPayloadV1;
  for (const changed of [
    { ...payload, operation: 'read' as const, command: { operation: 'read' as const } },
    { ...payload, command: { operation: 'input' as const, targetId: 'other', value: 'a' } },
    { ...payload, command: { operation: 'input' as const, targetId: 'query-input', value: 'b' } },
    { ...payload, stateToken: 'other-state' }, { ...payload, surfaceId: 'other-surface' },
  ]) assert.notEqual(await browserFingerprint(changed), action.fingerprint);
});
for (const field of ['value', 'target', 'class', 'operation', 'extra', 'summary']) test(`prepared ${field} tampering never dispatches`, async () => {
  const f = browserFixture(); const a = await f.executor.prepare(proposal({ operation: 'input', targetId: 'query-input', value: 'a' }));
  const p = a.payload as BrowserPreparedPayloadV1;
  if (field === 'value') (p.command as { value: string }).value = 'b';
  if (field === 'target') (p.command as { targetId: string }).targetId = 'submit-button';
  if (field === 'class') a.actionClass = 'browser.read';
  if (field === 'operation') a.operation = 'read';
  if (field === 'extra') Object.assign(p.command, { fingerprint: 'ignored-hint' });
  if (field === 'summary') a.publicSummary = 'secret';
  assert.equal((await f.executor.execute(a, executionContext)).status, 'failed'); assert.equal(f.controller.getState().revision, 0);
});
test('stale state rejects with no mutation or automatic reprepare', async () => {
  const f = browserFixture(); const a = await f.executor.prepare(proposal({ operation: 'submit', targetId: 'submit-button' }));
  f.controller.setContent('Changed ordinary content.');
  const result = await f.executor.execute(a, executionContext); assert.equal(result.errorCode, 'BROWSER_STALE_STATE'); assert.equal(f.controller.getState().submitCount, 0);
});
test('abort before dispatch is failed and has no mutation', async () => {
  const f = browserFixture(); const a = await f.executor.prepare(proposal({ operation: 'submit', targetId: 'submit-button' }));
  const abort = new AbortController(); abort.abort();
  const result = await f.executor.execute(a, { ...executionContext, signal: abort.signal });
  assert.equal(result.status, 'failed'); assert.equal(result.errorCode, 'BROWSER_ABORTED_BEFORE_DISPATCH'); assert.equal(f.controller.getState().submitCount, 0);
});
test('dispatch-time guard catches state changed during executor awaits', async () => {
  const f = browserFixture(); const a = await f.executor.prepare(proposal({ operation: 'submit', targetId: 'submit-button' }));
  const submit = f.driver.submit.bind(f.driver);
  f.driver.submit = async (...args) => { f.controller.setContent('Another ordinary state.'); return submit(...args); };
  assert.equal((await f.executor.execute(a, executionContext)).errorCode, 'BROWSER_STALE_STATE'); assert.equal(f.controller.getState().submitCount, 0);
});
test('unknown result after dispatch is uncertain and submission is not retried', async () => {
  const f = browserFixture({ operation: 'submit', targetId: 'submit-button' });
  const submit = f.driver.submit.bind(f.driver);
  f.driver.submit = async (...args) => { await submit(...args); throw new Error('Lost result including private diagnostic'); };
  const blocked = await f.runner.runOneRound('run'); f.resume(blocked.pendingApproval!.approvalRef);
  const result = await f.runner.runOneRound('run'); assert.match(result.snapshot.run.statusReason!, /^RUNNER_EXECUTION_UNCERTAIN:/);
  assert.equal(f.calls.verify, 0); assert.equal(f.controller.getState().submitCount, 1);
  await f.runner.runOneRound('run'); assert.equal(f.controller.getState().submitCount, 1);
});
for (const command of [{ operation: 'read' }, { operation: 'navigate', pageId: 'result' }] as BrowserPocCommand[]) test(`${command.operation} ALLOW executes with safe evidence`, async () => {
  const f = browserFixture(command); assert.equal((await f.runner.runOneRound('run')).reason, 'round_completed');
  assert.equal(f.calls.execute, 1); assert.equal(f.calls.verify, 1);
  assert.ok(f.requests.verifies[0].evidence.some(e => e.kind.startsWith('browser.')));
});
for (const command of [
  { operation: 'input', targetId: 'query-input', value: 'private-form-value' },
  { operation: 'interact', targetId: 'confirm-checkbox', interaction: 'toggle' },
  { operation: 'interact', targetId: 'category-select', interaction: 'select', value: 'research' },
  { operation: 'interact', targetId: 'preview-button', interaction: 'click' },
  { operation: 'submit', targetId: 'submit-button' }, { operation: 'submit', targetId: 'demo-form' },
] as BrowserPocCommand[]) test(`${JSON.stringify(command)} needs exact approval; once-only and private journal`, async () => {
  const f = browserFixture(command); const first = await f.runner.runOneRound('run');
  assert.equal(first.reason, 'needs_user'); assert.equal(f.calls.execute, 0); assert.equal(f.controller.getState().revision, 0);
  f.resume('wrong'); await f.runner.runOneRound('run'); assert.equal(f.calls.execute, 0);
  f.resume(first.pendingApproval!.approvalRef); const newRunner = createCoordinationRunner(f.deps); await newRunner.runOneRound('run');
  assert.equal(f.calls.execute, 1); assert.equal(f.calls.verify, 1); assert.equal(f.controller.getState().revision, 1);
  assert.equal(JSON.stringify(f.get()).includes('private-form-value'), false);
  assert.equal(JSON.stringify(first.pendingApproval).includes('private-form-value'), false);
  assert.equal(JSON.stringify(f.requests.verifies).includes('private-form-value'), false);
  assert.deepEqual(f.get().policy.riskRules, BROWSER_RISK_RULES);
  const next = await newRunner.runOneRound('run'); assert.equal(next.reason, 'needs_user');
  f.resume(first.pendingApproval!.approvalRef); await newRunner.runOneRound('run'); assert.equal(f.calls.execute, 1);
  if (command.operation === 'submit') assert.equal(f.controller.getState().submitCount, 1);
});
test('approval after visible state change produces no submit', async () => {
  const f = browserFixture({ operation: 'submit', targetId: 'submit-button' }); const first = await f.runner.runOneRound('run');
  f.controller.setContent('Changed after approval request.'); f.resume(first.pendingApproval!.approvalRef); await f.runner.runOneRound('run');
  assert.equal(f.controller.getState().submitCount, 0); assert.equal(Object.values(f.get().tasks)[0].status, 'FAILED');
});
test('DENY remains denied despite user authorization', async () => {
  const f = browserFixture({ operation: 'submit', targetId: 'submit-button' }, { 'browser.submit': 'DENY' });
  f.add('WorkflowSuspended', {}); f.resume('any-authorization'); await f.runner.runOneRound('run');
  assert.equal(f.calls.execute, 0); assert.equal(f.controller.getState().submitCount, 0);
});
test('observation caps all text, controls, and options and redacts form values', async () => {
  const f = browserFixture(); const snapshot = await f.driver.inspect();
  snapshot.textBlocks = Array.from({ length: 60 }, () => 'x'.repeat(1100));
  snapshot.targets = Array.from({ length: 101 }, (_, i) => ({ targetId: `target-${i}`, role: 'combobox', label: 'x'.repeat(1100), value: 'private-form-value', disabled: false, capabilities: ['read'], options: Array.from({ length: 51 }, () => 'y'.repeat(1100)) }));
  const obs = browserObservation(snapshot); assert.equal(obs.truncated, true); assert.equal(obs.textBlocks.length, 50); assert.equal(obs.controls.length, 100);
  const texts = [...obs.textBlocks, ...obs.controls.flatMap(c => [c.label, ...(c.options ?? [])])];
  assert.ok(texts.every(t => t.length <= 1000)); assert.ok(texts.reduce((n, s) => n + s.length, 0) <= 20000);
  assert.ok(obs.controls.every(t => t.options!.length <= 50)); assert.equal(JSON.stringify(obs).includes('private-form-value'), false);
});
test('missing evidence fails closed before verifier', async () => {
  const f = browserFixture(); f.evidenceStore.get = async () => undefined;
  await f.runner.runOneRound('run'); assert.equal(f.calls.verify, 0);
});
test('input evidence contains state references, never raw value', async () => {
  const f = browserFixture(); const a = await f.executor.prepare(proposal({ operation: 'input', targetId: 'query-input', value: 'private-input-value' }));
  const result = await f.executor.execute(a, executionContext); assert.equal(result.status, 'succeeded');
  const evidence = await Promise.all(result.evidenceRefs!.map(ref => f.evidenceStore.get(ref)));
  assert.equal(JSON.stringify(evidence).includes('private-input-value'), false); assert.equal(evidence[0]!.kind, 'browser.input.v1');
});
test('duplicate and disabled targets, mismatched capabilities reject during preparation', async () => {
  for (const variant of ['duplicate', 'disabled', 'role', 'navigation']) {
    const f = browserFixture(); const snapshot = await f.driver.inspect(); const target = snapshot.targets.find(t => t.targetId === 'preview-button')!;
    if (variant === 'duplicate') snapshot.targets.push(structuredClone(target));
    if (variant === 'disabled') target.disabled = true;
    if (variant === 'role') target.role = 'textbox';
    if (variant === 'navigation') target.capabilities.push('navigate');
    f.driver.inspect = async () => snapshot;
    await assert.rejects(f.executor.prepare(proposal({ operation: 'interact', targetId: 'preview-button', interaction: 'click' })));
  }
});
test('abort at driver dispatch boundary still establishes no side effect', async () => {
  const f = browserFixture(), abort = new AbortController(); const a = await f.executor.prepare(proposal({ operation: 'submit', targetId: 'submit-button' }));
  const submit = f.driver.submit.bind(f.driver);
  f.driver.submit = async (...args) => { abort.abort(); return submit(...args); };
  const result = await f.executor.execute(a, { ...executionContext, signal: abort.signal });
  assert.equal(result.errorCode, 'BROWSER_ABORTED_BEFORE_DISPATCH'); assert.equal(result.status, 'failed'); assert.equal(f.controller.getState().submitCount, 0);
});
test('observation projects only allowlisted fields, even if driver supplies extra HTML/metadata', async () => {
  const f = browserFixture(); const s = await f.driver.inspect();
  Object.assign(s.targets[0], { innerHTML: '<script>private-extra</script>', eventHandlers: 'private-handler', credential: 'private-credential' });
  const obs = JSON.stringify(browserObservation(s));
  for (const marker of ['innerHTML', 'eventHandlers', 'credential', 'private-']) assert.equal(obs.includes(marker), false);
});
