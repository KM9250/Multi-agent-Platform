/** Standalone opt-in capacity measurement; never a throughput claim for long single-workflow histories. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { platform, release, cpus } from 'node:os';
import { DurableDatabase } from '../services/coordination/durable/db.ts';
import { SqliteCoordinationRunnerStore } from '../services/coordination/durable/durableCoordinationStore.ts';
import type { NotificationOptions } from '../services/coordination/durable/notificationTypes.ts';
import { fresh, event } from './notification-fixture.ts';

const output = resolve(process.argv[2] ?? 'work/notification-performance-summary.json');
mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
const dir = mkdtempSync(join(dirname(output), 'notification-capacity-')), path = join(dir, 'synthetic.sqlite');
const credential = Object.freeze({});
let simulatedSends = 0;
const options: NotificationOptions = {
  enabled: true,
  identityVerifier: { verify: value => value === credential ? { subjectId: 'synthetic-performance-worker', kind: 'SERVICE' } : undefined },
  authorize: access => access.actor.subjectId === 'synthetic-performance-worker', output: () => true,
  registry: { resolve: () => destination }, limits: { backoffBaseMs: 0, backoffMaxMs: 0 },
};
const destination = {
  destinationId: 'synthetic-local', bindingVersion: 'synthetic:1', implementationDigest: 'e'.repeat(64), receiverRealm: 'synthetic-capacity-realm',
  recipientSubject: 'synthetic-owner', audience: 'synthetic-capacity', endpoint: 'http://127.0.0.1:1/api/notify', authenticated: false,
  transportContract: 'macp/0.1.0' as const, idempotencyConfirmed: true, allowDevelopmentLoopback: true,
  transport: { idempotencySupported: true, async send(packet: { task_id: string }) {
    simulatedSends++; return { taskId: packet.task_id, eventId: simulatedSends, idempotentReplay: false, httpStatus: 201 };
  } },
};
const db = new DurableDatabase({ path, notifications: options }), admin = new SqliteCoordinationRunnerStore(db), manager = db.createLeaseManager();
const raw = new DatabaseSync(path, { readOnly: true });
const round = (n: number) => Math.round(n * 1000) / 1000;
function summary(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return { samples: values.length, totalMs: round(values.reduce((sum, value) => sum + value, 0)),
    meanMs: round(values.reduce((sum, value) => sum + value, 0) / values.length), p50Ms: round(sorted[Math.floor(sorted.length * 0.5)]),
    p95Ms: round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]), maxMs: round(sorted.at(-1)!) };
}
function measure<T>(fn: () => T): { elapsed: number; value: T } {
  const start = performance.now(), value = fn(); return { elapsed: performance.now() - start, value };
}
const dueSql = "SELECT delivery_id FROM notification_deliveries WHERE state='PENDING' AND next_attempt_at<=? ORDER BY next_attempt_at,created_at LIMIT ?";
const result: Record<string, any> = {
  generatedAt: new Date().toISOString(), referenceHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  workingTreeMeasurement: true,
  environment: { node: process.versions.node, nodeSqlite: raw.prepare('SELECT sqlite_version() AS version').get()!.version,
    platform: platform(), release: release(), cpuModel: cpus()[0]?.model, logicalCpus: cpus().length },
  method: { workload: 'One legitimate two-event workflow and one atomic cancellation source per workflow; cumulative populations 100/1000/10000.',
    sourceCapture: 'Timed business append includes journal persistence, validation and Stage A; bootstrap/acquire/release reported separately.',
    materialization: 'Public authenticated materialize API, fixed local binding and packet; no network.',
    reader: '100 authenticated one-row workflow reads at each population; this is not a 10000-row authorized page.',
    dueScan: '100 bounded SQL index diagnostics, batch limit100; worker currently scans explicitly configured workflows, so this is not worker scheduling throughput.',
    attempt: '10 legitimate runOnce calls per population with synthetic in-memory201 responses; not HTTP integration.',
    storage: 'Live DB and WAL physical bytes, SQLite page-count logical size, UTF-8 JSON row estimates, optional dbstat table and explicitly named index bytes (SQLite automatic PK/UNIQUE indexes are excluded from that breakdown).',
    limitations: ['Single run, warm cache, shared cloud CPU and storage.', 'No same-workflow long-history scale guarantee: canonical source validation replays the affected workflow.', 'No retention deletion or compression.', 'All data and credentials synthetic; temporary DB removed after measurement.'] },
  populations: [],
};
let created = 0, cumulativeCaptureMs = 0, cumulativeMaterializeMs = 0;
const persist = () => writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
try {
  for (const population of [100, 1000, 10000]) {
    const start = created, capture: number[] = [], setup: number[] = [], materialize: number[] = [];
    for (let i = start; i < population; i++) {
      const id = `capacity-${i.toString().padStart(5, '0')}`;
      const prepare = measure(() => { admin.createWorkflow(fresh(id)); return manager.acquire(id); });
      const lease = prepare.value, store = admin.withLease(lease);
      const change = event(store.getSnapshot(id), 'WorkflowCancelled', { reason: 'Synthetic capacity measurement' });
      capture.push(measure(() => store.append(change)).elapsed);
      const releaseTime = measure(() => manager.release(lease)).elapsed;
      setup.push(prepare.elapsed + releaseTime);
      if ((i + 1) % 1000 === 0) process.stdout.write(`Captured ${i + 1} synthetic sources\n`);
    }
    created = population;
    for (let i = start; i < population; i++) {
      const id = `capacity-${i.toString().padStart(5, '0')}`;
      const measured = measure(() => db.notifications.materialize(credential, { workflowRunId: id }));
      assert.equal(measured.value.code, 'NOTIFICATION_SERVICE_CYCLE_COMPLETE'); materialize.push(measured.elapsed);
      assert.equal(db.notifications.read(credential, { workflowRunId: id }).items[0].state, 'PENDING');
      if ((i + 1) % 1000 === 0) process.stdout.write(`Materialized ${i + 1} synthetic deliveries\n`);
    }
    const count = db.read(tx => ({ sources: tx.get('SELECT count(*) n FROM notification_sources')!.n,
      deliveries: tx.get('SELECT count(*) n FROM notification_deliveries')!.n }));
    assert.equal(count.sources, population); assert.equal(count.deliveries, population);
    const reads: number[] = [], scans: number[] = [];
    for (let i = 0; i < 100; i++) {
      const workflowRunId = `capacity-${Math.floor(i * population / 100).toString().padStart(5, '0')}`;
      const read = measure(() => db.notifications.read(credential, { workflowRunId }));
      assert.equal(read.value.items.length, 1); reads.push(read.elapsed);
      const scan = measure(() => db.read(tx => tx.all(dueSql, Date.now(), 100)));
      assert.equal(scan.value.length, 100); scans.push(scan.elapsed);
    }
    const sends: number[] = [];
    for (let i = start; i < start + 10; i++) {
      const workflowRunId = `capacity-${i.toString().padStart(5, '0')}`, at = performance.now();
      await db.notifications.runOnce(credential, { workflowRunId }); sends.push(performance.now() - at);
      assert.equal(db.notifications.read(credential, { workflowRunId }).items[0].state, 'DELIVERED');
    }
    cumulativeCaptureMs += capture.reduce((sum, v) => sum + v, 0);
    cumulativeMaterializeMs += materialize.reduce((sum, v) => sum + v, 0);
    const encoded = (table: string) => {
      const values = db.read(tx => tx.all(`SELECT * FROM ${table} LIMIT 100`)).map(row => Buffer.byteLength(JSON.stringify(row), 'utf8'));
      return { sampledRows: values.length, meanBytes: round(values.reduce((sum, value) => sum + value, 0) / values.length), maxBytes: Math.max(...values) };
    };
    let tableBytes: unknown = null;
    try { tableBytes = raw.prepare("SELECT name,SUM(pgsize) bytes FROM dbstat WHERE name LIKE 'notification_%' GROUP BY name ORDER BY name").all(); } catch { /* Optional SQLite build feature, reported as unavailable. */ }
    const measurement = {
      population, increment: population - start, counts: count, sourceCapture: summary(capture), businessSetup: summary(setup), materialize: summary(materialize),
      cumulativeSourceCaptureMs: round(cumulativeCaptureMs), cumulativeMaterializeMs: round(cumulativeMaterializeMs), authenticatedReader: summary(reads), indexedDueScan: summary(scans),
      dueQueryPlan: raw.prepare(`EXPLAIN QUERY PLAN ${dueSql}`).all(Date.now(), 100).map(row => row.detail), simulatedAttempt: summary(sends),
      storage: { databaseBytes: statSync(path).size, walBytes: existsSync(path + '-wal') ? statSync(path + '-wal').size : 0,
        logicalDatabaseBytes: Number(raw.prepare('PRAGMA page_count').get()!.page_count) * Number(raw.prepare('PRAGMA page_size').get()!.page_size),
        packet: raw.prepare('SELECT AVG(length(CAST(packet_json AS BLOB))) meanBytes,MAX(length(CAST(packet_json AS BLOB))) maxBytes FROM notification_deliveries').get(),
        sourceJsonEstimate: encoded('notification_sources'), deliveryJsonEstimate: encoded('notification_deliveries'), attemptJsonEstimate: encoded('notification_delivery_attempts'),
        receiptJsonEstimate: encoded('notification_delivery_receipts'), notificationTableAndIndexBytes: tableBytes },
      processRssBytes: process.memoryUsage().rss, simulatedSends, httpRequests: 0,
    };
    result.populations.push(measurement); persist();
    process.stdout.write(JSON.stringify({ population, captureMs: measurement.sourceCapture.totalMs, materializeMs: measurement.materialize.totalMs,
      readerMeanMs: measurement.authenticatedReader.meanMs, dueMeanMs: measurement.indexedDueScan.meanMs, databaseBytes: measurement.storage.logicalDatabaseBytes }) + '\n');
  }
  result.completed = true; persist();
} finally { raw.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
