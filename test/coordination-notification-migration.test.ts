import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIGRATIONS } from '../services/coordination/durable/schema.ts';
import { DurableDatabase } from '../services/coordination/durable/db.ts';
import { recoveryExecutionFixture } from './recovery-execution-fixture.ts';
import { usage } from './durable-fixture.ts';
import { assertNotificationCrash, historicalNotificationDatabase, copyNotificationHistory, notificationContents, notificationChild, notificationProcessResult, notificationReady } from './notification-process-fixture.ts';
import { notificationProcessHost } from './notification-process-host.ts';
import { continuationFixture } from './continuation-fixture.ts';
import { RecoveryContinuationCoordinator } from '../services/coordination/durable/recoveryContinuationCoordinator.ts';

const baselineHashes = [
  '1081504f04e79db1588340ba0302991aeb42e3373b0edd9ba57810278e249566',
  'e260ee0f529e194487c363a3f13c965846165cfc0fba7577b8e221b331698189',
  '6586d8c14f895edf62d23612c4b4a67793a511e7c0f0eb064a944728cda7b94a',
  'e2ef99a787649bb2bc2e0107db24513c6189e98ee73b029bca53bfa80b5ef114',
  'a25bf6eba0319ee028c37c8b6406d96789384a54d8e052ff24c79c0eb0b787c8',
  'a05b168f32fa5f4bbe0402d5e25918b816fa7e32368819ec714365103a779b97',
  '1cbfc30fbe2ca6503482011f8c93e79e88683b342312496f95dce9652d04a526',
  'e5dce90128045fea17ac4a074fd75b28208312b96f788f88e38662a64f2fb724',
  'ce474da204af7f9b065f726847f20ab53ae8d2c5e42988a96e399df5fa5c39a4',
  'a5240937de47521e07a4c8ac716cf8db232f05a90ef9279b53b134076b42d3a2',
];
function complete(raw: DatabaseSync) {
  assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version, 11);
  assert.equal(raw.prepare('SELECT migration_id FROM schema_migrations WHERE schema_version=11').get()!.migration_id, '011_durable_notification_outbox');
  assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(raw.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
  for (const table of ['notification_sources', 'notification_capture_cursors', 'notification_deliveries', 'notification_stream_claims', 'notification_delivery_attempts', 'notification_delivery_receipts', 'notification_delivery_audit', 'notification_management_receipts', 'notification_migration_baselines'])
    assert.equal(raw.prepare('SELECT strict FROM pragma_table_list WHERE name=?').get(table)!.strict, 1, table);
}
test('MI-01: migration001–010 generated SQL is byte-identical to fixed c89b5cd baseline', () => {
  assert.deepEqual(MIGRATIONS.slice(0, 10).map(m => createHash('sha256').update(m.sql).digest('hex')), baselineHashes);
});
for (let version = 0; version <= 10; version++) test(`MI-01/MI-02: populated schema${version}→11 preserves business history without inventing notification or delivery history`, t => {
  const source = recoveryExecutionFixture(t);
  if (version >= 5) {
    source.settled(); source.reacquire();
    const plan = source.plan('DISCARD_SETTLED_RESPONSE'); source.authorize(plan); source.execute(plan);
  } else source.store.append(usage(source.store.getSnapshot('run'), 'legacy-nonmodel-usage'));
  const path = join(source.dir, `schema-${version}.sqlite`), raw = historicalNotificationDatabase(path, version);
  t.after(() => raw.close());
  const before = version ? copyNotificationHistory(source.raw, raw) : {};
  const db = new DurableDatabase({ path }); t.after(() => db.close());
  for (const [name, rows] of Object.entries(before)) {
    const columns = rows.length ? Object.keys(rows[0]) : raw.prepare(`PRAGMA table_info("${name}")`).all().map(row => String(row.name));
    assert.deepEqual(raw.prepare(`SELECT ${columns.map(column => `"${column}"`).join(',')} FROM "${name}" ORDER BY rowid`).all(), rows, name);
  }
  complete(raw);
  for (const table of ['notification_sources', 'notification_deliveries', 'notification_delivery_attempts', 'notification_delivery_receipts', 'notification_management_receipts'])
    assert.equal(raw.prepare(`SELECT count(*) n FROM ${table}`).get()!.n, 0, table);
  assert.equal(raw.prepare('SELECT count(*) n FROM notification_migration_baselines').get()!.n, version ? 1 : 0);
  const after = notificationContents(raw);
  const again = new DurableDatabase({ path }); again.close();
  assert.deepEqual(notificationContents(raw), after, 'DB reopen must neither capture nor deliver old history');
});
for (const boundary of ['before-ddl', 'after-ddl', 'after-baseline', 'before-commit', 'after-commit'])
  test(`MI-06/CR-D10: real SIGKILL migration011/${boundary} leaves complete v10 or complete v11`, async t => {
    const source = recoveryExecutionFixture(t); source.settled();
    const path = join(source.dir, 'v10.sqlite'), raw = historicalNotificationDatabase(path, 10);
    t.after(() => raw.close()); copyNotificationHistory(source.raw, raw);
    const before = notificationContents(raw), schemaBefore = raw.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all();
    const result = await notificationProcessResult(notificationChild([path, 'migration', boundary]));
    assertNotificationCrash(result, path, 'migration', boundary);
    const committed = boundary === 'after-commit';
    assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version, committed ? 11 : 10);
    if (!committed) {
      assert.deepEqual(notificationContents(raw), before);
      assert.deepEqual(raw.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all(), schemaBefore);
    }
    const db = new DurableDatabase({ path }); db.close(); complete(raw);
    assert.equal(raw.prepare('SELECT count(*) n FROM notification_sources').get()!.n, 0);
    assert.equal(raw.prepare('SELECT count(*) n FROM notification_migration_baselines').get()!.n, 1);
  });
test('MI-06/CR-D11: two independent migration processes create exactly one schema11 ledger', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'map-notification-migration-race-')), path = join(dir, 'db.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const raw = historicalNotificationDatabase(path, 10); t.after(() => raw.close());
  const children = [notificationChild([path, 'migration-race']), notificationChild([path, 'migration-race'])];
  const results = children.map(child => notificationProcessResult(child));
  await Promise.all(children.map(child => notificationReady(child)));
  children.forEach(child => child.send('go'));
  const completed = await Promise.all(results);
  for (const result of completed) { assert.equal(result.timedOut, false, result.stderr); assert.equal(result.code, 0, result.stderr); }
  assert.ok(completed.some(result => result.messages.some((value: any) => value.migration === 'COMPLETE')));
  const db = new DurableDatabase({ path }); db.close(); complete(raw);
  assert.equal(raw.prepare('SELECT count(*) n FROM schema_migrations WHERE schema_version=11').get()!.n, 1);
});
test('MI-06/CR-D11: DB Busy cannot partially install schema11 and a fresh process can retry', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'map-notification-migration-busy-')), path = join(dir, 'db.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const raw = historicalNotificationDatabase(path, 10); t.after(() => raw.close()); raw.exec('PRAGMA journal_mode=WAL');
  const before = notificationContents(raw); raw.exec('BEGIN IMMEDIATE');
  try {
    const result = await notificationProcessResult(notificationChild([path, 'migration-busy']));
    assert.equal(result.code, 0, result.stderr); assert.equal(result.timedOut, false, result.stderr);
    assert.deepEqual(notificationContents(raw), before);
  } finally { raw.exec('ROLLBACK'); }
  const retry = await notificationProcessResult(notificationChild([path, 'migration-open']));
  assert.equal(retry.code, 0, retry.stderr); complete(raw);
});
test('MI-07: actual fixed baseline v10 Runtime refuses schema11 without changing any row', async t => {
  const source = recoveryExecutionFixture(t); source.settled();
  const before = notificationContents(source.raw);
  const result = await notificationProcessResult(notificationChild([source.path, 'v10-open']));
  assert.equal(result.timedOut, false, result.stderr); assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(notificationContents(source.raw), before); complete(source.raw);
});

test('MI-02/MI-03/MI-04: legacy cancelled history never sends; explicit unresolved sync keeps original occurrence and is idempotent with HTTP0', t => {
  const dir = mkdtempSync(join(tmpdir(), 'map-notification-legacy-sync-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const current = notificationProcessHost(join(dir, 'source.sqlite')); t.after(() => current.close());
  const pending = current.create(); pending.block(); pending.release();
  const finished = current.create('cancelled'); finished.cancel(); finished.release();
  const oldOccurrence = current.raw.prepare("SELECT notification_id,occurred_at FROM notification_sources WHERE workflow_run_id='run'").get()!;
  const path = join(dir, 'legacy.sqlite'), raw = historicalNotificationDatabase(path, 10); t.after(() => raw.close());
  copyNotificationHistory(current.raw, raw);
  let sends = 0;
  const f = notificationProcessHost(path, undefined, { async send() { sends++; throw Error('sync must not send'); } }); t.after(() => f.close());
  assert.equal(raw.prepare('SELECT count(*) n FROM notification_sources').get()!.n, 0);
  const businessBefore = Object.fromEntries(Object.entries(notificationContents(raw)).filter(([name]) => !name.startsWith('notification_')));
  const baseline = raw.prepare("SELECT * FROM notification_migration_baselines WHERE workflow_run_id='run'").get()!;
  const command = { workflowRunId: 'run', ownerSubject: 'owner', destinationId: 'process-macp', expectedBaseline: String(baseline.baseline_digest), requestId: 'sync-once' };
  const first = f.db.notifications.syncUnresolved(f.human, command);
  const after = notificationContents(raw);
  assert.deepEqual(f.db.notifications.syncUnresolved(f.human, command), first);
  assert.deepEqual(notificationContents(raw), after);
  const sources = raw.prepare('SELECT * FROM notification_sources').all(); assert.equal(sources.length, 1);
  assert.equal(sources[0].notification_id, oldOccurrence.notification_id); assert.equal(sources[0].occurred_at, oldOccurrence.occurred_at);
  assert.equal(sources[0].capture_reason, 'LEGACY_UNRESOLVED_SYNC');
  assert.equal(raw.prepare('SELECT count(*) n FROM notification_deliveries').get()!.n, 0);
  const terminalBaseline = raw.prepare("SELECT * FROM notification_migration_baselines WHERE workflow_run_id='cancelled'").get()!;
  f.db.notifications.syncUnresolved(f.human, { ...command, workflowRunId: 'cancelled', expectedBaseline: String(terminalBaseline.baseline_digest), requestId: 'sync-cancelled' });
  assert.equal(raw.prepare('SELECT count(*) n FROM notification_sources').get()!.n, 1);
  assert.equal(sends, 0);
  assert.deepEqual(Object.fromEntries(Object.entries(notificationContents(raw)).filter(([name]) => !name.startsWith('notification_'))), businessBefore);
});
for (const boundary of ['before-commit', 'after-commit']) test(`MI-04/CR-D09: real SIGKILL legacy sync/${boundary} keeps Source and management receipt atomic`, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'map-notification-sync-crash-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = notificationProcessHost(join(dir, 'source.sqlite')); t.after(() => source.close());
  const workflow = source.create(); workflow.block(); workflow.release();
  const path = join(dir, 'legacy.sqlite'), raw = historicalNotificationDatabase(path, 10); t.after(() => raw.close()); copyNotificationHistory(source.raw, raw);
  const migrated = new DurableDatabase({ path }); migrated.close();
  const before = notificationContents(raw);
  const result = await notificationProcessResult(notificationChild([path, 'sync', boundary]));
  assertNotificationCrash(result, path, 'sync', boundary);
  const after = notificationContents(raw), committed = boundary === 'after-commit';
  if (!committed) assert.deepEqual(after, before);
  assert.equal(after.notification_sources.length, committed ? 1 : 0);
  assert.equal(after.notification_management_receipts.length, committed ? 1 : 0);
  assert.equal(after.notification_deliveries.length, 0);
  const retry = await notificationProcessResult(notificationChild([path, 'sync-run']));
  assert.equal(retry.code, 0, retry.stderr); assert.equal(retry.timedOut, false, retry.stderr);
  assert.equal(raw.prepare('SELECT count(*) n FROM notification_sources').get()!.n, 1);
  assert.equal(raw.prepare('SELECT count(*) n FROM notification_management_receipts').get()!.n, 1);
  if (committed) assert.deepEqual(notificationContents(raw), after);
  for (const [table, rows] of Object.entries(before)) if (!table.startsWith('notification_')) assert.deepEqual(notificationContents(raw)[table], rows, table);
});

test('MI-04: two independent explicit sync requests racing a new workflow cannot duplicate or hide post-migration capture', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'map-notification-sync-race-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = notificationProcessHost(join(dir, 'source.sqlite')); t.after(() => source.close());
  const workflow = source.create(); workflow.block(); workflow.release();
  const path = join(dir, 'legacy.sqlite'), raw = historicalNotificationDatabase(path, 10); t.after(() => raw.close()); copyNotificationHistory(source.raw, raw);
  const f = notificationProcessHost(path); t.after(() => f.close());
  const baseline = raw.prepare('SELECT * FROM notification_migration_baselines').get()!;
  const newWorkflow = f.create('postbaseline');
  const children = [notificationChild([path, 'sync-race']), notificationChild([path, 'sync-race'])];
  const results = children.map(child => notificationProcessResult(child)); await Promise.all(children.map(child => notificationReady(child)));
  children.forEach(child => child.send('go'));
  newWorkflow.cancel(); newWorkflow.release();
  const businessAfter = Object.fromEntries(Object.entries(notificationContents(raw)).filter(([name]) => !name.startsWith('notification_')));
  const completed = await Promise.all(results);
  for (const result of completed) { assert.equal(result.code, 0, result.stderr); assert.equal(result.timedOut, false, result.stderr); }
  assert.equal(raw.prepare("SELECT count(*) n FROM notification_sources WHERE kind='workflow_cancelled' AND capture_reason='ATOMIC_COMMIT'").get()!.n, 1);
  assert.equal(raw.prepare("SELECT count(*) n FROM notification_sources WHERE capture_reason='LEGACY_UNRESOLVED_SYNC'").get()!.n, 1);
  assert.equal(raw.prepare('SELECT count(*) n FROM notification_management_receipts').get()!.n, 1);
  assert.equal(raw.prepare('SELECT count(*) n FROM notification_deliveries').get()!.n, 0);
  assert.deepEqual(raw.prepare('SELECT * FROM notification_migration_baselines').get(), baseline);
  assert.deepEqual(Object.fromEntries(Object.entries(notificationContents(raw)).filter(([name]) => !name.startsWith('notification_'))), businessAfter);
});

test('MI-04: independent legacy sync racing authorized same-workflow plan revision preserves the new source and original baseline', async t => {
  const source = continuationFixture(t), originalPlan = source.api().createPlan(source.input(), source.credential);
  const original = await source.api().startAuthorized(originalPlan.planId, source.credential);
  assert.ok(original.artifact); source.manager.release(source.lease);
  const dir = mkdtempSync(join(tmpdir(), 'map-notification-same-workflow-sync-')), path = join(dir, 'legacy.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const raw = historicalNotificationDatabase(path, 10); t.after(() => raw.close()); copyNotificationHistory(source.raw, raw);
  const reopened = continuationFixture(t, {}, { dir, path, reopen: true });
  const lease = reopened.manager.acquire('run'), api = new RecoveryContinuationCoordinator(reopened.db, lease);
  const baseline = raw.prepare('SELECT * FROM notification_migration_baselines').get()!;
  const plan = api.requestRevision(original.artifact!, reopened.input(), reopened.credential);
  const children = [notificationChild([path, 'sync-race', '', '', 'operator']), notificationChild([path, 'sync-race', '', '', 'operator'])];
  const results = children.map(child => notificationProcessResult(child)); await Promise.all(children.map(child => notificationReady(child)));
  children.forEach(child => child.send('go'));
  const revised = await api.startAuthorized(plan.planId, reopened.credential);
  assert.ok(revised.artifact); assert.notEqual(revised.artifact!.artifactId, original.artifact!.artifactId);
  const businessAfter = Object.fromEntries(Object.entries(notificationContents(raw)).filter(([name]) => !name.startsWith('notification_')));
  for (const result of await Promise.all(results)) { assert.equal(result.code, 0, result.stderr); assert.equal(result.timedOut, false, result.stderr); }
  const atomic = raw.prepare("SELECT * FROM notification_sources WHERE capture_reason='ATOMIC_COMMIT'").all();
  assert.equal(atomic.length, 1); assert.equal(atomic[0].source_ref, revised.artifact!.artifactId);
  const legacy = raw.prepare("SELECT * FROM notification_sources WHERE capture_reason='LEGACY_UNRESOLVED_SYNC'").all();
  assert.ok(legacy.length <= 1); if (legacy.length) assert.equal(legacy[0].source_ref, original.artifact!.artifactId);
  assert.equal(raw.prepare('SELECT count(*) n FROM notification_management_receipts').get()!.n, 1);
  assert.equal(raw.prepare('SELECT count(*) n FROM notification_deliveries').get()!.n, 0);
  assert.deepEqual(raw.prepare('SELECT * FROM notification_migration_baselines').get(), baseline);
  assert.deepEqual(Object.fromEntries(Object.entries(notificationContents(raw)).filter(([name]) => !name.startsWith('notification_'))), businessAfter);
  assert.deepEqual(reopened.counts, { draft: 1, plan: 0, verify: 0, action: 0, prepare: 0 });
  reopened.manager.release(lease);
});
