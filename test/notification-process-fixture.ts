import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from '../services/coordination/durable/schema.ts';
import { digest, parseJson } from '../services/coordination/durable/integrity.ts';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TestContext } from 'node:test';
import type { MacpNotificationPacket } from '../services/coordination/notifications/macpPacket.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface NotificationProcessResult {
  code: number | null; signal: string | null; stderr: string; timedOut: boolean; messages: unknown[];
}
export function assertNotificationCrash(result: NotificationProcessResult, path: string, mode: string, boundary: string): void {
  assert.equal(result.timedOut, false, result.stderr); assert.equal(result.signal, 'SIGKILL', result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(dirname(path), 'crash-boundary.json'), 'utf8')), { mode, boundary });
}
export function notificationChild(args: string[]): ChildProcess {
  return fork(fileURLToPath(new URL('./notification-process-child.ts', import.meta.url)), args, {
    execArgv: ['--experimental-transform-types', '--loader', fileURLToPath(new URL('./ts-loader.mjs', import.meta.url))],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
}
export function notificationProcessResult(child: ChildProcess, timeoutMs = 30_000): Promise<NotificationProcessResult> {
  let stderr = '', timedOut = false;
  const messages: unknown[] = [];
  child.stderr!.on('data', chunk => { stderr += chunk; });
  child.on('message', message => messages.push(message));
  const timeout = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
  return new Promise((resolve, reject) => {
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code, signal) => { clearTimeout(timeout); resolve({ code, signal, stderr, timedOut, messages }); });
  });
}
export function notificationReady(child: ChildProcess, key = 'ready', timeoutMs = 15_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error(`Notification child ${key} timeout`)), timeoutMs);
    const message = (value: Record<string, unknown>) => {
      if (value[key]) { clearTimeout(timeout); child.off('message', message); resolve(value); }
    };
    child.on('message', message);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code, signal) => { clearTimeout(timeout); reject(Error(`Notification child exited before ${key}: ${code}/${signal}`)); });
  });
}
export function notificationContents(raw: DatabaseSync): Record<string, Record<string, unknown>[]> {
  return Object.fromEntries(raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(row => [String(row.name), JSON.parse(JSON.stringify(raw.prepare(`SELECT * FROM "${row.name}" ORDER BY rowid`).all()))]));
}
/** Offline historical fixture construction; never a runtime capability. */
export function historicalNotificationDatabase(path: string, version: number): DatabaseSync {
  const raw = new DatabaseSync(path);
  // The real migration010 backfill references this pure, non-authority SQL digest.
  raw.function('map_reconciliation_digest', value => digest(parseJson(value)));
  if (version) {
    raw.exec('CREATE TABLE schema_migrations (schema_version INTEGER PRIMARY KEY,migration_id TEXT NOT NULL UNIQUE,applied_at INTEGER NOT NULL) STRICT');
    for (const migration of MIGRATIONS.slice(0, version)) {
      raw.exec(migration.sql);
      raw.prepare('INSERT INTO schema_migrations VALUES (?,?,1)').run(migration.version, migration.id);
    }
    raw.exec(`PRAGMA user_version=${version}`);
  }
  return raw;
}
export function copyNotificationHistory(source: DatabaseSync, target: DatabaseSync) {
  const triggers = target.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger'").all();
  target.exec('PRAGMA foreign_keys=OFF');
  for (const row of triggers) target.exec(`DROP TRIGGER "${row.name}"`);
  const before: Record<string, Record<string, unknown>[]> = {};
  for (const table of target.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'schema_migrations' ORDER BY name").all()) {
    const name = String(table.name), columns = target.prepare(`PRAGMA table_info("${name}")`).all().map(row => String(row.name));
    const rows = source.prepare(`SELECT ${columns.map(column => `"${column}"`).join(',')} FROM "${name}" ORDER BY rowid`).all();
    target.exec(`DELETE FROM "${name}"`);
    for (const row of rows) target.prepare(`INSERT INTO "${name}" VALUES(${columns.map(() => '?').join(',')})`).run(...columns.map(column => row[column] as string | number | null));
    before[name] = rows;
  }
  for (const row of triggers) target.exec(String(row.sql));
  target.exec('PRAGMA foreign_keys=ON');
  return before;
}
/** A real loopback HTTP receiver for process/fencing tests, not the MACP integration suite. */
export async function notificationHttpReceiver(t: Pick<TestContext, 'after'>) {
  const packets: MacpNotificationPacket[] = [], events = new Map<string, string>();
  const pending: (() => void)[] = [];
  let hold = false;
  const server = createServer((request, response: ServerResponse) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      if (request.url !== '/api/notify' || request.method !== 'POST' || request.headers.authorization !== 'Bearer local-notification-test') {
        response.writeHead(401).end(); return;
      }
      const packet = JSON.parse(body) as MacpNotificationPacket; packets.push(packet);
      const previous = events.get(packet.task_id);
      if (previous && previous !== body) { response.writeHead(409).end(); return; }
      events.set(packet.task_id, body);
      const reply = () => response.writeHead(previous ? 200 : 201, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        ok: true, task_id: packet.task_id, event_id: 1, idempotent_replay: !!previous,
      }));
      if (hold) pending.push(reply); else reply();
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/notify`;
  return { endpoint, packets, events, set hold(value: boolean) { hold = value; }, release() { hold = false; pending.splice(0).forEach(reply => reply()); } };
}
