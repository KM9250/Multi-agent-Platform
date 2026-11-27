import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setImmediate as yieldTurn, setTimeout as delay } from "node:timers/promises";
import { noteLoadFixture } from "../memory-note-load-fixture.ts";
import { withVerifiedNoteAncestors } from "../../server/memory/source-validation.ts";
import { readNote } from "../../server/memory/notes.ts";
import { SessionService } from "../../server/auth/sessions.ts";
import { createAppHandler } from "../../server/http/server.ts";
import { shutdownIndexWorkers } from "../../server/search/index.ts";

const count = Number(process.argv[2] ?? 1024), trials = Number(process.argv[3] ?? 5);
assert.ok(Number.isSafeInteger(count) && count >= 64 && count <= 2048);
assert.ok(Number.isSafeInteger(trials) && trials >= 1 && trials <= 20);
const f = await noteLoadFixture(count), server = createServer();
function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? 0;
  return { count: values.length, p50Ms: at(0.5), p95Ms: at(0.95), maxMs: at(1) };
}
try {
  const sessions = new SessionService(f.app), username = "ancestor-reader", password = "synthetic ancestor password";
  await sessions.createAccount({ username, password, workspaceId: f.actor.workspaceId });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  server.on("request", createAppHandler({ app: f.app, sessions, policy: f.policy, repository: f.repository,
    attachments: f.attachmentStore, origin, development: true }));
  const login = await fetch(origin + "/api/app/v1/session/login", { method: "POST", headers: { origin,
    "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) });
  assert.equal(login.status, 200); await login.json();
  const headers = { origin, Cookie: login.headers.get("set-cookie")!.split(";")[0] };
  const http: number[] = [], validation: number[] = [], writers: number[] = [];
  const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable();
  let running = true;
  const reader = (async () => {
    while (running) {
      const start = performance.now();
      const response = await fetch(origin + "/api/app/v1/rooms/" + f.room.id + "/messages?limit=20", { headers });
      assert.equal(response.status, 200); await response.json(); http.push(performance.now() - start);
      await yieldTurn();
    }
  })();
  for (let i = 0; i < trials; i++) {
    const start = performance.now();
    await withVerifiedNoteAncestors(f.app, [f.rootNote], () => {
      const writer = performance.now();
      f.app.transaction(() => assert.equal(readNote(f.app, f.policy, f.actor, f.rootNote).body, "予定は月曜"), "note_validation_boundary");
      writers.push(performance.now() - writer);
    });
    validation.push(performance.now() - start);
  }
  running = false; await reader; await delay(20); loop.disable();
  const plan = f.app.db.prepare(`EXPLAIN QUERY PLAN SELECT n.* FROM memory_dependencies d JOIN memory_documents n
    ON n.workspace_id=d.workspace_id AND n.room_id=d.room_id AND n.note_id=d.resource_id
    WHERE d.candidate_id=? AND d.resource_type='NOTE' AND d.resource_id>? ORDER BY d.resource_id LIMIT 32`)
    .all(f.rootCandidate, "");
  process.stdout.write(JSON.stringify({ kind: "MEM-3A live ancestor revalidation outside writer / authenticated HTTP",
    node: process.version, ancestorNotes: count, trials, pageSize: 32,
    validation: distribution(validation), writerBoundaries: distribution(writers), httpReads: distribution(http),
    eventLoop: { p95Ms: loop.percentile(95) / 1e6, maxMs: loop.max / 1e6 },
    realExternalCalls: 0, queryPlan: plan,
    scope: "Synthetic flattened NOTE dependencies isolate fresh file/authority gate cost. Every trial rereads every ancestor; final metadata comparison is outside writer. No production latency claim.",
  }, null, 2) + "\n");
} finally {
  if (server.listening) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  await shutdownIndexWorkers(f.app); f.close();
}
