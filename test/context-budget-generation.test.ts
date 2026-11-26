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
import { configureSearchProfile, getSearchProfile, stopSearchProfile } from "../server/search/profile.ts";
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

test("MEM-3A real Coordinator prepares paid retrieval once and transfers the answer reservation", async t => {
  const f = await fixture(t); const run = f.accept();
  await f.generation.execute(run.runId);
  const receipt = f.generation.get(f.actor, f.room.id, run.runId);
  assert.equal(receipt.status, "COMPLETED", JSON.stringify(receipt));
  assert.deepEqual(f.order, ["embedding", "answer"]); assert.equal(f.requests.length, 1);
  assert.equal(f.provider.calls.length, 1);
  const calls = f.app.db.prepare("SELECT ordinal,manifest_json FROM app_provider_calls WHERE run_id=?").all(run.runId);
  assert.deepEqual(calls.map(c => c.ordinal), [1]);
  const manifest = JSON.parse(String(calls[0].manifest_json));
  assert.equal(manifest.retrieval.searches[0].searchOperationIds.length, 1);
  const budget = runBudgetStatus(f.app, run.runId);
  assert.equal(budget.providerCalls, 1); assert.equal(budget.searchCalls, 1); assert.equal(budget.answerHolds, 0);
  assert.equal(budget.tokens, 17); // Current query 5 + answer 12; historical document 7 is excluded.
  await f.generation.execute(run.runId); assert.equal(f.requests.length, 1); assert.equal(f.provider.calls.length, 1);
});

test("MEM-3A all responders retain answer capacity when only one optional query fits", async t => {
  const f = await fixture(t, { maxCalls: 3, personas: 2 }); const run = f.accept();
  await f.generation.execute(run.runId);
  const receipt = f.generation.get(f.actor, f.room.id, run.runId);
  assert.equal(receipt.status, "COMPLETED", JSON.stringify(receipt));
  assert.equal(f.requests.length, 1); assert.equal(f.provider.calls.length, 2);
  assert.deepEqual(f.app.db.prepare("SELECT ordinal FROM app_provider_calls WHERE run_id=? ORDER BY ordinal").all(run.runId)
    .map(c => c.ordinal), [1, 2]);
  assert.equal(runBudgetStatus(f.app, run.runId).calls, 3);
});

test("MEM-3A an early optional query cannot consume a later Persona's mandatory worker call", async t => {
  const f = await fixture(t, { maxCalls: 3, personas: 2 });
  const later = f.personas[1];
  f.repository.updatePersona(f.actor, f.room.id, later.id, {
    expectedRevision: later.revision,
    subAgentPolicy: { mode: "fixed_serial" },
    subAgents: [{ id: "required-worker", name: "Required worker", provider: "synthetic",
      model: "synthetic", systemInstruction: "Summarize the accepted task privately.", isEnabled: true }],
  });
  const { version, spaceId: ignoredSpace, configDigest, ...profile } = getSearchProfile(f.app, f.actor, f.room.id)!;
  configureSearchProfile(f.app, f.actor, f.room.id, {
    ...profile, aiContext: { ...profile.aiContext, consumerPersonaIds: [f.persona.id] },
  });
  const run = f.accept(); await f.generation.execute(run.runId);
  const receipt = f.generation.get(f.actor, f.room.id, run.runId);
  assert.equal(receipt.status, "COMPLETED", JSON.stringify(receipt));
  assert.deepEqual(f.order, ["answer", "subagent", "answer"]);
  assert.equal(f.requests.length, 0);
  const calls = f.app.db.prepare("SELECT ordinal,purpose FROM app_provider_calls WHERE run_id=? ORDER BY ordinal").all(run.runId);
  assert.deepEqual(calls.map(row => [row.ordinal, row.purpose]), [[1, "answer"], [2, "subagent"], [3, "answer"]]);
  const budget = runBudgetStatus(f.app, run.runId);
  assert.equal(budget.calls, 3); assert.equal(budget.searchCalls, 0); assert.equal(budget.answerHolds, 0);
});

test("MEM-3A a profile expansion between answers cannot spend a later mandatory worker's reservation", async t => {
  const f = await fixture(t, { maxCalls: 5, personas: 3 });
  const last = f.personas[2];
  f.repository.updatePersona(f.actor, f.room.id, last.id, {
    expectedRevision: last.revision, subAgentPolicy: { mode: "fixed_serial" },
    subAgents: [{ id: "later-worker", name: "Later required worker", provider: "synthetic",
      model: "synthetic", systemInstruction: "Summarize the accepted task privately.", isEnabled: true }],
  });
  const { version, spaceId: ignoredSpace, configDigest, ...profile } = getSearchProfile(f.app, f.actor, f.room.id)!;
  const frozen = configureSearchProfile(f.app, f.actor, f.room.id, {
    ...profile, aiContext: { ...profile.aiContext, consumerPersonaIds: [f.personas[0].id] },
  });
  let changed = false;
  f.afterResultCommit(() => {
    if (changed) return;
    changed = true;
    configureSearchProfile(f.app, f.actor, f.room.id, {
      ...profile, aiContext: { ...profile.aiContext, consumerPersonaIds: [f.personas[0].id, f.personas[1].id] },
    });
  });
  const run = f.accept(); await f.generation.execute(run.runId);
  const receipt = f.generation.get(f.actor, f.room.id, run.runId);
  assert.equal(receipt.status, "COMPLETED", JSON.stringify(receipt));
  assert.deepEqual(f.order, ["embedding", "answer", "answer", "subagent", "answer"]);
  assert.equal(f.requests.length, 1);
  assert.equal(runBudgetStatus(f.app, run.runId).calls, 5);
  const holds = f.app.db.prepare("SELECT search_profile_version,state FROM app_context_answer_holds WHERE run_id=?").all(run.runId);
  assert.equal(holds.length, 3); assert.ok(holds.every(row => row.search_profile_version === frozen.version && row.state === "CONSUMED"));
  const middle = f.app.db.prepare("SELECT manifest_json FROM app_provider_calls WHERE run_id=? AND persona_id=? AND purpose='answer'").get(run.runId, f.personas[1].id)!;
  const search = JSON.parse(String(middle.manifest_json)).retrieval.searches[0];
  assert.deepEqual(search.methods, ["lexical"]); assert.ok(search.reasons.includes("search_profile_changed"));
});

test("MEM-3A answer-only call budget degrades paid search before dispatch", async t => {
  const f = await fixture(t, { maxCalls: 1 }); const run = f.accept();
  await f.generation.execute(run.runId);
  assert.equal(f.generation.get(f.actor, f.room.id, run.runId).status, "COMPLETED");
  assert.equal(f.requests.length, 0); assert.equal(f.provider.calls.length, 1);
  assert.equal(runBudgetStatus(f.app, run.runId).searchCalls, 0);
});

test("MEM-3A failed transport cannot resume a parent answer after OUTCOME_UNKNOWN", async t => {
  const f = await fixture(t); f.behavior(async () => { throw Error("synthetic connection loss"); });
  const run = f.accept(); await f.generation.execute(run.runId);
  const receipt = f.generation.get(f.actor, f.room.id, run.runId);
  assert.equal(receipt.status, "NEEDS_REVIEW", JSON.stringify(receipt));
  assert.equal(f.requests.length, 1); assert.equal(f.provider.calls.length, 0);
  f.generation.recoverInterrupted(); await f.generation.execute(run.runId);
  assert.equal(f.requests.length, 1); assert.equal(f.provider.calls.length, 0);
  assert.equal(runBudgetStatus(f.app, run.runId).tokens, 8192);
});

test("MEM-3A mandatory pin conflict is found before a paid query", async t => {
  const f = await fixture(t, { historyWindow: 1 });
  f.repository.appendMessage(f.actor, f.room.id, { role: "user", content: "First pinned message" });
  const run = f.accept(); await f.generation.execute(run.runId);
  const receipt = f.generation.get(f.actor, f.room.id, run.runId);
  assert.equal(receipt.status, "FAILED"); assert.equal(receipt.errorCode, "HISTORY_WINDOW_PIN_CONFLICT");
  assert.equal(f.requests.length, 0); assert.equal(f.provider.calls.length, 0);
});

test("MEM-3A stopping a profile after freeze prevents the answer and preserves collected query usage", async t => {
  const f = await fixture(t);
  f.afterContext(() => stopSearchProfile(f.app, f.actor, f.room.id));
  const run = f.accept(); await f.generation.execute(run.runId);
  const receipt = f.generation.get(f.actor, f.room.id, run.runId);
  assert.equal(receipt.status, "FAILED", JSON.stringify(receipt));
  assert.equal(f.requests.length, 1); assert.equal(f.provider.calls.length, 0);
  const operation = f.app.db.prepare(`SELECT o.state,o.usage_json FROM search_operations o
    JOIN search_operation_bindings b USING(operation_id) JOIN app_context_answer_holds h USING(plan_id)
    WHERE h.run_id=?`).get(run.runId)!;
  assert.equal(operation.state, "SUCCEEDED"); assert.equal(JSON.parse(String(operation.usage_json)).quantity, 5);
});

test("MEM-3A query-only vectors survive AI capability and budget changes without document resends", async t => {
  const f = await fixture(t);
  const count = () => Number(f.app.db.prepare("SELECT COUNT(*) n FROM search_operations WHERE purpose='DOCUMENT_EMBEDDING'").get()!.n);
  const documents = count(); assert.equal(documents, 1);
  const { version, spaceId: ignoredSpace, configDigest, ...config } = getSearchProfile(f.app, f.actor, f.room.id)!;
  for (const enabled of [false, true]) {
    configureSearchProfile(f.app, f.actor, f.room.id, {
      ...config, purposes: ["QUERY_EMBEDDING"], maxCalls: enabled ? 2 : 1,
      aiContext: { ...config.aiContext, queryEmbedding: enabled },
    });
    await requestIndexUpdate(f.app, f.policy, f.actor, f.room.id);
    assert.equal(count(), documents); assert.equal(f.requests.length, 0);
  }
  const run = f.accept(); await f.generation.execute(run.runId);
  const receipt = f.generation.get(f.actor, f.room.id, run.runId);
  assert.equal(receipt.status, "COMPLETED", JSON.stringify(receipt));
  assert.equal(f.requests.length, 1); assert.equal(count(), documents);
  const call = f.app.db.prepare("SELECT manifest_json FROM app_provider_calls WHERE run_id=?").get(run.runId)!;
  assert.ok(JSON.parse(String(call.manifest_json)).retrieval.searches[0].methods.includes("dense"));
});
