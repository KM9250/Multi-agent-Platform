import { waitForLeaseAvailability, terminateChild, terminationName } from './lease-fixture.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fork } from 'node:child_process';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fixture, fresh, usage, history, saveHistory, plain } from './durable-fixture.ts';

async function child(t: TestContext, path: string, mode: string) {
  if (mode !== 'read') await waitForLeaseAvailability(path);
  const process = fork(fileURLToPath(new URL('./durable-child.ts', import.meta.url)), [path, mode], {
    execArgv: ['--experimental-transform-types', '--loader', fileURLToPath(new URL('./ts-loader.mjs', import.meta.url))],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  let readyResolve!: () => void, resultResolve!: (v: any) => void, fail!: (error: Error) => void;
  const ready = new Promise<void>(resolve => { readyResolve = resolve; });
  const result = new Promise<any>((resolve, reject) => { resultResolve = resolve; fail = reject; });
  // Attach immediately so failures before the awaited ready signal are handled.
  void result.catch(() => {});
  const closed = new Promise<void>(resolve => process.on('exit', () => resolve()));
  const timer = setTimeout(() => { terminateChild(process); readyResolve(); fail(new Error('Child timed out')); }, 15000);
  process.on('error', error => { readyResolve(); fail(error); });
  process.on('message', (message: any) => {
    if (message.ready) readyResolve();
    else { clearTimeout(timer); resultResolve(message); }
  });
  process.on('exit', code => { clearTimeout(timer); readyResolve(); if (code) fail(new Error(`Child exited: ${code}`)); });
  t.after(async () => { clearTimeout(timer); if (process.exitCode === null && process.signalCode === null) terminateChild(process); await closed; });
  return { process, ready, result, closed };
}
for (const mode of ['before-commit', 'after-commit', 'checkpoint']) {
  test(`${terminationName} child at ${mode} preserves the correct durable boundary`, async t => {
    const f = fixture(t), e = usage(fresh());
    if (mode === 'checkpoint') f.store.append(e);
    f.release(); f.db.close();
    const c = await child(t, f.path, mode); await c.ready; c.process.send(e);
    assert.equal((await c.result).stage, mode); terminateChild(c.process); await c.closed;
    const reopened = await f.openOwned(), expected = mode === 'before-commit' ? 1 : 2;
    assert.equal(reopened.store.getSnapshot('run').events.length, expected);
    if (mode === 'checkpoint') assert.equal(reopened.store.loadCheckpoint('run'), undefined);
    // after-commit models loss of the API response; committed identity is retained on retry.
    const recovered = reopened.store.append(e); assert.equal(recovered.events.length, 2);
    assert.deepEqual(recovered.events[1], e);
  });
}
test('simultaneous processes on separate connections accept one append and reject the stale writer', async t => {
  const f = fixture(t); f.release(); f.db.close();
  const a = await child(t, f.path, 'append'), b = await child(t, f.path, 'append');
  await Promise.all([a.ready, b.ready]); a.process.send(usage(fresh(), 'a')); b.process.send(usage(fresh(), 'b'));
  const outcomes = await Promise.all([a.result, b.result]); await Promise.all([a.closed, b.closed]);
  assert.equal(outcomes.filter(o => !o.code).length, 1); assert.equal(outcomes.filter(o => ['SEQUENCE_CONFLICT','LEASE_HELD'].includes(o.code)).length, 1);
  const state = f.open().store.getSnapshot('run'); assert.equal(state.events.length, 2); assert.equal(state.run.usage.llmCalls, 1);
});
test('simultaneous idempotent resends converge to one committed event', async t => {
  const f = fixture(t); f.release(); f.db.close(); const e = usage(fresh());
  const a = await child(t, f.path, 'append'), b = await child(t, f.path, 'append'); await Promise.all([a.ready, b.ready]);
  a.process.send(e); b.process.send({ ...e, eventId: 'retry' });
  const outcomes = await Promise.all([a.result, b.result]); await Promise.all([a.closed, b.closed]);
  assert.ok(outcomes.some(o => !o.code));
  assert.ok(outcomes.every(o => !o.code || o.code === 'LEASE_HELD'));
  const resend = await child(t, f.path, 'append'); await resend.ready; resend.process.send(e);
  assert.equal((await resend.result).code, undefined); await resend.closed; assert.equal(f.open().store.getSnapshot('run').events.length, 2);
});
test('old checkpoint plus later events survives repeated fresh processes without multiplying projections', async t => {
  const f = fixture(t), expected = history(); f.store.createCheckpoint('run'); saveHistory(f.store, expected); f.release(); f.db.close();
  for (let n = 0; n < 3; n++) {
    const c = await child(t, f.path, 'read'); await c.ready; c.process.send({});
    assert.deepEqual((await c.result).snapshot, plain(expected)); await c.closed;
  }
});
