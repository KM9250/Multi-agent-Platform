import test from 'node:test';
import assert from 'node:assert/strict';
import { notificationFixture } from './notification-outbox-fixture.ts';
import { DeliveryError } from '../services/coordination/notifications/deliveryError.ts';
import type { NotificationManagementCommand } from '../services/coordination/durable/notificationTypes.ts';

const page = (f: ReturnType<typeof notificationFixture>, id = 'run') => f.db.notifications.read(f.human, { workflowRunId: id });
const command = (row: ReturnType<typeof page>['items'][number], operation: NotificationManagementCommand['operation'], requestId: string): NotificationManagementCommand => ({
  operation, workflowRunId: row.workflowRunId, deliveryId: row.deliveryId!, ownerSubject: 'owner',
  destinationId: row.destinationId!, expectedRevision: row.revision, requestId, reason: 'OPERATOR_REQUEST',
});

test('SO-15/SO-16/MI-05: routing absence preserves business and Source; explicit later materialization is unique and sends nothing', async t => {
  const f = notificationFixture(t), binding = f.binding; f.binding = undefined;
  const workflow = f.create(); workflow.append('WorkflowCancelled', { reason: 'private-reason' }); workflow.release();
  const business = f.business();
  assert.equal(f.raw.prepare('SELECT count(*) n FROM notification_sources').get()!.n, 1);
  assert.equal(page(f).items[0].state, 'UNROUTED');
  await f.db.notifications.materialize(f.service, { workflowRunId: 'run' });
  assert.equal(f.raw.prepare('SELECT count(*) n FROM notification_deliveries').get()!.n, 0);
  f.binding = binding;
  await f.db.notifications.materialize(f.service, { workflowRunId: 'run' });
  await f.db.notifications.materialize(f.service, { workflowRunId: 'run' });
  assert.equal(f.raw.prepare('SELECT count(*) n FROM notification_deliveries').get()!.n, 1);
  assert.equal(page(f).items[0].state, 'PENDING');
  assert.equal(f.packets.length, 0); assert.deepEqual(f.business(), business);
});

test('DL-01/DL-23: only explicit runOnce sends; MACP receipt preserves all business tables and Runtime Lease', async t => {
  const f = notificationFixture(t), w = f.create(); w.append('WorkflowCancelled', { reason: 'secret-data' }); w.release();
  const business = f.business(), other = f.open();
  other.notifications.read(f.human, { workflowRunId: 'run' });
  assert.equal(f.packets.length, 0);
  await f.db.notifications.runOnce(f.service, { workflowRunId: 'run' });
  const result = page(f).items[0];
  assert.equal(result.state, 'DELIVERED'); assert.equal(result.attempts, 1);
  assert.equal(result.receipts.length, 1); assert.equal(result.executionAllowed, false);
  assert.equal(f.packets.length, 1); assert.equal(JSON.stringify(f.packets).includes('secret-data'), false);
  await f.db.notifications.runOnce(f.service, { workflowRunId: 'run' });
  assert.equal(f.packets.length, 1); assert.deepEqual(f.business(), business);
});

test('DL-02/DL-10/SO-18: uncertain failure survives connection restart and retries byte-identical packet with the original ID and Realm', async t => {
  const f = notificationFixture(t), w = f.create(); w.append('WorkflowCancelled', { reason: 'local-test' }); w.release();
  const before = f.business();
  f.hooks.send = async () => { throw new DeliveryError('NETWORK_ERROR', true); };
  await f.db.notifications.runOnce(f.service, { workflowRunId: 'run' });
  const first = page(f).items[0]; assert.equal(first.state, 'RETRY_WAIT'); assert.equal(first.outcomeUnknown, true);
  assert.equal(first.attempts, 1); assert.ok(first.nextAttemptAt !== null);
  f.hooks.send = undefined;
  const reopened = f.open(); await reopened.notifications.runOnce(f.service, { workflowRunId: 'run' });
  const final = page(f).items[0]; assert.equal(final.state, 'DELIVERED'); assert.equal(final.attempts, 2);
  assert.equal(final.notificationId, first.notificationId); assert.equal(final.receiverRealm, first.receiverRealm);
  assert.deepEqual(f.packets[1], f.packets[0]); assert.deepEqual(f.business(), before);
});

for (const status of [400, 401, 403, 404, 409, 422]) test(`DL-11: HTTP ${status} stops automatic delivery without changing ID or business`, async t => {
  const f = notificationFixture(t), w = f.create(); w.append('WorkflowCancelled', { reason: 'local-test' }); w.release();
  f.hooks.send = async () => { throw new DeliveryError('HTTP_ERROR', false, status); };
  const business = f.business();
  await f.db.notifications.runOnce(f.service, { workflowRunId: 'run' });
  const first = page(f).items[0]; assert.ok(['PAUSED', 'DELIVERY_FAILED'].includes(first.state));
  await f.db.notifications.runOnce(f.service, { workflowRunId: 'run' });
  assert.equal(f.packets.length, 1); assert.equal(page(f).items[0].notificationId, first.notificationId);
  assert.deepEqual(f.business(), business);
});

test('DL-15/DL-16: resolved never-sent source and unknown prior send have different terminal meanings', async t => {
  for (const sent of [false, true]) {
    const f = notificationFixture(t), w = f.create(); w.append('WorkflowBlocked', { reason: 'needs-human-attention' });
    await f.db.notifications.materialize(f.service, { workflowRunId: 'run' });
    if (sent) { f.hooks.send = async () => { throw new DeliveryError('TIMEOUT', true); }; await f.db.notifications.runOnce(f.service, { workflowRunId: 'run' }); }
    w.append('WorkflowCancelled', { reason: 'resolved-by-business' }); w.release();
    f.hooks.send = undefined;
    await f.db.notifications.runOnce(f.service, { workflowRunId: 'run' });
    const result = page(f).items.find(row => row.kind === 'workflow_attention_required')!;
    assert.equal(result.state, sent ? 'CLOSED_UNCONFIRMED' : 'SUPPRESSED');
    assert.equal(result.outcomeUnknown, sent);
  }
});

test('AU-D06/DL-18: pause and close are idempotent notification-only management operations', async t => {
  const f = notificationFixture(t), w = f.create(); w.append('WorkflowCancelled', { reason: 'local-test' }); w.release();
  await f.db.notifications.materialize(f.service, { workflowRunId: 'run' });
  const business = f.business(), pause = command(page(f).items[0], 'PAUSE', 'pause-1');
  await f.db.notifications.manage(f.human, pause);
  const paused = page(f).items[0]; assert.equal(paused.state, 'PAUSED');
  await f.db.notifications.manage(f.human, pause);
  assert.equal(page(f).items[0].revision, paused.revision);
  await f.db.notifications.runOnce(f.service, { workflowRunId: 'run' }); assert.equal(f.packets.length, 0);
  await f.db.notifications.manage(f.human, command(paused, 'CLOSE', 'close-1'));
  assert.equal(page(f).items[0].state, 'SUPPRESSED'); assert.deepEqual(f.business(), business);
});

test('DL-21: automatic and lifetime attempts remain bounded across manual retry and restart', async t => {
  const f = notificationFixture(t, { limits: { automaticAttempts: 2, lifetimeAttempts: 3, backoffBaseMs: 0, backoffMaxMs: 0 } });
  const w = f.create(); w.append('WorkflowCancelled', { reason: 'local-test' }); w.release();
  f.hooks.send = async () => { throw new DeliveryError('NETWORK_ERROR', true); };
  for (let i = 0; i < 4; i++) await f.db.notifications.runOnce(f.service, { workflowRunId: 'run' });
  assert.equal(f.packets.length, 2);
  await f.db.notifications.manage(f.human, command(page(f).items[0], 'RETRY', 'retry-1'));
  await f.open().notifications.runOnce(f.service, { workflowRunId: 'run' });
  assert.equal(page(f).items[0].attempts, 3); assert.equal(f.packets.length, 3);
  await assert.rejects(async () => f.db.notifications.manage(f.human, command(page(f).items[0], 'RETRY', 'retry-2')));
  assert.equal(f.packets.length, 3);
});

test('DL-13/MC-D07: a paused stream does not stop a different workflow', async t => {
  const f = notificationFixture(t);
  for (const id of ['first', 'second']) { const w = f.create(id); w.append('WorkflowCancelled', { reason: 'local-test' }); w.release(); }
  await f.db.notifications.materialize(f.service, { workflowRunId: 'first' });
  await f.db.notifications.manage(f.human, command(page(f, 'first').items[0], 'PAUSE', 'pause-first'));
  await f.db.notifications.runOnce(f.service, { workflowRunId: 'first' });
  await f.db.notifications.runOnce(f.service, { workflowRunId: 'second' });
  assert.equal(page(f, 'first').items[0].state, 'PAUSED'); assert.equal(page(f, 'second').items[0].state, 'DELIVERED');
  assert.equal(f.packets.length, 1);
});
