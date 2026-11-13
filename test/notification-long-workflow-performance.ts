/** Opt-in PR37 P3 measurement. Uses real bounded planning, never bypasses SQL or provenance checks. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { TestContext } from 'node:test';
import { continuationFixture } from './continuation-fixture.ts';
import { executionSeed } from './durable-execution-fixture.ts';
import { notificationContents } from './notification-process-fixture.ts';
import { DurableDatabase } from '../services/coordination/durable/db.ts';
import { RecoveryContinuationCoordinator } from '../services/coordination/durable/recoveryContinuationCoordinator.ts';
import { digest } from '../services/coordination/durable/integrity.ts';
import type { NotificationOptions } from '../services/coordination/durable/notificationTypes.ts';

const output = resolve(process.argv[2] ?? 'work/notification-long-workflow.json');
const populations = process.argv.slice(3).map(Number);
if (!populations.length) populations.push(100, 300, 1000);
assert.ok(populations.every((n, i) => Number.isSafeInteger(n) && n > (populations[i - 1] ?? 0) && n <= 3000));
mkdirSync(dirname(output), { recursive: true });
const cleanup: Array<() => unknown> = [];
const t = { after: (fn: () => unknown) => cleanup.push(fn) } as unknown as Pick<TestContext, 'after'>;
const f = continuationFixture(t), workflowRunId = 'long-workflow';
f.admin.createWorkflow(executionSeed('ALLOW', workflowRunId, { maxWallTimeMs: Number.MAX_SAFE_INTEGER,
  maxLlmCalls: 10000, maxInputTokens: 1000000, maxOutputTokens: 1000000, maxEstimatedCost: 1000 }));
const manager = f.db.createLeaseManager({ ttlMs: 3600000 }), lease = manager.acquire(workflowRunId);
const api = new RecoveryContinuationCoordinator(f.db, lease);
f.hook(async () => ({ value: { kind: 'needs_input', questions: ['Synthetic question for capacity measurement'] },
  usage: { llmCalls: 1, inputTokens: 1, outputTokens: 1, estimatedCost: 0 }, completeness: 'COMPLETE' }));
const service = Object.freeze({}), viewer = Object.freeze({}); let httpCalls = 0;
const options: NotificationOptions = {
  enabled: true,
  identityVerifier: { verify: c => c === service ? { subjectId: 'capacity-service', kind: 'SERVICE' }
    : c === viewer ? { subjectId: 'operator', kind: 'HUMAN' } : undefined },
  authorize: a => a.actor.kind === 'SERVICE'
    ? ['MATERIALIZE_NOTIFICATION','CLAIM_NOTIFICATION_DELIVERY','SEND_NOTIFICATION','COLLECT_NOTIFICATION_RECEIPT'].includes(a.permission)
    : a.permission === 'VIEW_NOTIFICATION', output: () => true,
  registry: { resolve: () => destination },
};
const destination: NonNullable<ReturnType<NonNullable<NotificationOptions['registry']>['resolve']>> = { destinationId: 'synthetic-capacity', bindingVersion: '1', implementationDigest: 'synthetic-capacity-v1',
    receiverRealm: 'synthetic-capacity-realm', recipientSubject: 'operator', audience: 'synthetic', endpoint: 'http://127.0.0.1:1/api/notify',
    authenticated: false, allowDevelopmentLoopback: true, transportContract: 'macp/0.1.0', idempotencyConfirmed: true,
    transport: { idempotencySupported: true, send() { httpCalls++; throw Error('This benchmark must not send'); } } };
const notifications = new DurableDatabase({ path: f.path, notifications: options });
const originalExec = DatabaseSync.prototype.exec;
type Profile = { readMs: number[]; writeMs: number[]; rssPeak: number };
let active: Profile | undefined;
const opened = new WeakMap<DatabaseSync, { start: number; write: boolean; profile: Profile }>();
DatabaseSync.prototype.exec = function(sql: string) {
  if (active && (sql === 'BEGIN' || sql === 'BEGIN IMMEDIATE')) opened.set(this, { start: performance.now(), write: sql === 'BEGIN IMMEDIATE', profile: active });
  try { return originalExec.call(this, sql); }
  finally {
    if (sql === 'COMMIT' || sql === 'ROLLBACK') {
      const tx = opened.get(this);
      if (tx) {
        (tx.write ? tx.profile.writeMs : tx.profile.readMs).push(performance.now() - tx.start);
        tx.profile.rssPeak = Math.max(tx.profile.rssPeak, process.memoryUsage().rss); opened.delete(this);
      }
    }
  }
};
const round = (n: number) => Math.round(n * 1000) / 1000;
function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b), total = values.reduce((a, b) => a + b, 0);
  return { count: values.length, totalMs: round(total), meanMs: round(total / Math.max(1, values.length)),
    maxMs: round(sorted.at(-1) ?? 0), p95Ms: round(sorted[Math.floor((sorted.length - 1) * 0.95)] ?? 0) };
}
async function measure<T>(fn: () => T | Promise<T>) {
  const before = process.memoryUsage(), profile: Profile = { readMs: [], writeMs: [], rssPeak: before.rss }, start = performance.now(); active = profile;
  try {
    const value = await fn();
    return { value, wallMs: round(performance.now() - start), readTransactions: stats(profile.readMs), writeTransactions: stats(profile.writeMs),
      memory: { before, after: process.memoryUsage(), sampledRssPeak: profile.rssPeak } };
  } finally { active = undefined; }
}
const businessDigest = () => digest(Object.fromEntries(Object.entries(notificationContents(f.raw)).filter(([name]) => !name.startsWith('notification_'))));
const result: Record<string, unknown> = { referenceHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  workingTreeMeasurement: true, generatedAt: new Date().toISOString(), node: process.versions.node,
  sqlite: f.raw.prepare('SELECT sqlite_version() version').get()!.version, populations: [],
  method: 'One Workflow, one real bounded needs_input model application per Source. Three reads at page50/page200; materialize batches100. Test-only BEGIN/COMMIT timing; no integrity checks disabled. All providers/identity synthetic; no HTTP.',
  limitations: 'Warm shared cloud run; memory is sampled in one process without forced GC. Setup includes synthetic model calls; delivery does not call them. Transaction timing includes instrumentation overhead.' };
const persist = () => writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
let created = 0;
try {
  for (const population of populations) {
    const setup = await measure(async () => {
      for (; created < population; created++) {
        const plan = api.createPlan({ ...f.input(), workflowRunId, requestId: `capacity-${created}` }, f.credential);
        const response = await api.startAuthorized(plan.planId, f.credential);
        assert.equal(response.inputRequest?.state, 'AWAITING_INPUT');
        if ((created + 1) % 100 === 0) process.stdout.write(`Created ${created + 1} canonical Sources in one Workflow\n`);
      }
    });
    assert.equal(f.raw.prepare('SELECT count(*) n FROM notification_sources WHERE workflow_run_id=?').get(workflowRunId)!.n, population);
    const before = businessDigest(), calls = { ...f.counts }, reads = [];
    for (const limit of [50, 200]) for (let sample = 0; sample < 3; sample++) {
      const measurement = await measure(() => notifications.notifications.read(viewer, { workflowRunId, limit }));
      assert.equal(measurement.value.items.length, Math.min(limit, population));
      const { value: _page, ...timing } = measurement; reads.push({ limit, sample, ...timing });
    }
    const batches = [];
    while (Number(f.raw.prepare('SELECT count(*) n FROM notification_deliveries WHERE workflow_run_id=?').get(workflowRunId)!.n) < population) {
      const previousCount = Number(f.raw.prepare('SELECT count(*) n FROM notification_deliveries WHERE workflow_run_id=?').get(workflowRunId)!.n);
      const measurement = await measure(() => notifications.notifications.materialize(service, { workflowRunId, limit: 100 }));
      assert.equal(measurement.value.code, 'NOTIFICATION_SERVICE_CYCLE_COMPLETE');
      assert.ok(Number(f.raw.prepare('SELECT count(*) n FROM notification_deliveries WHERE workflow_run_id=?').get(workflowRunId)!.n) > previousCount, 'materialization must progress');
      const { value: _ack, ...timing } = measurement; batches.push(timing);
    }
    assert.equal(businessDigest(), before); assert.deepEqual(f.counts, calls); assert.equal(httpCalls, 0);
    assert.equal(f.counts.action, 0); assert.equal(f.counts.verify, 0); assert.equal(f.counts.plan, 0);
    const { value: _setup, ...setupTiming } = setup;
    (result.populations as unknown[]).push({ population, journalEvents: f.raw.prepare('SELECT count(*) n FROM journal_events WHERE workflow_run_id=?').get(workflowRunId)!.n,
      setup: setupTiming, reads, materializeBatches: batches, modelCallsDuringSetup: f.counts.draft, modelCallsDuringDelivery: 0, httpCalls });
    persist(); process.stdout.write(`Measured ${population} Sources / Deliveries in one Workflow\n`);
  }
  result.completed = true; persist();
} finally {
  DatabaseSync.prototype.exec = originalExec; notifications.close(); manager.release(lease);
  for (const close of cleanup.reverse()) close();
  result.temporaryDatabaseRemoved = true; persist();
}
