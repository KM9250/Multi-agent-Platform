import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { notificationProcessHost } from './notification-process-host.ts';
import { assertNotificationCrash, notificationChild, notificationContents, notificationHttpReceiver, notificationProcessResult, notificationReady } from './notification-process-fixture.ts';

const business = (all: ReturnType<typeof notificationContents>) => Object.fromEntries(Object.entries(all).filter(([name]) => !name.startsWith('notification_')));
async function until(check: () => boolean, reason: string, timeoutMs = 15000) {
  const deadline = performance.now() + timeoutMs;
  while (!check()) { assert.ok(performance.now() < deadline, reason); await delay(10); }
}
test('SO-17: two independent Materializers create one fixed packet and no HTTP or business mutation', async t => {
  const receiver = await notificationHttpReceiver(t);
  const dir = mkdtempSync(join(tmpdir(), 'map-notification-materialize-race-')), path = join(dir, 'db.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = notificationProcessHost(path, receiver.endpoint); t.after(() => f.close());
  const workflow = f.create(); workflow.cancel(); workflow.release();
  const before = business(notificationContents(f.raw));
  const children = [notificationChild([path, 'materialize-race', '', receiver.endpoint]), notificationChild([path, 'materialize-race', '', receiver.endpoint])];
  const results = children.map(child => notificationProcessResult(child)); await Promise.all(children.map(child => notificationReady(child)));
  children.forEach(child => child.send('go'));
  for (const result of await Promise.all(results)) { assert.equal(result.code, 0, result.stderr); assert.equal(result.timedOut, false, result.stderr); }
  assert.equal(f.raw.prepare('SELECT count(*) n FROM notification_deliveries').get()!.n, 1);
  assert.equal(f.raw.prepare("SELECT count(*) n FROM notification_delivery_audit WHERE event_kind='NOTIFICATION_MATERIALIZED'").get()!.n, 1);
  assert.equal(f.raw.prepare('SELECT count(*) n FROM notification_delivery_attempts').get()!.n, 0);
  assert.equal(receiver.packets.length, 0); assert.deepEqual(business(notificationContents(f.raw)), before);
});
test('DL-07/CR-D07: two independent workers race one persistent stream Claim with one HTTP and unchanged business Lease', async t => {
  const receiver = await notificationHttpReceiver(t); receiver.hold = true;
  const dir = mkdtempSync(join(tmpdir(), 'map-notification-claim-race-')), path = join(dir, 'db.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = notificationProcessHost(path, receiver.endpoint); t.after(() => f.close());
  const workflow = f.create(); workflow.cancel(); workflow.release(); f.db.notifications.materialize(f.service, { workflowRunId: 'run' });
  const before = business(notificationContents(f.raw));
  const children = [notificationChild([path, 'race', '', receiver.endpoint]), notificationChild([path, 'race', '', receiver.endpoint])];
  t.after(() => { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const results = children.map(child => notificationProcessResult(child));
  await Promise.all(children.map(child => notificationReady(child)));
  children.forEach(child => child.send('go'));
  await until(() => receiver.packets.length === 1, 'first HTTP should reach loopback receiver');
  assert.equal(f.raw.prepare("SELECT count(*) n FROM notification_delivery_attempts WHERE state='SENDING'").get()!.n, 1);
  assert.equal(f.raw.prepare('SELECT count(*) n FROM notification_stream_claims').get()!.n, 1);
  receiver.release();
  const completed = await Promise.all(results);
  for (const result of completed) { assert.equal(result.timedOut, false, result.stderr); assert.equal(result.code, 0, result.stderr); }
  assert.equal(receiver.packets.length, 1); assert.equal(receiver.events.size, 1);
  assert.equal(f.raw.prepare('SELECT count(*) n FROM notification_delivery_attempts').get()!.n, 1);
  assert.equal(f.raw.prepare('SELECT count(*) n FROM notification_delivery_receipts').get()!.n, 1);
  assert.equal(f.raw.prepare('SELECT state FROM notification_deliveries').get()!.state, 'DELIVERED');
  assert.deepEqual(business(notificationContents(f.raw)), before);
});
test('DL-08/DL-09/CR-D08: SIGSTOP old worker, expire Claim, new process recovers; resumed old ACK cannot overwrite new generation', async t => {
  const receiver = await notificationHttpReceiver(t); receiver.hold = true;
  const dir = mkdtempSync(join(tmpdir(), 'map-notification-stale-worker-')), path = join(dir, 'db.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = notificationProcessHost(path, receiver.endpoint); t.after(() => f.close());
  const workflow = f.create(); workflow.cancel(); workflow.release(); f.db.notifications.materialize(f.service, { workflowRunId: 'run' });
  const before = business(notificationContents(f.raw));
  const old = notificationChild([path, 'race', '', receiver.endpoint]);
  t.after(() => { if (old.exitCode === null && old.signalCode === null) { old.kill('SIGCONT'); old.kill('SIGKILL'); } });
  const oldResult = notificationProcessResult(old); await notificationReady(old); old.send('go');
  await until(() => receiver.packets.length === 1, 'old worker HTTP must start before SIGSTOP');
  assert.equal(old.kill('SIGSTOP'), true);
  const oldClaim = f.raw.prepare('SELECT * FROM notification_stream_claims').get()!;
  await until(() => Number(f.raw.prepare("SELECT CAST(unixepoch('subsec')*1000 AS INTEGER) now").get()!.now) > Number(oldClaim.expires_at), 'database claim clock must pass expiry');
  receiver.hold = false;
  const replacement = await notificationProcessResult(notificationChild([path, 'run', '', receiver.endpoint]));
  assert.equal(replacement.timedOut, false, replacement.stderr); assert.equal(replacement.code, 0, replacement.stderr);
  assert.equal(receiver.packets.length, 2); assert.equal(receiver.events.size, 1);
  assert.deepEqual(receiver.packets[0], receiver.packets[1]);
  const completed = notificationContents(f.raw), newClaim = completed.notification_stream_claims[0];
  assert.equal(Number(newClaim.generation), Number(oldClaim.generation) + 1);
  assert.equal(completed.notification_deliveries[0].state, 'DELIVERED');
  assert.equal(completed.notification_delivery_attempts.length, 2);
  assert.equal(completed.notification_delivery_attempts[0].state, 'SEND_OUTCOME_UNKNOWN');
  assert.equal(completed.notification_delivery_attempts[1].state, 'RECEIVED');
  assert.equal(completed.notification_delivery_receipts.length, 1);
  receiver.release(); assert.equal(old.kill('SIGCONT'), true);
  const resumed = await oldResult;
  assert.equal(resumed.timedOut, false, resumed.stderr); assert.equal(resumed.code, 0, resumed.stderr);
  assert.deepEqual(notificationContents(f.raw), completed, 'old collector must not mutate newer claim/receipt/audit');
  assert.deepEqual(business(completed), before);
});
test('DL-10/CR-D03: Claim COMMIT ACK loss survives independent restart without restoring old permit or resetting attempt count', async t => {
  const receiver = await notificationHttpReceiver(t);
  const dir = mkdtempSync(join(tmpdir(), 'map-notification-claim-restart-')), path = join(dir, 'db.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = notificationProcessHost(path, receiver.endpoint); t.after(() => f.close());
  const workflow = f.create(); workflow.cancel(); workflow.release(); f.db.notifications.materialize(f.service, { workflowRunId: 'run' });
  const killed = await notificationProcessResult(notificationChild([path, 'claim', 'after-commit', receiver.endpoint]));
  assertNotificationCrash(killed, path, 'claim', 'after-commit');
  assert.equal(receiver.packets.length, 0);
  const first = f.raw.prepare('SELECT * FROM notification_stream_claims').get()!;
  const retry = await notificationProcessResult(notificationChild([path, 'run', '', receiver.endpoint]));
  assert.equal(retry.code, 0, retry.stderr); assert.equal(receiver.packets.length, 0);
  assert.equal(f.raw.prepare('SELECT attempt_count FROM notification_deliveries').get()!.attempt_count, 1);
  await until(() => Number(f.raw.prepare("SELECT CAST(unixepoch('subsec')*1000 AS INTEGER) now").get()!.now) > Number(first.expires_at), 'Claim expiry');
  const recovered = await notificationProcessResult(notificationChild([path, 'run', '', receiver.endpoint]));
  assert.equal(recovered.code, 0, recovered.stderr); assert.equal(recovered.timedOut, false, recovered.stderr);
  assert.equal(receiver.packets.length, 1);
  const attempts = f.raw.prepare('SELECT * FROM notification_delivery_attempts ORDER BY attempt_number').all();
  assert.equal(attempts.length, 2); assert.equal(attempts[0].state, 'SEND_OUTCOME_UNKNOWN'); assert.equal(attempts[1].state, 'RECEIVED');
  assert.notEqual(attempts[0].claim_id, attempts[1].claim_id);
  assert.equal(f.raw.prepare('SELECT state FROM notification_deliveries').get()!.state, 'DELIVERED');
});
