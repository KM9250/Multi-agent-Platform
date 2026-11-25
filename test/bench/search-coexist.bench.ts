/** Runs real loopback HTTP, index/query workers and COORD lease renewal against disposable synthetic roots. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import {
  availableParallelism,
  cpus,
  platform,
  release,
  tmpdir,
  totalmem,
} from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { AppDatabase } from "../../server/app-data/db.ts";
import { ConversationRepository } from "../../server/app-data/repository.ts";
import { AttachmentStore } from "../../server/attachments/store.ts";
import { AuthorizationPolicy } from "../../server/auth/authorization.ts";
import { SessionService } from "../../server/auth/sessions.ts";
import { createAppHandler } from "../../server/http/server.ts";
import { acquireHostLock } from "../../server/operations/locks.ts";
import {
  indexWorkerStatus,
  requestIndexUpdate,
  shutdownIndexWorkers,
} from "../../server/search/index.ts";
import { DurableDatabase } from "../../services/coordination/durable/db.ts";
import { SqliteCoordinationRunnerStore } from "../../services/coordination/durable/durableCoordinationStore.ts";
import type { SearchResponse } from "../../shared/search-contracts.ts";
import { fresh } from "../notification-fixture.ts";

function numericArgument(
  index: number,
  fallback: number,
  min: number,
  max: number,
) {
  const n = Number(process.argv[index] ?? fallback);
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw new Error(
      "usage: bench:search-coexist -- [messages 10..100000] [trials 1..100]",
    );
  return n;
}
function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) =>
    sorted[Math.ceil(p * sorted.length) - 1] ?? null;
  return {
    count: values.length,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    maxMs: percentile(1),
  };
}
function bytes(path: string): number {
  const stat = statSync(path);
  return stat.isDirectory()
    ? readdirSync(path).reduce((n, name) => n + bytes(join(path, name)), 0)
    : stat.size;
}

const count = numericArgument(2, 1000, 10, 100000);
const trials = numericArgument(3, 10, 1, 100);
const root = mkdtempSync(join(tmpdir(), "map-search-coexist-"));
const app = new AppDatabase({ root: join(root, "app") });
const releaseHost = acquireHostLock(app.root);
const coord = new DurableDatabase({
  path: join(root, "coord", "coordination.sqlite"),
});
const server = createServer();
try {
  const sessions = new SessionService(app);
  const policy = new AuthorizationPolicy(app);
  const repository = new ConversationRepository(app, policy);
  const username = "search-bench";
  const password = "synthetic benchmark user password";
  const actor = await sessions.createAccount({ username, password });
  const room = repository.createRoom(actor, { title: "Synthetic archive" });
  const secondary = repository.createRoom(actor, {
    title: "Worker queue fixture",
  });
  const query = "牡丹観測記録";
  const anchor = Date.UTC(2026, 10, 9, 10);
  let marker = "";
  let historical = 0,
    bodyUnits = 0;
  const seedStart = performance.now();
  for (let start = 0; start < count; start += 100) {
    app.transaction(() => {
      for (let n = start; n < Math.min(start + 100, count); n++) {
        const content =
          n === 0
            ? query + "の観測地点を共有しました。"
            : "合成会話です。保存済みの議事録を確認しました。DB 設計番号 " + n;
        bodyUnits += content.length;
        const message = repository.appendMessage(actor, room.id, {
          role: "user",
          content,
          occurredAt: anchor - (n % 30) * 86_400_000,
        });
        if (n === 0) marker = message.id;
        if (n % 20 === 19) {
          repository.correctMessage(actor, room.id, message.id, {
            expectedRevision: 1,
            content: content + "（訂正済み）",
          });
          historical++;
        }
      }
    });
  }
  const seedMs = performance.now() - seedStart;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const endpoint = server.address();
  assert.ok(endpoint && typeof endpoint === "object");
  const origin = "http://127.0.0.1:" + endpoint.port;
  server.on(
    "request",
    createAppHandler({
      app,
      sessions,
      policy,
      repository,
      attachments: new AttachmentStore(app, policy),
      origin,
      development: true,
    }),
  );
  const login = await fetch(origin + "/api/app/v1/session/login", {
    method: "POST",
    headers: { origin, "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(login.status, 200);
  const headers = {
    origin,
    "Content-Type": "application/json",
    Cookie: login.headers.get("set-cookie")!.split(";")[0],
    "x-csrf-token": (await login.json()).csrfToken as string,
  };
  const searchEndpoint = origin + "/api/app/v1/rooms/" + room.id + "/search";
  const statusCounts: Record<string, number> = {};
  const reasonCounts: Record<string, number> = {};
  const responses = { externalCalls: 0, verified: 0, excluded: 0 };
  async function search(text: string, messageId: string, timed: boolean) {
    const start = performance.now();
    const date = timed
      ? { mode: "approx", anchorDate: "2026-11-11", timeZone: "Asia/Tokyo" }
      : undefined;
    const request = {
      requestId: randomUUID(),
      target: "archive",
      revisionMode: "current",
      retrievalMode: "lexical",
      query: text,
      date,
    };
    const res = await fetch(searchEndpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
    });
    const body: SearchResponse = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.ok(
      body.results.some(
        (r) =>
          r.citation.target === "archive" && r.citation.messageId === messageId,
      ),
      JSON.stringify({ status: body.status, reasons: body.reasons }),
    );
    assert.deepEqual(body.methods, ["lexical"]);
    statusCounts[body.status] = (statusCounts[body.status] ?? 0) + 1;
    for (const reason of body.reasons)
      reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
    responses.externalCalls += body.external.calls ?? 0;
    responses.verified += body.verification.checked;
    responses.excluded += body.verification.excluded;
    return performance.now() - start;
  }

  new SqliteCoordinationRunnerStore(coord).createWorkflow(
    fresh("search-coexist"),
  );
  const leases = coord.createLeaseManager({
    ttlMs: 30000,
    heartbeatIntervalMs: 1000,
  });
  let lease = leases.acquire("search-coexist");
  let saves = 0;
  let peakServerRss = process.memoryUsage().rss;
  const hostMetrics = indexWorkerStatus();
  async function sample(
    work: () => Promise<unknown>,
    writeRoom = secondary.id,
  ) {
    const save: number[] = [],
      gaps: number[] = [];
    const lag = monitorEventLoopDelay({ resolution: 10 });
    lag.enable();
    let renewalErrors = 0,
      writeErrors = 0,
      last = performance.now(),
      peakQueue = 0;
    const heartbeat = setInterval(() => {
      const now = performance.now();
      gaps.push(now - last);
      last = now;
      try {
        lease = leases.renew(lease);
      } catch {
        renewalErrors++;
      }
      peakServerRss = Math.max(peakServerRss, process.memoryUsage().rss);
      peakQueue = Math.max(peakQueue, indexWorkerStatus().queued);
    }, 50);
    // Baseline, build and delta use a separate stream. Query trials save into the searched room.
    const writer = setInterval(() => {
      const start = performance.now();
      try {
        repository.appendMessage(actor, writeRoom, {
          role: "user",
          content: "併存測定の会話 " + saves++,
        });
        save.push(performance.now() - start);
      } catch {
        writeErrors++;
      }
    }, 80);
    const start = performance.now();
    try {
      await work();
    } finally {
      clearInterval(writer);
      clearInterval(heartbeat);
      lag.disable();
    }
    assert.equal(renewalErrors, 0);
    assert.equal(writeErrors, 0);
    return {
      ms: performance.now() - start,
      save: distribution(save),
      heartbeatGap: distribution(gaps),
      renewalErrors,
      writeErrors,
      eventLoopP95Ms: lag.percentile(95) / 1e6,
      eventLoopMaxMs: lag.max / 1e6,
      peakQueue,
    };
  }
  const baseline = await sample(() => delay(1200));
  let buildMs = 0;
  let builtGeneration = "";
  const build = await sample(async () => {
    const start = performance.now();
    const primary = requestIndexUpdate(app, policy, actor, room.id, {
      rebuild: true,
    }).then((id) => {
      builtGeneration = id;
      buildMs = performance.now() - start;
    });
    const queued = requestIndexUpdate(app, policy, actor, secondary.id, {
      rebuild: true,
    });
    await Promise.all([primary, queued]);
  });
  const deltaQuery = "綿毛実験台帳";
  const added = repository.appendMessage(actor, room.id, {
    role: "user",
    content: deltaQuery + "を登録",
  });
  const delta = await sample(async () => {
    const updated = await requestIndexUpdate(app, policy, actor, room.id, {
      force: true,
    });
    assert.equal(
      updated,
      builtGeneration,
      "the measured delta must update the same generation",
    );
  });
  const deltaVerificationMs = await search(deltaQuery, added.id, false);
  const lexical: number[] = [],
    dated: number[] = [];
  const queries = await sample(async () => {
    for (let i = 0; i < trials; i++) {
      lexical.push(await search(query, marker, false));
      dated.push(await search(query, marker, true));
    }
  }, room.id);
  // The last HTTP search may have requested a delta. Wait for that worker before
  // measuring cancellation of a fresh rebuild on this partition.
  await requestIndexUpdate(app, policy, actor, room.id, { force: true });
  await delay(0);
  const timer = new AbortController();
  const activeJob = requestIndexUpdate(app, policy, actor, room.id, {
    rebuild: true,
    signal: timer.signal,
  });
  await delay(20);
  const cancelledAt = performance.now();
  timer.abort();
  await assert.rejects(activeJob, /SEARCH_JOB_CANCELLED/);
  const cancelMs = performance.now() - cancelledAt;
  await shutdownIndexWorkers(app);
  await delay(0);
  const workers = indexWorkerStatus();
  assert.equal(workers.running, 0);
  assert.equal(workers.queued, 0);
  assert.equal(responses.externalCalls, 0);
  const external = app.db
    .prepare(
      `SELECT count(*) calls,count(usage_json) recordedUsage,count(estimated_cost_micros) estimatedCosts
    FROM search_operations`,
    )
    .get();
  assert.equal(external!.calls, 0);
  leases.release(lease);
  console.log(
    JSON.stringify(
      {
        schema: "MAP-MEM-2:COEXIST-BENCH:1",
        environment: {
          node: process.version,
          sqlite: app.db.prepare("SELECT sqlite_version() v").get()!.v,
          platform: platform(),
          kernel: release(),
          cpu: cpus()[0]?.model,
          parallelism: availableParallelism(),
          hostRamBytes: totalmem(),
        },
        corpus: {
          messages: count,
          deltaMessages: 1,
          furtherPublicMessagesDuringQueryTrials: queries.save.count,
          historyRevisions: historical,
          meanInitialBodyUtf16: bodyUnits / count,
          sourceScope: "public_message/public",
          denseProfiles: 0,
          queryTrialsPerMode: trials,
          heartbeatIntervalMs: 50,
          saveIntervalMs: 80,
        },
        seedMs,
        baseline,
        build,
        buildPrimaryMs: buildMs,
        delta,
        deltaVerificationHttpMs: deltaVerificationMs,
        queries,
        lexicalHttp: distribution(lexical),
        approxDateHttp: distribution(dated),
        responses,
        statusCounts,
        reasonCounts,
        queryWorkload: {
          text: query,
          transport:
            "HTTP over loopback; session reused; lexical worker startup and final source checks included",
          date: "approx 2026-11-11 Asia/Tokyo; reference recorded November 9",
          cache:
            "no OS cache flush; timed trials follow build, delta and an initial HTTP probe",
        },
        external,
        indexWorkers: {
          started: workers.started - hostMetrics.started,
          completed: workers.completed - hostMetrics.completed,
          cancelled: workers.cancelled - hostMetrics.cancelled,
          failed: workers.failed - hostMetrics.failed,
          queueWaitTotalMs: workers.waitMs - hostMetrics.waitMs,
          maxConcurrent: workers.maxConcurrent,
          cancelAndExitMs: cancelMs,
          limits: workers.limits,
        },
        derivedBytesAllPartitions: bytes(join(app.root, "search-index")),
        serverAndThreadsSampledPeakRssBytes: peakServerRss,
        rssScope:
          "node parent including worker threads, excluding forked lexical processes",
      },
      null,
      2,
    ),
  );
} finally {
  await shutdownIndexWorkers(app);
  if (server.listening) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  coord.close();
  releaseHost();
  app.close();
  rmSync(root, { recursive: true, force: true });
}
