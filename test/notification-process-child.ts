import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DurableDatabase } from '../services/coordination/durable/db.ts';

const [path, mode, boundary = '', arg = '', detail = 'PAUSE'] = process.argv.slice(2);
const nativeExec = DatabaseSync.prototype.exec, nativePrepare = DatabaseSync.prototype.prepare;
const kill = () => {
  // A timeout/OOM kill is not evidence that the requested production boundary ran.
  writeFileSync(join(dirname(path), 'crash-boundary.json'), JSON.stringify({ mode, boundary }), { mode: 0o600 });
  process.kill(process.pid, 'SIGKILL');
};
function crashOnCommit(table: string) {
  let armed = false;
  DatabaseSync.prototype.prepare = function(sql: string) {
    const statement = nativePrepare.call(this, sql), run = statement.run.bind(statement);
    statement.run = (...args: Parameters<typeof statement.run>) => {
      const result = run(...args);
      if (sql.includes(`INSERT INTO ${table}`) || sql.includes(`UPDATE ${table}`)) armed = true;
      return result;
    };
    return statement;
  };
  DatabaseSync.prototype.exec = function(sql: string) {
    if (armed && sql === 'COMMIT' && boundary === 'before-commit') kill();
    const result = nativeExec.call(this, sql);
    if (armed && sql === 'COMMIT' && boundary === 'after-commit') kill();
    return result;
  };
}
if (mode === 'migration') {
  let reachedDdl = false;
  DatabaseSync.prototype.prepare = function(sql: string) {
    const statement = nativePrepare.call(this, sql), run = statement.run.bind(statement);
    statement.run = (...args: Parameters<typeof statement.run>) => {
      const result = run(...args);
      if (sql.includes('INSERT INTO notification_migration_baselines') && boundary === 'after-baseline') kill();
      return result;
    };
    return statement;
  };
  DatabaseSync.prototype.exec = function(sql: string) {
    if (sql.includes('CREATE TABLE notification_sources')) {
      reachedDdl = true;
      if (boundary === 'before-ddl') kill();
      const result = nativeExec.call(this, sql);
      if (boundary === 'after-ddl') kill();
      return result;
    }
    if (reachedDdl && sql === 'COMMIT' && boundary === 'before-commit') kill();
    const result = nativeExec.call(this, sql);
    if (reachedDdl && sql === 'COMMIT' && boundary === 'after-commit') kill();
    return result;
  };
  new DurableDatabase({ path }).close();
  throw Error(`Notification migration missed SIGKILL boundary ${boundary}`);
} else if (mode === 'migration-race') {
  process.send!({ ready: true });
  process.once('message', () => {
    try { new DurableDatabase({ path }).close(); process.send!({ migration: 'COMPLETE' }); }
    catch (error) { assert.equal((error as { code?: string }).code, 'DATABASE_BUSY'); process.send!({ migration: 'DATABASE_BUSY' }); }
    finally { process.disconnect(); }
  });
} else if (mode === 'migration-busy') {
  assert.throws(() => new DurableDatabase({ path, busyTimeoutMs: 0 }), { code: 'DATABASE_BUSY' });
  process.exit(0);
} else if (mode === 'migration-open') {
  new DurableDatabase({ path }).close(); process.exit(0);
} else if (mode === 'v10-open') {
  const baseline = mkdtempSync(join(tmpdir(), 'map-notification-v10-runtime-'));
  try {
    const archive = spawnSync('git', ['archive', 'c89b5cd497e1529e0ed64d3d3983be6665c4969d', 'services', 'types.ts', 'utils', 'constants.ts', 'package.json'], { cwd: resolve('.'), maxBuffer: 32 * 1024 * 1024 });
    assert.equal(archive.status, 0, archive.stderr.toString());
    const extract = spawnSync('tar', ['-xf', '-', '-C', baseline], { input: archive.stdout, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(extract.status, 0, extract.stderr.toString());
    symlinkSync(resolve('node_modules'), join(baseline, 'node_modules'), 'dir');
    const { DurableDatabase: V10Database } = await import(pathToFileURL(join(baseline, 'services/coordination/durable/db.ts')).href);
    assert.throws(() => new V10Database({ path }), { code: 'SCHEMA_UNSUPPORTED' });
  } finally { rmSync(baseline, { recursive: true, force: true }); }
  process.exit(0);
} else if (mode === 'source') {
  const { notificationProcessHost } = await import('./notification-process-host.ts');
  const { notificationContents } = await import('./notification-process-fixture.ts');
  const f = notificationProcessHost(path, undefined, { beforeSend() { appendFileSync(join(dirname(path), 'http.txt'), 'send\n'); } });
  const workflow = f.create();
  writeFileSync(join(dirname(path), 'before.json'), JSON.stringify(notificationContents(f.raw)));
  crashOnCommit('notification_sources'); workflow.cancel();
  throw Error(`Notification source missed SIGKILL ${boundary}`);
} else if (['materialize', 'materialize-race', 'claim', 'receipt', 'manage', 'sync', 'sync-run', 'sync-race', 'run', 'race', 'http', 'inspect'].includes(mode)) {
  const { notificationProcessHost } = await import('./notification-process-host.ts');
  const f = notificationProcessHost(path, arg || undefined, {
    ownerSubject: mode.startsWith('sync') && detail !== 'PAUSE' ? detail : 'owner',
    beforeSend() {
      if (mode === 'http' && boundary === 'before-http') kill();
      appendFileSync(join(dirname(path), 'http.txt'), 'send\n');
      process.send?.({ sending: true });
    },
    afterSend() { if (mode === 'http' && boundary === 'after-http') kill(); },
  });
  if (mode === 'inspect') {
    const result = f.db.notifications.read(f.human, { workflowRunId: 'run', includeAudit: true });
    process.send!({ inspected: result }); f.close(); process.disconnect();
  } else if (mode === 'materialize' || mode === 'materialize-race') {
    if (mode === 'materialize') crashOnCommit('notification_deliveries');
    const materialize = () => {
      const result = f.db.notifications.materialize(f.service, { workflowRunId: 'run' });
      if (mode === 'materialize') throw Error(`Notification materialize missed SIGKILL ${boundary}`);
      process.send!({ materialized: result }); f.close(); process.disconnect();
    };
    if (mode === 'materialize-race') { process.send!({ ready: true }); process.once('message', materialize); }
    else materialize();
  } else if (mode === 'sync' || mode === 'sync-run' || mode === 'sync-race') {
    const row = f.raw.prepare('SELECT * FROM notification_migration_baselines WHERE workflow_run_id=?').get('run')!;
    if (mode === 'sync') crashOnCommit('notification_management_receipts');
    const sync = () => {
      const result = f.db.notifications.syncUnresolved(f.human, { workflowRunId: 'run', ownerSubject: detail !== 'PAUSE' ? detail : 'owner', destinationId: 'process-macp',
        expectedBaseline: String(row.baseline_digest), requestId: 'process-sync' });
      if (mode === 'sync') throw Error(`Notification sync missed SIGKILL ${boundary}`);
      process.send!({ synced: result }); f.close(); process.disconnect();
    };
    if (mode === 'sync-race') { process.send!({ ready: true }); process.once('message', sync); }
    else sync();
  } else if (mode === 'manage') {
    const row = f.raw.prepare('SELECT * FROM notification_deliveries').get()!;
    crashOnCommit('notification_management_receipts');
    f.db.notifications.manage(f.human, { workflowRunId: 'run', deliveryId: String(row.delivery_id), destinationId: String(row.destination_id),
      ownerSubject: 'owner', expectedRevision: Number(row.revision), operation: detail as 'PAUSE' | 'CLOSE' | 'RETRY', requestId: `process-${detail.toLowerCase()}`, reason: 'OPERATOR_REQUEST' });
    throw Error(`Notification management missed SIGKILL ${boundary}`);
  } else {
    if (mode === 'claim') crashOnCommit('notification_delivery_attempts');
    if (mode === 'receipt') crashOnCommit('notification_delivery_receipts');
    const run = async () => {
      try {
        const result = await f.db.notifications.runOnce(f.service, { workflowRunId: 'run' });
        if (['claim', 'receipt', 'http'].includes(mode)) throw Error(`Notification ${mode} missed SIGKILL ${boundary}`);
        process.send!({ done: true, result });
      } catch (error) {
        if (['claim', 'receipt', 'http'].includes(mode)) throw error;
        process.send!({ done: true, code: (error as { code?: string }).code ?? 'UNEXPECTED_ERROR' });
      } finally { f.close(); if (process.connected) process.disconnect(); }
    };
    if (mode === 'race') { process.send!({ ready: true }); process.once('message', () => { void run(); }); }
    else await run();
  }
} else {
  throw Error(`Unknown notification child mode ${mode}/${boundary}/${arg}`);
}
