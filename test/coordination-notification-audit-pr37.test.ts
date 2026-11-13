import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { DurableDatabase } from '../services/coordination/durable/db.ts';
import type { NotificationPermission } from '../services/coordination/durable/notificationTypes.ts';
import { notificationFixture } from './notification-outbox-fixture.ts';
import { historicalNotificationDatabase, copyNotificationHistory, notificationContents } from './notification-process-fixture.ts';
import { MIGRATIONS } from '../services/coordination/durable/schema.ts';

const deliveryPermissions = new Set<NotificationPermission>([
  'MATERIALIZE_NOTIFICATION', 'CLAIM_NOTIFICATION_DELIVERY', 'SEND_NOTIFICATION', 'COLLECT_NOTIFICATION_RECEIPT',
]);
const cycle = (operation: 'MATERIALIZE' | 'RUN_ONCE', workflowRunId = 'run') => ({
  workflowRunId, operation, code: 'NOTIFICATION_SERVICE_CYCLE_COMPLETE', executionAllowed: false,
});
function legacyFixture(t: TestContext) {
  const host = notificationFixture(t);
  for (const id of ['short', 'long']) {
    const w = host.create(id);
    if (id === 'long') w.append('ProgressRecorded', { outcome: 'PROGRESS', summary: 'synthetic' });
    w.append('WorkflowBlocked', { reason: 'USER_ATTENTION_REQUIRED' });
    if (id === 'long') w.append('WorkflowCancelled', { reason: 'synthetic' });
    w.release();
  }
  const path = join(host.dir, 'actual-v10.sqlite'), raw = historicalNotificationDatabase(path, 10);
  const historical = copyNotificationHistory(host.raw, raw);
  assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version, 10);
  const db = new DurableDatabase({ path, notifications: host.options });
  t.after(() => { db.close(); raw.close(); });
  assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version, 11);
  for (const [name, rows] of Object.entries(historical)) assert.deepEqual(raw.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all(), rows, name);
  const all = () => notificationContents(raw);
  const business = () => Object.fromEntries(Object.entries(all()).filter(([name]) => !name.startsWith('notification_')));
  return { host, db, raw, all, business };
}

test('PR37 RT-01: migrated workflows with different hidden history return identical ordinary VIEW pages without baseline fingerprints', t => {
  const f = legacyFixture(t), before = f.all();
  const baselines = f.raw.prepare('SELECT * FROM notification_migration_baselines ORDER BY workflow_run_id').all();
  assert.equal(baselines.length, 2); assert.notEqual(baselines[0].journal_sequence, baselines[1].journal_sequence);
  assert.notEqual(baselines[0].baseline_digest, baselines[1].baseline_digest);
  assert.notEqual(JSON.parse(String(baselines[0].occurrence_ids_json)).length, JSON.parse(String(baselines[1].occurrence_ids_json)).length);
  f.host.hooks.authorize = access => access.permission === 'VIEW_NOTIFICATION' && access.ownerSubject === null;
  f.host.outputs.length = 0;
  try {
    const short = f.db.notifications.read(f.host.human, { workflowRunId: 'short' });
    const long = f.db.notifications.read(f.host.human, { workflowRunId: 'long' });
    assert.deepEqual(long, short);
    assert.ok(!Object.hasOwn(short, 'baseline')); assert.equal(short.items.length, 0);
    const output = JSON.stringify([short, long, f.host.outputs]);
    assert.ok(!output.includes('journalSequence'));
    for (const baseline of baselines) assert.ok(!output.includes(String(baseline.baseline_digest)));
  } finally {
    assert.equal(f.host.packets.length, 0); assert.deepEqual(f.all(), before);
  }
});

test('PR37 RT-01: explicit sync baseline preserves migration identity, authorized sync and hidden-row Reader non-disclosure', t => {
  const f = legacyFixture(t), before = f.all(), business = f.business();
  const input = { workflowRunId: 'short', ownerSubject: 'owner', destinationId: 'local-macp' };
  const original = f.host.raw.prepare("SELECT * FROM notification_sources WHERE workflow_run_id='short'").get()!;
  // The dedicated read needs SYNC, not general VIEW; it writes nothing and sends nothing.
  f.host.hooks.authorize = a => a.permission === 'SYNC_UNRESOLVED_NOTIFICATIONS' && a.workflowRunId === 'short'
    && (a.ownerSubject === null || a.ownerSubject === 'owner') && (a.destinationId === null || a.destinationId === 'local-macp');
  const baseline = f.db.notifications.readSyncBaseline(f.host.human, input);
  assert.deepEqual(baseline, { ...input, baseline: { digest: before.notification_migration_baselines.find(r => r.workflow_run_id === 'short')!.baseline_digest, journalSequence: 2 }, executionAllowed: false });
  assert.deepEqual(f.all(), before); assert.equal(f.host.packets.length, 0);
  f.host.hooks.authorize = () => true;
  const command = { ...input, expectedBaseline: baseline.baseline!.digest, requestId: 'explicit-sync' };
  const page = f.db.notifications.syncUnresolved(f.host.human, command);
  assert.equal(page.items.length, 1); assert.equal(page.items[0].notificationId, original.notification_id);
  const source = f.raw.prepare('SELECT * FROM notification_sources').get()!;
  for (const key of ['source_id', 'notification_id', 'source_ref', 'source_version', 'source_digest', 'occurred_at']) assert.equal(source[key], original[key], key);
  assert.equal(source.capture_reason, 'LEGACY_UNRESOLVED_SYNC');
  assert.equal(f.raw.prepare('SELECT count(*) n FROM notification_deliveries').get()!.n, 0);
  const synced = f.all(); assert.deepEqual(f.db.notifications.syncUnresolved(f.host.human, command), page); assert.deepEqual(f.all(), synced);
  assert.deepEqual(f.business(), business); assert.deepEqual(f.all().notification_migration_baselines, before.notification_migration_baselines);
  assert.equal(f.host.packets.length, 0);
  f.db.notifications.materialize(f.host.service, { workflowRunId: 'short' });
  const materialized = f.all(); f.host.outputs.length = 0;
  f.host.hooks.authorize = a => a.permission === 'VIEW_NOTIFICATION' && a.recipientSubject !== 'owner';
  const hidden = f.db.notifications.read(f.host.human, { workflowRunId: 'short' });
  assert.deepEqual(hidden, f.db.notifications.read(f.host.human, { workflowRunId: 'long' }));
  assert.equal(hidden.items.length, 0); assert.equal(hidden.summary.sourceCount, 0); assert.equal(hidden.nextCursor, null);
  assert.throws(() => f.db.notifications.readSyncBaseline(f.host.human, input), { code: 'NOTIFICATION_UNAUTHORIZED' });
  const publicOutput = JSON.stringify([hidden, f.host.outputs]);
  assert.ok(!publicOutput.includes(String(original.notification_id))); assert.ok(!publicOutput.includes(baseline.baseline!.digest));
  assert.ok(!publicOutput.includes('journalSequence')); assert.equal(f.host.packets.length, 0); assert.deepEqual(f.all(), materialized);
});

for (const refusal of ['NO_SYNC', 'WORKFLOW', 'OWNER', 'DESTINATION', 'ROW_OWNER', 'OUTPUT', 'REVOKED_DURING_OUTPUT', 'REGISTRY_CHANGED'] as const)
test(`PR37 RT-01: sync baseline ${refusal} refuses before disclosure with all tables and HTTP unchanged`, t => {
  const f = legacyFixture(t), before = f.all();
  const input = { workflowRunId: 'short', ownerSubject: 'owner', destinationId: 'local-macp' };
  if (refusal === 'OWNER') input.ownerSubject = 'foreign';
  if (refusal === 'DESTINATION') input.destinationId = 'foreign';
  f.host.hooks.authorize = a => a.permission !== 'SYNC_UNRESOLVED_NOTIFICATIONS' || !(
    refusal === 'NO_SYNC' || refusal === 'WORKFLOW' && a.workflowRunId === 'short' || refusal === 'ROW_OWNER' && a.ownerSubject === 'owner');
  f.host.hooks.output = (a, value) => {
    if (a.permission !== 'SYNC_UNRESOLVED_NOTIFICATIONS') return true;
    if (refusal === 'REVOKED_DURING_OUTPUT') f.host.denied.add('SYNC_UNRESOLVED_NOTIFICATIONS');
    if (refusal === 'REGISTRY_CHANGED') f.host.binding = { ...f.host.binding!, receiverRealm: 'another-realm' };
    // Mutating the policy's copy must never rewrite the returned DTO.
    if (value && typeof value === 'object') Object.assign(value, { executionAllowed: true });
    return refusal !== 'OUTPUT';
  };
  assert.throws(() => f.db.notifications.readSyncBaseline(f.host.human, input), error =>
    error instanceof Error && ['NOTIFICATION_UNAUTHORIZED', 'NOTIFICATION_UNAVAILABLE'].includes(error.message));
  assert.equal(f.host.packets.length, 0); assert.deepEqual(f.all(), before);
  if (['NO_SYNC', 'WORKFLOW', 'OWNER', 'DESTINATION', 'ROW_OWNER'].includes(refusal)) assert.equal(f.host.outputs.length, 0);
});

test('PR37 RT-01: baseline read checks current OUTPUT on replay and returns an unmodified safe copy', t => {
  const f = legacyFixture(t), input = { workflowRunId: 'short', ownerSubject: 'owner', destinationId: 'local-macp' }, before = f.all();
  f.host.hooks.output = (_a, value) => { if (value && typeof value === 'object') Object.assign(value, { executionAllowed: true, injected: 'private' }); return true; };
  const value = f.db.notifications.readSyncBaseline(f.host.human, input);
  assert.equal(value.executionAllowed, false); assert.equal(Object.hasOwn(value, 'injected'), false);
  f.host.hooks.allowOutput = false;
  assert.throws(() => f.db.notifications.readSyncBaseline(f.host.human, input), { code: 'NOTIFICATION_UNAUTHORIZED' });
  assert.deepEqual(f.all(), before); assert.equal(f.host.packets.length, 0);
});

for (const revoked of ['SEND_NOTIFICATION', 'COLLECT_NOTIFICATION_RECEIPT', 'OUTPUT'] as const)
test(`PR37 F-01: delivery-only Service ${revoked} withdrawal after Claim commits cannot reach HTTP or business writes`, async t => {
  const f = notificationFixture(t), w = f.create(); w.append('WorkflowCancelled', { reason: 'synthetic' }); w.release();
  let committed = false;
  f.hooks.authorize = a => a.actor.kind !== 'SERVICE' || deliveryPermissions.has(a.permission) && !(committed && a.permission === revoked);
  f.hooks.output = a => a.actor.kind !== 'SERVICE' || !(committed && revoked === 'OUTPUT');
  f.db.notifications.materialize(f.service, { workflowRunId: 'run' });
  const before = f.allTables(), business = f.business(), exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function(sql: string) {
    const result = exec.call(this, sql);
    if (sql === 'COMMIT' && !committed && Number(this.prepare('SELECT count(*) n FROM notification_delivery_attempts').get()!.n) === 1) committed = true;
    return result;
  };
  try {
    const pending = f.db.notifications.runOnce(f.service, { workflowRunId: 'run' });
    if (revoked === 'SEND_NOTIFICATION') assert.deepEqual(await pending, cycle('RUN_ONCE'));
    else await assert.rejects(pending, { code: 'NOTIFICATION_UNAUTHORIZED' });
  } finally { DatabaseSync.prototype.exec = exec; }
  assert.equal(committed, true); assert.equal(f.packets.length, 0); assert.deepEqual(f.business(), business);
  const after = f.allTables();
  for (const name of ['notification_sources', 'notification_migration_baselines', 'notification_management_receipts']) assert.deepEqual(after[name], before[name]);
  assert.equal(after.notification_delivery_receipts.length, 0); assert.equal(after.notification_delivery_attempts.length, 1);
  const collectDenied = revoked === 'COLLECT_NOTIFICATION_RECEIPT';
  assert.equal(after.notification_delivery_attempts[0].state, collectDenied ? 'SENDING' : 'NOT_SENT_PROVEN');
  assert.equal(after.notification_deliveries[0].state, collectDenied ? 'SENDING' : 'PAUSED');
  assert.equal(after.notification_delivery_audit.length, before.notification_delivery_audit.length + (collectDenied ? 1 : 2));
});

test('PR37 F-01: service cycle OUTPUT stays mandatory, while VIEW/AUDIT remain independent human permissions', async t => {
  const f = notificationFixture(t), w = f.create(); w.append('WorkflowCancelled', { reason: 'synthetic' }); w.release();
  f.hooks.authorize = a => a.actor.kind === 'SERVICE' ? deliveryPermissions.has(a.permission) : a.permission === 'VIEW_NOTIFICATION';
  f.hooks.output = (a, value) => {
    if (a.actor.kind === 'SERVICE' && value && typeof value === 'object' && Object.hasOwn(value, 'code')) {
      Object.assign(value, { items: ['injected'], executionAllowed: true });
    }
    return true;
  };
  assert.deepEqual(await f.db.notifications.runOnce(f.service, { workflowRunId: 'run' }), cycle('RUN_ONCE'));
  assert.equal(f.db.notifications.read(f.human, { workflowRunId: 'run' }).items[0].state, 'DELIVERED');
  const before = f.allTables();
  assert.throws(() => f.db.notifications.read(f.human, { workflowRunId: 'run', includeAudit: true }), { code: 'NOTIFICATION_UNAUTHORIZED' });
  f.hooks.output = (a, value) => !(a.actor.kind === 'SERVICE' && value && typeof value === 'object' && Object.hasOwn(value, 'code'));
  await assert.rejects(f.db.notifications.runOnce(f.service, { workflowRunId: 'run' }), { code: 'NOTIFICATION_UNAUTHORIZED' });
  assert.deepEqual(f.allTables(), before); assert.equal(f.packets.length, 1);
});

for (const branch of ['NO_SOURCE', 'NO_ROUTE', 'DISABLED', 'ABORTED', 'PAUSED'] as const)
test(`PR37 F-01: ${branch} service cycle returns no Reader data and sends nothing without VIEW`, async t => {
  const f = notificationFixture(t, branch === 'DISABLED' ? { enabled: false } : {}), w = f.create();
  if (branch !== 'NO_SOURCE') w.append('WorkflowCancelled', { reason: 'synthetic' }); w.release();
  f.hooks.authorize = a => a.actor.kind !== 'SERVICE' || deliveryPermissions.has(a.permission);
  if (branch === 'NO_ROUTE') f.binding = undefined;
  if (branch === 'PAUSED') {
    f.db.notifications.materialize(f.service, { workflowRunId: 'run' });
    const v = f.db.notifications.read(f.human, { workflowRunId: 'run' }).items[0];
    f.db.notifications.manage(f.human, { workflowRunId: 'run', deliveryId: v.deliveryId!, ownerSubject: 'owner', destinationId: v.destinationId!, expectedRevision: v.revision, requestId: 'pause', operation: 'PAUSE', reason: 'OPERATOR_REQUEST' });
  }
  const business = f.business();
  assert.deepEqual(await f.db.notifications.runOnce(f.service, { workflowRunId: 'run', ...(branch === 'ABORTED' ? { signal: AbortSignal.abort() } : {}) }), cycle('RUN_ONCE'));
  assert.equal(f.packets.length, 0); assert.deepEqual(f.business(), business);
  assert.equal(f.raw.prepare('SELECT count(*) n FROM notification_delivery_attempts').get()!.n, 0);
});

test('PR37 migration011 generated SQL stays byte-identical to audited HEAD alongside existing001–010 hashes', () => {
  assert.equal(createHash('sha256').update(MIGRATIONS[10].sql).digest('hex'), 'a7563451450fea30fcfdc783f3bb542977d08055fd4ef9e1607e9c611b8ee0c7');
});

test('PR37 F-01: delivery-only Service sends once, preserves business tables and cannot read detail or audit across restart', async t => {
  const f = notificationFixture(t), w = f.create(); w.append('WorkflowCancelled', { reason: 'synthetic' }); w.release();
  f.hooks.authorize = access => access.actor.kind === 'SERVICE' ? deliveryPermissions.has(access.permission) : true;
  const business = f.business();
  try {
    assert.deepEqual(await f.db.notifications.runOnce(f.service, { workflowRunId: 'run' }), cycle('RUN_ONCE'));
    assert.equal(f.packets.length, 1);
    assert.equal(f.raw.prepare('SELECT count(*) n FROM notification_delivery_receipts').get()!.n, 1);
    assert.equal(f.raw.prepare('SELECT count(*) n FROM notification_delivery_attempts').get()!.n, 1);
    assert.equal(f.calls.some(access => access.actor.kind === 'SERVICE' && ['VIEW_NOTIFICATION', 'VIEW_DELIVERY_AUDIT'].includes(access.permission)), false);
    for (const includeAudit of [false, true]) assert.throws(() => f.db.notifications.read(f.service, { workflowRunId: 'run', includeAudit }), { code: 'NOTIFICATION_UNAUTHORIZED' });
    const page = f.db.notifications.read(f.human, { workflowRunId: 'run', includeAudit: true });
    assert.equal(page.items[0].state, 'DELIVERED'); assert.equal(page.items[0].receipts.length, 1); assert.ok(page.items[0].audit!.length > 0);
    const recorded = f.allTables(), reopened = f.open();
    assert.deepEqual(await reopened.notifications.runOnce(f.service, { workflowRunId: 'run' }), cycle('RUN_ONCE'));
    assert.deepEqual(reopened.notifications.materialize(f.service, { workflowRunId: 'run' }), cycle('MATERIALIZE'));
    assert.equal(f.packets.length, 1); assert.deepEqual(f.allTables(), recorded);
    assert.deepEqual(reopened.notifications.read(f.human, { workflowRunId: 'run', includeAudit: true }), page);
  } finally {
    assert.deepEqual(f.business(), business);
    t.diagnostic(JSON.stringify({ transportCalls: f.packets.length,
      deliveries: f.raw.prepare('SELECT count(*) n FROM notification_deliveries').get()!.n,
      attempts: f.raw.prepare('SELECT count(*) n FROM notification_delivery_attempts').get()!.n,
      receipts: f.raw.prepare('SELECT count(*) n FROM notification_delivery_receipts').get()!.n }));
  }
});
