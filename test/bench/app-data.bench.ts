/** Synthetic local HTTP benchmark; never reads a production database or calls a provider. */
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir, cpus, platform, release, totalmem } from "node:os";
import { join } from "node:path";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { createServer } from "node:net";
import { once } from "node:events";
import { AppDatabase } from "../../server/app-data/db.ts";
import { ConversationRepository } from "../../server/app-data/repository.ts";
import { AuthorizationPolicy } from "../../server/auth/authorization.ts";
import { SessionService } from "../../server/auth/sessions.ts";
import { AttachmentStore } from "../../server/attachments/store.ts";
import { ImportService } from "../../server/operations/import.ts";
import { createAppServer } from "../../server/http/server.ts";
import { digest, canonical } from "../../server/app-data/validation.ts";
import { DurableDatabase } from "../../services/coordination/durable/db.ts";
import { SqliteCoordinationRunnerStore } from "../../services/coordination/durable/durableCoordinationStore.ts";
import { fresh } from "../notification-fixture.ts";
import { notificationProcessHost } from "../notification-process-host.ts";
import { DurableNotificationWorker } from "../../services/coordination/durable/notificationDeliveryWorker.ts";
import { projectCoordinationNotifications } from "../../services/coordination/notifications/projector.ts";

const root = mkdtempSync(join(tmpdir(), "map-app-bench-"));
chmodSync(root, 0o700);
const dataRoot = join(root, "application"),
  coordRoot = join(root, "coord");
let app = new AppDatabase({ root: dataRoot }),
  server: ReturnType<typeof createAppServer> | undefined,
  coord: DurableDatabase | undefined;
let heartbeat: ReturnType<typeof setInterval> | undefined;
let notificationHost: ReturnType<typeof notificationProcessHost> | undefined;
let notificationWorker: DurableNotificationWorker | undefined;
const pause = () => new Promise<void>((resolve) => setImmediate(resolve));
const percentile = (values: number[], p: number) =>
  [...values].sort((a, b) => a - b)[
    Math.min(values.length - 1, Math.ceil(values.length * p) - 1)
  ];
try {
  let sessions = new SessionService(app),
    policy = new AuthorizationPolicy(app),
    repository = new ConversationRepository(app, policy);
  const actor = await sessions.createAccount({
    username: "benchmark-user",
    password: "synthetic benchmark password only",
  });
  const room = repository.createRoom(actor, {
      title: "100,000 synthetic messages",
    }),
    count = 100000;
  const text = "Synthetic benchmark conversation message. No real user data.",
    hash = digest(text),
    revisionHash = digest(
      canonical([
        { channel: "public_message", visibility: "public", content: text },
      ]),
    );
  const insert = app.db.prepare(
      "INSERT INTO messages VALUES(?,?,?,?,1,'user',NULL,?,?,?,NULL)",
    ),
    revision = app.db.prepare(
      "INSERT INTO message_revisions VALUES(?,?,?,1,?,NULL,?,'benchmark',?)",
    ),
    segment = app.db.prepare(
      "INSERT INTO message_segments VALUES(?,?,?,1,?,'public_message','public',NULL,?,?)",
    );
  const seedStart = performance.now();
  for (let start = 1; start <= count; start += 500) {
    app.transaction(() => {
      for (let n = start; n < Math.min(start + 500, count + 1); n++) {
        const id = `bench-${n}`;
        insert.run(
          actor.workspaceId,
          room.id,
          id,
          n,
          1700000000000 + n,
          1700000000000 + n,
          1700000000000 + n,
        );
        revision.run(
          actor.workspaceId,
          room.id,
          id,
          `revision-${n}`,
          revisionHash,
          1700000000000 + n,
        );
        segment.run(actor.workspaceId, room.id, id, `segment-${n}`, text, hash);
      }
    });
    await pause();
  }
  app.db
    .prepare("UPDATE rooms SET next_seq=? WHERE workspace_id=? AND room_id=?")
    .run(count + 1, actor.workspaceId, room.id);
  const seedMs = performance.now() - seedStart;
  app.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  app.close();
  // Reopen connection: cold connection measurement; OS page cache is intentionally not purged.
  app = new AppDatabase({ root: dataRoot });
  sessions = new SessionService(app);
  policy = new AuthorizationPolicy(app);
  repository = new ConversationRepository(app, policy);
  const portProbe = createServer();
  portProbe.listen(0, "127.0.0.1");
  await once(portProbe, "listening");
  const port = (portProbe.address() as any).port;
  await new Promise<void>((r) => portProbe.close(() => r()));
  const origin = `http://127.0.0.1:${port}`,
    attachments = new AttachmentStore(app, policy);
  server = createAppServer({
    app,
    sessions,
    policy,
    repository,
    attachments,
    origin,
    development: true,
  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  const login = await fetch(`${origin}/api/app/v1/session/login`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "benchmark-user",
      password: "synthetic benchmark password only",
    }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  await login.arrayBuffer();
  const endpoint = `${origin}/api/app/v1/rooms/${room.id}/messages?limit=50`;
  async function read(cursor?: string) {
    const start = performance.now();
    const res = await fetch(
      endpoint + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""),
      { headers: { Cookie: cookie } },
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.messages.length, 50);
    return { ms: performance.now() - start, body };
  }
  const cold = await read(),
    warm: number[] = [];
  for (let n = 0; n < 50; n++) warm.push((await read()).ms);
  const concurrent: number[] = [];
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      for (let n = 0; n < 25; n++) concurrent.push((await read()).ms);
    }),
  );
  const second = await read(cold.body.cursor);
  assert.notEqual(second.body.messages[49].id, cold.body.messages[49].id);
  const writeTimes: number[] = [];
  for (let n = 0; n < 50; n++) {
    const start = performance.now();
    repository.appendMessage(actor, room.id, {
      role: "user",
      content: `Synthetic saved ${n}`,
    });
    writeTimes.push(performance.now() - start);
  }

  // The durable COORD runtime runs beside import in the same event loop. Its transport
  // is injected in process: no HTTP receiver, external notification or real credential.
  const notificationWorkflowIds = Array.from(
    { length: 20 },
    (_, index) => `coexist-notification-${index}`,
  );
  const notificationEnqueuedAt = new Map<string, number>();
  const notificationSendIds = new Set<string>();
  const notificationDelayMs: number[] = [];
  let notificationTransportSends = 0,
    notificationTransportFailures = 0;
  let notificationDeliveredDuringImport = 0,
    importActive = false,
    importedItems = 0;
  notificationHost = notificationProcessHost(
    join(coordRoot, "coordination.sqlite"),
    "http://127.0.0.1:1/api/notify",
    {
      async send(packet, signal) {
        notificationTransportSends++;
        try {
          assert.equal(signal?.aborted, false);
          assert.ok(
            !notificationSendIds.has(packet.task_id),
            "Synthetic notification was sent twice",
          );
          const enqueuedAt = notificationEnqueuedAt.get(packet.task_id);
          assert.notEqual(
            enqueuedAt,
            undefined,
            "Only this benchmark's notifications may be delivered",
          );
          notificationSendIds.add(packet.task_id);
          await pause();
          assert.equal(signal?.aborted, false);
          notificationDelayMs.push(performance.now() - enqueuedAt!);
          if (importActive) notificationDeliveredDuringImport++;
          return {
            taskId: packet.task_id,
            eventId: notificationTransportSends,
            idempotentReplay: false,
            httpStatus: 201,
          };
        } catch (error) {
          notificationTransportFailures++;
          throw error;
        }
      },
    },
  );
  coord = notificationHost.db;
  new SqliteCoordinationRunnerStore(coord).createWorkflow(fresh("coexistence"));
  const notificationWorkflows = notificationWorkflowIds.map((id) => {
    const workflow = notificationHost!.create(id);
    workflow.release();
    return id;
  });
  const notificationStore = new SqliteCoordinationRunnerStore(coord);
  const notificationLeases = coord.createLeaseManager();
  notificationWorker = new DurableNotificationWorker(
    coord.notifications,
    notificationHost.service,
    { workflowRunIds: notificationWorkflows, pollIntervalMs: 100 },
  );
  const leases = coord.createLeaseManager({
    ttlMs: 30000,
    heartbeatIntervalMs: 1000,
  });
  let lease = leases.acquire("coexistence"),
    renewals = 0,
    renewalErrors = 0,
    last = performance.now();
  const gaps: number[] = [];
  heartbeat = setInterval(() => {
    const now = performance.now();
    gaps.push(now - last);
    last = now;
    try {
      lease = leases.renew(lease);
      renewals++;
    } catch {
      renewalErrors++;
    }
  }, 100);
  const lag = monitorEventLoopDelay({ resolution: 10 });
  lag.enable();
  await new Promise((r) => setTimeout(r, 30));
  const importer = new ImportService(app, repository, attachments, policy, {
      afterItem(kind) {
        if (kind !== "message" || ++importedItems % 100 !== 0) return;
        const workflowRunId = notificationWorkflowIds[importedItems / 100 - 1];
        const notificationLease = notificationLeases.acquire(workflowRunId);
        try {
          const store = notificationStore.withLease(notificationLease);
          const snapshot = store.getSnapshot(workflowRunId);
          const cancelled = store.append({
            eventId: `bench-cancel-${workflowRunId}`,
            sequence: snapshot.events.length + 1,
            workflowRunId,
            actorAgentId: snapshot.run.supervisorAgentId,
            timestamp: Date.now(),
            type: "WorkflowCancelled",
            payload: { reason: "synthetic import coexistence" },
          });
          const notifications = projectCoordinationNotifications(cancelled);
          assert.equal(notifications.length, 1);
          notificationEnqueuedAt.set(
            notifications[0].notificationId,
            performance.now(),
          );
        } finally {
          notificationLeases.release(notificationLease);
        }
      },
    }),
    legacy = {
      sourceId: "synthetic-benchmark-import",
      rooms: [
        {
          id: "old-room",
          title: "Synthetic import coexistence",
          description: "",
          type: "Sandbox",
          agents: [],
          messages: Array.from({ length: 2000 }, (_, i) => ({
            id: `old-${i}`,
            role: "user",
            content: `Imported synthetic ${i}`,
            timestamp: 1600000000000 + i,
          })),
          updatedAt: 1600000000000,
        },
      ],
    };
  const importStart = performance.now();
  importActive = true;
  notificationWorker.start();
  const result = await importer.start(actor, {
    ...legacy,
    requestId: "benchmark-import",
  });
  const importMs = performance.now() - importStart;
  importActive = false;
  assert.equal(result.status, "COMPLETE");
  assert.equal(notificationEnqueuedAt.size, notificationWorkflowIds.length);
  const notificationDrainStart = performance.now();
  while (
    Number(
      notificationHost.raw
        .prepare("SELECT count(*) n FROM notification_delivery_receipts")
        .get()!.n,
    ) < notificationWorkflowIds.length &&
    performance.now() - notificationDrainStart < 5000
  ) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const notificationDrained = await notificationWorker.stop(1000);
  notificationWorker = undefined;
  const notificationDrainMs = performance.now() - notificationDrainStart;
  const notificationAttempts = Number(
    notificationHost.raw
      .prepare("SELECT count(*) n FROM notification_delivery_attempts")
      .get()!.n,
  );
  const notificationDelivered = Number(
    notificationHost.raw
      .prepare("SELECT count(*) n FROM notification_delivery_receipts")
      .get()!.n,
  );
  const notificationFailedAttempts = Number(
    notificationHost.raw
      .prepare(
        "SELECT count(*) n FROM notification_delivery_attempts WHERE state<>'RECEIVED'",
      )
      .get()!.n,
  );
  const notificationPending = Number(
    notificationHost.raw
      .prepare(
        "SELECT count(*) n FROM notification_deliveries WHERE state<>'DELIVERED'",
      )
      .get()!.n,
  );
  await new Promise((r) => setTimeout(r, 150));
  lag.disable();
  clearInterval(heartbeat);
  heartbeat = undefined;
  leases.assertCurrent(lease);
  leases.release(lease);
  const report = {
    corpus: {
      messages: count,
      bodyBytes: Buffer.byteLength(text),
      concurrentReaders: 4,
      samples: { warm: warm.length, concurrent: concurrent.length },
      coldMeaning: "New SQLite connection, OS cache not flushed",
    },
    environment: {
      node: process.version,
      sqlite: app.db.prepare("SELECT sqlite_version() v").get()!.v,
      platform: platform(),
      kernel: release(),
      cpu: cpus()[0]?.model,
      logicalCPUs: cpus().length,
      totalMemoryBytes: totalmem(),
    },
    seedMs,
    coldConnectionHttpMs: cold.ms,
    warmHttp: { p50Ms: percentile(warm, 0.5), p95Ms: percentile(warm, 0.95) },
    concurrentHttp: {
      p50Ms: percentile(concurrent, 0.5),
      p95Ms: percentile(concurrent, 0.95),
    },
    write: {
      p50Ms: percentile(writeTimes, 0.5),
      p95Ms: percentile(writeTimes, 0.95),
    },
    rssBytes: process.memoryUsage().rss,
    databaseBytes: statSync(app.path).size,
    coexistence: {
      importMessages: 2000,
      importMs,
      heartbeatIntervalMs: 100,
      renewals,
      renewalErrors,
      maxHeartbeatGapMs: Math.max(...gaps),
      eventLoopP95Ms: lag.percentile(95) / 1e6,
      eventLoopMaxMs: lag.max / 1e6,
      notificationDelivery: {
        runtime:
          "DurableNotificationWorker / COORD-5D: durable claims, intents and receipts",
        transport: "Injected in-process synthetic ACK; zero HTTP requests",
        httpRequests: 0,
        scheduled: notificationWorkflowIds.length,
        producer: "One WorkflowCancelled event per 100 imported messages",
        workerPollIntervalMs: 100,
        transportSends: notificationTransportSends,
        attempts: notificationAttempts,
        delivered: notificationDelivered,
        deliveredDuringImport: notificationDeliveredDuringImport,
        failedAttempts: notificationFailedAttempts,
        transportFailures: notificationTransportFailures,
        pending: notificationPending,
        enqueueToAckP95Ms: percentile(notificationDelayMs, 0.95),
        enqueueToAckMaxMs: Math.max(...notificationDelayMs),
        drainMs: notificationDrainMs,
        drained: notificationDrained.drained,
      },
    },
    latest50TargetMet:
      percentile(warm, 0.95) < 1000 && percentile(concurrent, 0.95) < 1000,
  };
  console.log(JSON.stringify(report, null, 2));
  assert.equal(renewalErrors, 0);
  assert.equal(notificationTransportFailures, 0);
  assert.equal(notificationFailedAttempts, 0);
  assert.equal(notificationPending, 0);
  assert.equal(notificationAttempts, notificationWorkflowIds.length);
  assert.equal(notificationDelivered, notificationWorkflowIds.length);
  assert.equal(notificationTransportSends, notificationWorkflowIds.length);
  assert.ok(
    notificationDeliveredDuringImport > 0,
    "Notification delivery must overlap import",
  );
  assert.equal(notificationDrained.drained, true);
  assert.ok(
    report.latest50TargetMet,
    "Latest-50 p95 exceeds provisional one-second target",
  );
} finally {
  if (heartbeat) clearInterval(heartbeat);
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((r) => server!.close(() => r()));
  }
  if (notificationWorker) await notificationWorker.stop(1000);
  if (notificationHost) notificationHost.close();
  else coord?.close();
  app.close();
  rmSync(root, { recursive: true, force: true });
}
