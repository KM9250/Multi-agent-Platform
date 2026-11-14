import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { notificationProcessHost } from './notification-process-host.ts';
import { assertNotificationCrash, notificationChild, notificationContents, notificationHttpReceiver, notificationProcessResult } from './notification-process-fixture.ts';

const business = (contents: ReturnType<typeof notificationContents>) => Object.fromEntries(Object.entries(contents).filter(([name]) => !name.startsWith('notification_')));
const httpCount = (dir: string) => existsSync(join(dir, 'http.txt')) ? readFileSync(join(dir, 'http.txt'), 'utf8').trim().split('\n').length : 0;
for (const boundary of ['before-commit', 'after-commit']) test(`SO-02/CR-D01: real SIGKILL business+source/${boundary} preserves atomicity and restart makes zero HTTP calls`, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'map-notification-source-crash-')), path = join(dir, 'db.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = await notificationProcessResult(notificationChild([path, 'source', boundary]));
  assertNotificationCrash(result, path, 'source', boundary);
  const raw = new DatabaseSync(path); t.after(() => raw.close());
  const before = JSON.parse(readFileSync(join(dir, 'before.json'), 'utf8')) as ReturnType<typeof notificationContents>;
  const after = notificationContents(raw), committed = boundary === 'after-commit';
  if (!committed) assert.deepEqual(after, before, 'source fault must roll back every table');
  else {
    assert.equal(after.journal_events.length, before.journal_events.length + 1);
    assert.equal(after.notification_sources.length, 1);
    assert.equal(after.notification_sources[0].kind, 'workflow_cancelled');
    assert.equal(after.notification_delivery_audit.length, before.notification_delivery_audit.length + 1);
    // The original business append also atomically creates its existing JOURNAL_APPENDED audit.
    assert.deepEqual(after.runtime_audit_events.slice(0, -1), before.runtime_audit_events);
    assert.equal(after.runtime_audit_events.at(-1)!.event_kind, 'JOURNAL_APPENDED');
    assert.equal(after.runtime_audit_events.at(-1)!.journal_event_id, after.journal_events.at(-1)!.event_id);
    for (const [table, rows] of Object.entries(business(before))) if (!['workflow_seeds', 'journal_events', 'runtime_audit_events'].includes(table))
      assert.deepEqual(after[table], rows, table);
  }
  assert.equal(httpCount(dir), 0);
  assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(), []);
  const restarted = await notificationProcessResult(notificationChild([path, 'inspect']));
  assert.equal(restarted.code, 0, restarted.stderr); assert.equal(restarted.timedOut, false, restarted.stderr);
  assert.deepEqual(notificationContents(raw), after, 'constructor/Reader cannot mutate or send');
  assert.equal(httpCount(dir), 0);
});

for (const mode of ['materialize', 'claim', 'receipt', 'manage']) for (const boundary of ['before-commit', 'after-commit'])
  test(`CR-D${{ materialize: '02', claim: '03', receipt: '06', manage: '09' }[mode]}: real SIGKILL ${mode}/${boundary} preserves atomic notification state and business tables`, async t => {
    const receiver = await notificationHttpReceiver(t);
    const dir = mkdtempSync(join(tmpdir(), 'map-notification-delivery-crash-')), path = join(dir, 'db.sqlite');
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const f = notificationProcessHost(path, receiver.endpoint); t.after(() => f.close());
    const workflow = f.create(); workflow.cancel(); workflow.release();
    if (mode !== 'materialize') f.db.notifications.materialize(f.service, { workflowRunId: 'run' });
    const before = notificationContents(f.raw);
    const result = await notificationProcessResult(notificationChild([path, mode, boundary, receiver.endpoint]));
    assertNotificationCrash(result, path, mode, boundary);
    const after = notificationContents(f.raw), committed = boundary === 'after-commit';
    assert.deepEqual(business(after), business(before));
    assert.deepEqual(f.raw.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(f.raw.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
    const delivery = after.notification_deliveries[0];
    if (mode === 'materialize') {
      assert.equal(after.notification_deliveries.length, committed ? 1 : 0);
      if (!committed) assert.deepEqual(after, before);
    } else if (mode === 'claim') {
      assert.equal(after.notification_delivery_attempts.length, committed ? 1 : 0);
      assert.equal(delivery.state, committed ? 'SENDING' : 'PENDING');
      assert.equal(delivery.attempt_count, committed ? 1 : 0);
      if (!committed) assert.deepEqual(after, before);
    } else if (mode === 'receipt') {
      assert.equal(after.notification_delivery_attempts.length, 1);
      assert.equal(after.notification_delivery_receipts.length, committed ? 1 : 0);
      assert.equal(delivery.state, committed ? 'DELIVERED' : 'SENDING');
      assert.equal(after.notification_delivery_attempts[0].state, committed ? 'RECEIVED' : 'SENDING');
    } else {
      assert.equal(after.notification_management_receipts.length, committed ? 1 : 0);
      assert.equal(delivery.state, committed ? 'PAUSED' : 'PENDING');
      if (!committed) assert.deepEqual(after, before);
    }
    assert.equal(receiver.packets.length, mode === 'receipt' ? 1 : 0);
    assert.equal(httpCount(dir), mode === 'receipt' ? 1 : 0);
    const restarted = await notificationProcessResult(notificationChild([path, 'inspect', '', receiver.endpoint]));
    assert.equal(restarted.code, 0, restarted.stderr); assert.equal(restarted.timedOut, false, restarted.stderr);
    assert.deepEqual(notificationContents(f.raw), after);
    assert.equal(receiver.packets.length, mode === 'receipt' ? 1 : 0);
    if (mode === 'receipt' && committed) {
      await f.db.notifications.runOnce(f.service, { workflowRunId: 'run' });
      assert.equal(receiver.packets.length, 1, 'committed receipt recovery needs no extra HTTP');
    }
  });
for (const boundary of ['before-http', 'after-http']) test(`CR-D04/CR-D05: SIGKILL ${boundary} retains UNKNOWN-safe Claim and no restored permit`, async t => {
  const receiver = await notificationHttpReceiver(t);
  const dir = mkdtempSync(join(tmpdir(), 'map-notification-http-crash-')), path = join(dir, 'db.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = notificationProcessHost(path, receiver.endpoint); t.after(() => f.close());
  const workflow = f.create(); workflow.cancel(); workflow.release(); f.db.notifications.materialize(f.service, { workflowRunId: 'run' });
  const before = business(notificationContents(f.raw));
  const result = await notificationProcessResult(notificationChild([path, 'http', boundary, receiver.endpoint]));
  assertNotificationCrash(result, path, 'http', boundary);
  assert.equal(receiver.packets.length, boundary === 'after-http' ? 1 : 0);
  const row = f.raw.prepare('SELECT * FROM notification_deliveries').get()!;
  assert.equal(row.state, 'SENDING'); assert.equal(row.attempt_count, 1);
  assert.equal(f.raw.prepare('SELECT count(*) n FROM notification_delivery_receipts').get()!.n, 0);
  await f.db.notifications.runOnce(f.service, { workflowRunId: 'run' });
  assert.equal(receiver.packets.length, boundary === 'after-http' ? 1 : 0, 'a reopened current Claim cannot mint a send permit');
  assert.equal(f.raw.prepare('SELECT attempt_count FROM notification_deliveries').get()!.attempt_count, 1);
  assert.deepEqual(business(notificationContents(f.raw)), before);
});

for (const operation of ['CLOSE', 'RETRY'] as const) for (const boundary of ['before-commit', 'after-commit'])
  test(`CR-D09: real SIGKILL ${operation}/${boundary} keeps management receipt and exact revision atomic with HTTP0`, async t => {
    const receiver = await notificationHttpReceiver(t);
    const dir = mkdtempSync(join(tmpdir(), 'map-notification-management-crash-')), path = join(dir, 'db.sqlite');
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const f = notificationProcessHost(path, receiver.endpoint); t.after(() => f.close());
    const workflow = f.create(); workflow.cancel(); workflow.release(); f.db.notifications.materialize(f.service, { workflowRunId: 'run' });
    if (operation === 'RETRY') {
      const d = f.raw.prepare('SELECT * FROM notification_deliveries').get()!;
      f.db.notifications.manage(f.human, { workflowRunId: 'run', deliveryId: String(d.delivery_id), ownerSubject: 'owner', destinationId: 'process-macp',
        operation: 'PAUSE', expectedRevision: Number(d.revision), requestId: 'prepare-retry', reason: 'OPERATOR_REQUEST' });
    }
    const before = notificationContents(f.raw);
    const killed = await notificationProcessResult(notificationChild([path, 'manage', boundary, receiver.endpoint, operation]));
    assertNotificationCrash(killed, path, 'manage', boundary);
    const after = notificationContents(f.raw), committed = boundary === 'after-commit';
    assert.deepEqual(business(after), business(before));
    if (!committed) assert.deepEqual(after, before);
    else {
      assert.equal(after.notification_management_receipts.length, before.notification_management_receipts.length + 1);
      assert.equal(Number(after.notification_deliveries[0].revision), Number(before.notification_deliveries[0].revision) + 1);
      assert.equal(after.notification_deliveries[0].state, operation === 'CLOSE' ? 'SUPPRESSED' : 'PENDING');
    }
    assert.equal(after.notification_delivery_attempts.length, 0); assert.equal(receiver.packets.length, 0);
    const restarted = await notificationProcessResult(notificationChild([path, 'inspect', '', receiver.endpoint]));
    assert.equal(restarted.code, 0, restarted.stderr); assert.deepEqual(notificationContents(f.raw), after);
    assert.equal(receiver.packets.length, 0);
  });
