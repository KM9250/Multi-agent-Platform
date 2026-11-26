import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appFixture } from "./app-data-fixture.ts";
import { digest } from "../server/app-data/validation.ts";
import { GenerationCoordinator } from "../server/generation/coordinator.ts";
import { FakeProvider } from "../server/generation/provider.ts";
import { registerHandwrittenNote } from "../server/memory/importer.ts";
import { registerVault, setVaultPaused } from "../server/memory/vault.ts";
import { acquireActiveIndex, requestIndexUpdate, shutdownIndexWorkers } from "../server/search/index.ts";
import { buildDenseIndex } from "../server/search/dense.ts";
import { budgetStatus, configureSearchProfile, getSearchProfile, stopSearchProfile } from "../server/search/profile.ts";
import { spaceId } from "../server/search/embedding.ts";
import { runBudgetStatus } from "../server/generation/search-budget.ts";

async function fixture(t: any, options: { maxCalls?: number; historyWindow?: number; personas?: number } = {}) {
  const f = appFixture(), vault = mkdtempSync(join(tmpdir(), "map-context-budget-vault-"));
  const beforeFetch = globalThis.fetch, beforeKey = process.env.GEMINI_API_KEY;
  const requests: string[] = [], order: string[] = [];
  let afterContext = () => {};
  let afterResultCommit = () => {};
  let behavior: (text: string) => Promise<Response> = async () => Response.json({
    embedding: { values: Array.from({ length: 768 }, (_, i) => i === 0 ? 1 : 0) },
    usageMetadata: { promptTokenCount: 5 },
  });
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent");
    const text = JSON.parse(String(init?.body)).content.parts[0].text;
    requests.push(text); order.push("embedding"); return behavior(text);
  };
  process.env.GEMINI_API_KEY = "synthetic-intercepted-only";
  registerVault(f.app, vault, { trustNew: true }); setVaultPaused(f.app, false);
  f.policy.grant(f.actor.actorId, f.actor.workspaceId, "MANAGE_VAULT");
  for (const operation of ["READ_MEMORY", "REVIEW_MEMORY", "PUBLISH_MEMORY", "CHANGE_MEMORY_SCOPE"])
    f.policy.grant(f.actor.actorId, f.actor.workspaceId, operation, {
      roomId: f.room.id, personaId: f.persona.id, visibility: "room_shared",
    });
  const markdown = "---\nmap_id: context-budget-note\n---\n保存方式はSQLiteに決定しました。";
  writeFileSync(join(vault, "context-budget.md"), markdown);
  await registerHandwrittenNote(f.app, f.policy, f.actor, {
    roomId: f.room.id, personaId: f.persona.id, scope: "room_shared", noteId: "context-budget-note",
    relativePath: "context-budget.md", expectedDigest: digest(markdown), requestId: randomUUID(), trusted: true,
  });
  const personas = [f.persona];
  if (options.historyWindow !== undefined)
    f.repository.updatePersona(f.actor, f.room.id, f.persona.id, { expectedRevision: f.persona.revision, historyWindow: options.historyWindow });
  for (let i = 1; i < (options.personas ?? 1); i++)
    personas.push(f.repository.createPersona(f.actor, f.room.id, { name: `Consumer ${i}`, model: "synthetic" }));
  // Distinct synthetic timestamps make the server's created_at execution order deterministic.
  const firstCreatedAt = Number(f.app.db.prepare("SELECT created_at FROM personas WHERE persona_id=?").get(f.persona.id)!.created_at);
  personas.forEach((persona, index) => f.app.db.prepare("UPDATE personas SET created_at=? WHERE persona_id=?").run(firstCreatedAt + index, persona.id));
  configureSearchProfile(f.app, f.actor, f.room.id, {
    personaId: f.persona.id, scopes: ["room_shared"], purposes: ["DOCUMENT_EMBEDDING", "QUERY_EMBEDDING"],
    maxCalls: 100, maxTokens: 1_000_000, maxCostMicros: 1_000_000, priceMicrosPerThousandTokens: 100,
    aiContext: { queryEmbedding: true, consumerPersonaIds: personas.map(p => p.id), currency: "USD" },
  });
  await requestIndexUpdate(f.app, f.policy, f.actor, f.room.id);
  const active = acquireActiveIndex(f.app, f.policy, f.actor, f.room.id);
  assert.equal(active.state, "ACTIVE");
  const built = await buildDenseIndex(f.app, f.policy, f.actor, f.room.id, active.path!, undefined, {
    spaceId, async embed() { return { vector: Float32Array.from({ length: 768 }, (_, i) => i === 0 ? 1 : 0),
      usage: { completeness: "COMPLETE", unit: "input_token", quantity: 7 } }; },
  });
  assert.equal(built.state, "ready");
  const provider = new FakeProvider(request => { order.push(request.purpose); return {
    text: "SQLiteを選びました。[[MAP_SOURCE:S1]]", finish: "STOP",
    usage: { completeness: "COMPLETE", inputTokens: 9, outputTokens: 3, totalTokens: 12, semantics: "synthetic" },
  }; });
  const generation = new GenerationCoordinator(f.app, f.repository, f.policy, {
    provider, defaultModel: "synthetic", pricing: { version: "synthetic-usd", currency: "USD", inputMicrosPerMillion: 0, outputMicrosPerMillion: 0 }, ...(options.maxCalls ? { limits: { maxCalls: options.maxCalls } } : {}),
    hooks: { afterContext() { afterContext(); }, afterResultCommit() { afterResultCommit(); } },
  });
  t.after(async () => {
    await generation.shutdown(); await shutdownIndexWorkers(f.app); globalThis.fetch = beforeFetch;
    if (beforeKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = beforeKey;
    f.dispose(); rmSync(vault, { recursive: true, force: true });
  });
  const accept = () => generation.accept(f.actor, f.room.id, {
    requestId: randomUUID(), expectedRoomRevision: f.repository.getRoom(f.actor, f.room.id).revision,
    content: "保存方式は何に決めていましたか", recipient: { type: "all" }, context: { mode: "memory" },
  });
  return { ...f, generation, provider, personas, requests, order, accept, behavior(fn: typeof behavior) { behavior = fn; },
    afterContext(fn: () => void) { afterContext = fn; },
    afterResultCommit(fn: () => void) { afterResultCommit = fn; } };
}


test("PR41 audit: real Coordinator does not send a paid query after dispatch expiry", async t => {
  const originalNow = Date.now;
  let clock = originalNow();
  Date.now = () => clock;
  t.after(() => { Date.now = originalNow; });
  const f = await fixture(t);
  const run = f.accept();
  const row = f.app.db.prepare("SELECT dispatch_before,deadline_at FROM app_generation_runs WHERE run_id=?").get(run.runId)!;
  const originalTransaction = f.app.transaction.bind(f.app);
  let advanced = false;
  f.app.transaction = ((fn: any, boundary?: string) => {
    const value = originalTransaction(fn, boundary);
    if (boundary === "search-intent") {
      clock = Number(row.dispatch_before) + 1;
      advanced = true;
    }
    return value;
  }) as typeof f.app.transaction;
  await f.generation.execute(run.runId);
  const result = f.generation.get(f.actor, f.room.id, run.runId);
  const evidence = {
    case: "real-coordinator-dispatch-deadline",
    cutoff: Number(row.dispatch_before), deadline: Number(row.deadline_at),
    clockAfterIntent: clock, advanced,
    embeddingCalls: f.requests.length, answerCalls: f.provider.calls.length,
    order: f.order, status: result.status, errorCode: result.errorCode,
    searchUsage: result.searchUsage,
    explanation: "Date.now is advanced synchronously immediately after search-intent commits, before transport. The real Coordinator passes its AbortSignal; its timer cannot run in that synchronous interval.",
  };
  console.log(JSON.stringify(evidence));
  // Evidence goes outside the repository, alongside the root audit outputs.
  const { mkdirSync } = await import("node:fs");
  mkdirSync(`${process.env.PR41_AUDIT_EVIDENCE_DIR ?? "/tmp/pr41-audit-evidence"}`, { recursive: true });
  writeFileSync(`${process.env.PR41_AUDIT_EVIDENCE_DIR ?? "/tmp/pr41-audit-evidence"}/budget-deadline.json`, JSON.stringify(evidence, null, 2));
  assert.equal(f.requests.length, 0, "Expired Run must not start QueryEmbedding");
  assert.equal(f.provider.calls.length, 0);
  assert.equal(result.errorCode, "DISPATCH_EXPIRED");
  const operation = f.app.db.prepare("SELECT * FROM search_operations WHERE purpose='QUERY_EMBEDDING'").get()!;
  assert.equal(operation.state, "REJECTED"); assert.equal(operation.dispatched_at, null); assert.equal(operation.usage_json, null);
  assert.equal(runBudgetStatus(f.app, run.runId).calls, 0);
  assert.equal(f.app.db.prepare("SELECT count(*) n FROM app_context_answer_holds WHERE state='HELD'").get()!.n, 0);
});

test("F-04 dispatch gates cover pre-Intent expiry, deadline, cancellation and current SEND revocation", async t => {
  for (const action of ["before-intent", "deadline", "cancel", "revoke"] as const) await t.test(action, async t => {
    const originalNow = Date.now; let clock = originalNow(); Date.now = () => clock;
    t.after(() => { Date.now = originalNow; });
    const f = await fixture(t), run = f.accept();
    const row = f.app.db.prepare("SELECT * FROM app_generation_runs WHERE run_id=?").get(run.runId)!;
    const profile = getSearchProfile(f.app, f.actor, f.room.id)!;
    const prior = budgetStatus(f.app, f.actor, f.room.id, profile.version);
    const transaction = f.app.transaction.bind(f.app);
    f.app.transaction = ((fn: any, boundary?: string) => {
      const result = transaction(fn, boundary);
      if (boundary === (action === "before-intent" ? "search-reserve" : "search-intent")) {
        if (action === "before-intent") clock = Number(row.dispatch_before) + 1;
        if (action === "deadline") clock = Number(row.deadline_at) + 1;
        if (action === "cancel") f.generation.cancel(f.actor, f.room.id, run.runId);
        if (action === "revoke") f.policy.revoke(f.actor.actorId, f.actor.workspaceId, "SEND_TO_PROVIDER");
      }
      return result;
    }) as typeof f.app.transaction;
    await f.generation.execute(run.runId);
    assert.equal(f.requests.length, 0); assert.equal(f.provider.calls.length, 0);
    const operation = f.app.db.prepare("SELECT * FROM search_operations WHERE purpose='QUERY_EMBEDDING'").get()!;
    assert.equal(operation.state, "REJECTED"); assert.equal(operation.dispatched_at, null); assert.equal(operation.usage_json, null);
    assert.deepEqual(budgetStatus(f.app, f.actor, f.room.id, profile.version), prior);
    assert.equal(runBudgetStatus(f.app, run.runId).calls, 0);
    const result = f.generation.get(f.actor, f.room.id, run.runId);
    if (action === "before-intent") assert.equal(result.errorCode, "DISPATCH_EXPIRED");
    if (action === "deadline") assert.equal(result.errorCode, "DEADLINE_EXCEEDED");
  });
});

test("F-04 equality at dispatch/deadline permits one query and answer; late query receipt retains real Usage", async t => {
  for (const action of ["within", "dispatch-equal", "both-equal", "late-receipt"] as const) await t.test(action, async t => {
    const originalNow = Date.now; let clock = originalNow(); Date.now = () => clock;
    t.after(() => { Date.now = originalNow; });
    const f = await fixture(t), run = f.accept();
    const row = f.app.db.prepare("SELECT * FROM app_generation_runs WHERE run_id=?").get(run.runId)!;
    if (action === "both-equal") f.app.db.prepare("UPDATE app_generation_runs SET deadline_at=dispatch_before WHERE run_id=?").run(run.runId);
    const transaction = f.app.transaction.bind(f.app);
    f.app.transaction = ((fn: any, boundary?: string) => {
      const result = transaction(fn, boundary);
      if (boundary === "search-intent" && ["dispatch-equal", "both-equal"].includes(action)) clock = Number(row.dispatch_before);
      return result;
    }) as typeof f.app.transaction;
    if (action === "late-receipt") f.behavior(async () => {
      clock = Number(row.dispatch_before) + 1;
      assert.ok(clock < Number(row.deadline_at));
      return Response.json({ embedding: { values: Array.from({ length: 768 }, (_, i) => i === 0 ? 1 : 0) },
        usageMetadata: { promptTokenCount: 5 } });
    });
    await f.generation.execute(run.runId);
    assert.equal(f.requests.length, 1);
    assert.equal(f.provider.calls.length, action === "late-receipt" ? 0 : 1);
    const operation = f.app.db.prepare("SELECT * FROM search_operations WHERE purpose='QUERY_EMBEDDING'").get()!;
    assert.equal(operation.state, "SUCCEEDED"); assert.notEqual(operation.dispatched_at, null);
    assert.equal(JSON.parse(String(operation.usage_json)).quantity, 5);
    const result = f.generation.get(f.actor, f.room.id, run.runId);
    if (action === "late-receipt") {
      assert.equal(result.errorCode, "DISPATCH_EXPIRED");
      assert.equal(runBudgetStatus(f.app, run.runId).searchCalls, 1);
    } else assert.equal(result.status, "COMPLETED", result.errorCode);
    await f.generation.execute(run.runId); assert.equal(f.requests.length, 1);
  });
});
