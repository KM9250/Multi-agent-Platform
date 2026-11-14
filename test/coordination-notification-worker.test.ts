import test from 'node:test';
import assert from 'node:assert/strict';
import { DurableNotificationWorker } from '../services/coordination/durable/notificationDeliveryWorker.ts';
import { notificationFixture } from './notification-outbox-fixture.ts';

test('DL-22/DL-23: constructor is inert; concurrent runOnce shares one bounded cycle and business tables stay unchanged', async t => {
  const f = notificationFixture(t);
  for (const id of ['one', 'two', 'three']) { const w = f.create(id); w.append('WorkflowCancelled', { reason: 'local-test' }); w.release(); }
  const before = f.business(), worker = new DurableNotificationWorker(f.db.notifications, f.service, { workflowRunIds: ['one', 'two', 'three'] });
  assert.equal(f.packets.length, 0);
  const first = worker.runOnce(); assert.equal(worker.runOnce(), first);
  assert.deepEqual(await first, { completed: 3, failed: 0, nextCursor: 0 }); assert.equal(f.packets.length, 3);
  assert.deepEqual(f.business(), before); assert.deepEqual(await worker.stop(), { drained: true });
});

test('DL-23: explicit start sends and finite stop prevents claiming queued workflows', async t => {
  const f = notificationFixture(t, { limits: { concurrency: 1, httpTimeoutMs: 100, claimTtlMs: 1200 } });
  for (const id of ['one', 'two']) { const w = f.create(id); w.append('WorkflowCancelled', { reason: 'local-test' }); w.release(); }
  let started!: () => void; const sending = new Promise<void>(resolve => { started = resolve; });
  f.hooks.send = () => { started(); return new Promise(() => {}); };
  const worker = new DurableNotificationWorker(f.db.notifications, f.service, { workflowRunIds: ['one', 'two'], pollIntervalMs: 100 });
  worker.start(); await sending;
  const before = performance.now(), stopped = await worker.stop(1000);
  assert.ok(performance.now() - before < 1200); assert.equal(stopped.drained, true);
  assert.equal(f.packets.length, 1);
  assert.deepEqual(await worker.runOnce(), { completed: 0, failed: 0, nextCursor: 1 });
  assert.equal(f.raw.prepare("SELECT count(*) n FROM notification_delivery_attempts WHERE workflow_run_id='two'").get()!.n, 0);
});

test('DL-22: worker scan respects bounded batch and advances an explicit continuation cursor', async t => {
  const f = notificationFixture(t, { limits: { batchSize: 1 } });
  for (const id of ['one', 'two', 'three']) { const w = f.create(id); w.append('WorkflowCancelled', { reason: 'local-test' }); w.release(); }
  const worker = new DurableNotificationWorker(f.db.notifications, f.service, { workflowRunIds: ['one', 'two', 'three'], cursor: 2 });
  assert.deepEqual(await worker.runOnce(), { completed: 1, failed: 0, nextCursor: 0 });
  assert.equal(f.packets.length, 1);
  assert.deepEqual(await worker.runOnce(), { completed: 1, failed: 0, nextCursor: 1 });
  assert.equal(f.packets.length, 2);
  await worker.stop();
});
