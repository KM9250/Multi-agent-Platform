/** Synthetic CALL/NOTE frontier with authenticated ordinary HTTP reads between bounded writer slices. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setImmediate as yieldTurn, setTimeout as delay } from "node:timers/promises";
import { lineageFixture } from "../memory-lineage-fixture.ts";
import { permissions, share, answerUsing } from "../memory-context-fixture.ts";
import { advanceLineage } from "../../server/memory/lineage.ts";
import { SessionService } from "../../server/auth/sessions.ts";
import { createAppHandler } from "../../server/http/server.ts";
import { shutdownIndexWorkers } from "../../server/search/index.ts";

const f = lineageFixture(), server = createServer();
const turns = Number(process.argv[2] ?? 160), notes = Number(process.argv[3] ?? 6);
assert.ok(Number.isSafeInteger(turns) && turns >= 20 && turns <= 500);
assert.ok(Number.isSafeInteger(notes) && notes >= 2 && notes <= 20);
function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? 0;
  return { count: values.length, p50Ms: at(0.5), p95Ms: at(0.95), maxMs: at(1) };
}
try {
  permissions(f);
  f.repository.updatePersona(f.actor, f.room.id, f.persona.id, { expectedRevision: 2, contextMode: "none" });
  f.original();
  for (let n = 0; n < turns; n++) await f.turn("Synthetic prior answer " + n);
  let last = await f.memory(); share(f, last.candidate.id);
  for (let n = 1; n < notes; n++) {
    await answerUsing(f, last.noteId);
    last = await f.memory(); share(f, last.candidate.id);
  }
  await answerUsing(f, last.noteId);
  const target = await f.memory();
  assert.equal(target.candidate.state, "LINEAGE_PENDING");
  const sessions = new SessionService(f.app);
  const username = "lineage-reader", password = "synthetic lineage password";
  await sessions.createAccount({ username, password, workspaceId: f.actor.workspaceId });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  server.on("request", createAppHandler({ app: f.app, sessions, policy: f.policy, repository: f.repository,
    attachments: f.attachmentStore, origin, development: true }));
  const login = await fetch(origin + "/api/app/v1/session/login", { method: "POST",
    headers: { origin, "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) });
  assert.equal(login.status, 200); await login.json();
  const headers = { origin, Cookie: login.headers.get("set-cookie")!.split(";")[0] };
  const endpoint = origin + "/api/app/v1/rooms/" + f.room.id + "/messages?limit=20";
  const http: number[] = [], slices: number[] = [], callIncrements: number[] = [];
  const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable();
  let running = true, reads = 0;
  const reader = (async () => {
    while (running) {
      const start = performance.now(), response = await fetch(endpoint, { headers });
      assert.equal(response.status, 200); await response.json();
      http.push(performance.now() - start); reads++;
      await yieldTurn();
    }
  })();
  const work = f.app.db.prepare("SELECT calls_done,notes_done,status FROM memory_lineage_work WHERE candidate_id=?");
  const started = performance.now();
  let before = Number(work.get(target.candidate.id)!.calls_done);
  while (true) {
    const start = performance.now(), advanced = advanceLineage(f.app);
    if (!advanced) break;
    slices.push(performance.now() - start);
    const now = Number(work.get(target.candidate.id)!.calls_done);
    callIncrements.push(now - before); before = now;
    await yieldTurn();
  }
  running = false; await reader; await delay(20); loop.disable();
  const final = work.get(target.candidate.id)!;
  assert.equal(final.status, "DONE"); assert.equal(final.notes_done, notes);
  assert.ok(callIncrements.every(n => n >= 0 && n <= 4)); assert.ok(reads > 0);
  const plans = {
    calls: f.app.db.prepare("EXPLAIN QUERY PLAN SELECT call_id FROM memory_lineage_queue WHERE candidate_id=? AND checked=0 ORDER BY call_id LIMIT 1").all(target.candidate.id),
    notes: f.app.db.prepare("EXPLAIN QUERY PLAN SELECT * FROM memory_lineage_notes WHERE candidate_id=? AND checked=0 ORDER BY note_id LIMIT 1").all(target.candidate.id),
    dependencies: f.app.db.prepare("EXPLAIN QUERY PLAN SELECT * FROM memory_dependencies WHERE candidate_id=? AND resource_type='NOTE'").all(target.candidate.id),
    authorities: f.app.db.prepare("EXPLAIN QUERY PLAN SELECT * FROM memory_authorities WHERE candidate_id=? AND (actor_id,operation,room_id,persona_id,visibility)>(?,?,?,?,?) ORDER BY actor_id,operation,room_id,persona_id,visibility LIMIT 32").all(target.candidate.id, "", "", "", "", ""),
  };
  const result = {
    kind: "MEM-3A synthetic mixed lineage / authenticated loopback HTTP", node: process.version,
    seededAnswers: turns, noteDepth: notes, durationMs: performance.now() - started,
    final: { calls: Number(final.calls_done), notes: Number(final.notes_done), state: final.status },
    writerSlices: distribution(slices), httpReads: distribution(http),
    eventLoop: { p95Ms: loop.percentile(95) / 1e6, maxMs: loop.max / 1e6 },
    maxCallsPerSlice: Math.max(...callIncrements), realExternalCalls: 0, plans,
    scope: "Measures one synthetic run and bounded frontier advancement; not production latency or provider quality.",
  };
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} finally {
  if (server.listening) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  await shutdownIndexWorkers(f.app); f.close();
}
