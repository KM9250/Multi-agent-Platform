import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appFixture } from "./app-data-fixture.ts";
import { createAiSearchBinding } from "../server/search/ai-binding.ts";
import {
  budgetStatus, configureSearchProfile, dispatchEmbedding, getSearchProfile, recoverSearchDispatches,
} from "../server/search/profile.ts";
import { spaceId, type EmbeddingProvider, type SearchUsage } from "../server/search/embedding.ts";
import {
  consumeAnswerHold, getRunSearchUsage, releaseAnswerHolds, reserveAnswerHold, runBudgetStatus,
} from "../server/generation/search-budget.ts";

function fixture(t: any, limits: Record<string, number> = {}) {
  const f = appFixture();
  t.after(() => f.dispose());
  f.policy.grant(f.actor.actorId, f.actor.workspaceId, "READ_MEMORY", {
    roomId: f.room.id, personaId: f.persona.id, visibility: "room_shared",
  });
  const run = f.generation.accept(f.actor, f.room.id, {
    requestId: randomUUID(), expectedRoomRevision: f.room.revision,
    content: "保存方式を確認", recipient: { type: "all" },
  });
  const saved = f.app.db.prepare("SELECT limits_json FROM app_generation_runs WHERE run_id=?").get(run.runId)!;
  f.app.db.prepare("UPDATE app_generation_runs SET state='RUNNING',owner_id='fixture',limits_json=? WHERE run_id=?")
    .run(JSON.stringify({ ...JSON.parse(String(saved.limits_json)), ...limits }), run.runId);
  const binding = (planId = randomUUID()) => createAiSearchBinding(f.app, f.policy, f.actor, {
    runId: run.runId, planId, consumerPersonaId: f.persona.id, provider: "synthetic", model: "synthetic",
  });
  const config = {
    personaId: f.persona.id, scopes: ["room_shared"], purposes: ["QUERY_EMBEDDING"],
    maxCalls: 100, maxTokens: 1_000_000, maxCostMicros: 1_000_000, priceMicrosPerThousandTokens: 100,
  };
  const configure = (ai = true, changes = {}) => configureSearchProfile(f.app, f.actor, f.room.id, {
    ...config, ...(ai ? { aiContext: { queryEmbedding: true, consumerPersonaIds: [f.persona.id], currency: "USD" } } : {}), ...changes,
  });
  const hold = (b = binding()) => {
    reserveAnswerHold(f.app, f.actor, { binding: b, reservedInputTokens: 100, reservedOutputTokens: 100,
      reservedCostMicros: 10, pricingVersion: "host-test", currency: "USD" });
    return b;
  };
  let calls = 0;
  const provider = (usage: SearchUsage = { completeness: "COMPLETE", unit: "input_token", quantity: 4 }, fn?: () => void): EmbeddingProvider => ({
    spaceId, async embed() { calls++; fn?.(); return { vector: Float32Array.from({ length: 768 }, (_, i) => i === 0 ? 1 : 0), usage }; },
  });
  const dispatch = (b: ReturnType<typeof binding>, p = provider(), extra = {}) => dispatchEmbedding(f.app, f.policy, p, {
    actor: f.actor, roomId: f.room.id, profile: getSearchProfile(f.app, f.actor, f.room.id)!,
    scopes: ["room_shared"], purpose: "QUERY_EMBEDDING", operationKey: b.planId,
    signal: new AbortController().signal, readText: () => "保存方式を確認", aiBinding: b, ...extra,
  });
  return { ...f, run, binding, configure, hold, provider, dispatch, calls: () => calls };
}

test("MEM-3A a human query profile preserves its immutable JSON and grants zero AI calls", async t => {
  const f = fixture(t); f.configure(false);
  const before = f.app.db.prepare("SELECT config_json,config_digest FROM search_profiles").get();
  assert.equal(getSearchProfile(f.app, f.actor, f.room.id)?.aiContext, undefined);
  await assert.rejects(f.dispatch(f.hold()), /ai_query_disabled/);
  assert.equal(f.calls(), 0);
  assert.equal(f.app.db.prepare("SELECT count(*) n FROM search_operations").get()!.n, 0);
  assert.deepEqual(f.app.db.prepare("SELECT config_json,config_digest FROM search_profiles").get(), before);
  assert.throws(() => f.configure(true, { aiContext: { queryEmbedding: true, consumerPersonaIds: ["*"] } }), /invalid_profile/);
});

test("MEM-3A search reservation and binding are atomic, unique, and counted once", async t => {
  const f = fixture(t); const profile = f.configure(); const b = f.hold();
  const result = await f.dispatch(b);
  assert.equal(f.calls(), 1);
  assert.deepEqual(runBudgetStatus(f.app, f.run.runId), {
    calls: 2, providerCalls: 0, searchCalls: 1, answerHolds: 1, tokens: 204, costMicros: 11,
  });
  assert.equal(budgetStatus(f.app, f.actor, f.room.id, profile.version).tokens, 4);
  const rows = getRunSearchUsage(f.app, f.actor, f.run.runId);
  assert.equal(rows.length, 1); assert.equal(rows[0].operationId, result.operationId);
  assert.equal(rows[0].consumerPersonaId, f.persona.id);
  assert.ok(!JSON.stringify(rows).includes("保存方式"));
  await assert.rejects(f.dispatch(b), /operation_already_recorded/);
  await assert.rejects(f.dispatch(b, f.provider(), { operationKey: randomUUID() }), /UNIQUE constraint/);
  assert.equal(f.calls(), 1);
  assert.equal(f.app.db.prepare("SELECT count(*) n FROM search_operations").get()!.n, 1);
});

test("MEM-3A missing answer space prevents embedding before transport", async t => {
  const f = fixture(t, { maxCalls: 1 }); f.configure();
  await assert.rejects(f.dispatch(f.hold()), /run_budget_exhausted/);
  assert.equal(f.calls(), 0);
  assert.equal(f.app.db.prepare("SELECT count(*) n FROM search_operations").get()!.n, 0);
  const unheld = f.binding();
  await assert.rejects(f.dispatch(unheld), /run_answer_unreserved/);
  assert.equal(f.calls(), 0);
});

test("MEM-3A absent or different currencies never combine amounts or dispatch a query", async t => {
  for (const currency of [undefined, "JPY"]) {
    const f = fixture(t);
    f.configure(true, { aiContext: { queryEmbedding: true, consumerPersonaIds: [f.persona.id],
      ...(currency ? { currency } : {}) } });
    await assert.rejects(f.dispatch(f.hold()), /currency_unconfigured_or_mismatched/);
    assert.equal(f.calls(), 0);
    assert.equal(f.app.db.prepare("SELECT count(*) n FROM search_operations").get()!.n, 0);
  }
  const legacy = fixture(t); legacy.configure();
  const b = legacy.binding();
  reserveAnswerHold(legacy.app, legacy.actor, { binding: b, reservedInputTokens: 100, reservedOutputTokens: 100,
    reservedCostMicros: 10, pricingVersion: "legacy-without-currency" });
  await assert.rejects(legacy.dispatch(b), /currency_unconfigured_or_mismatched/);
  assert.throws(() => legacy.hold(), /CURRENCY_MISMATCH/);
  assert.equal(legacy.calls(), 0);
  assert.equal(legacy.app.db.prepare("SELECT count(*) n FROM search_operations").get()!.n, 0);
});

test("MEM-3A a new profile version cannot expand a frozen Run's query budget", async t => {
  const f = fixture(t); const profile = f.configure(); const b = f.hold();
  f.configure(true, { maxCalls: 101 });
  await assert.rejects(f.dispatch(b), /search_profile_changed/);
  assert.equal(f.calls(), 0);
  assert.equal(f.app.db.prepare("SELECT count(*) n FROM search_operations").get()!.n, 0);
  const hold = f.app.db.prepare("SELECT search_profile_version FROM app_context_answer_holds WHERE plan_id=?").get(b.planId)!;
  assert.equal(hold.search_profile_version, profile.version);
  assert.throws(() => f.hold(), /SEARCH_PROFILE_CHANGED/);
  assert.throws(() => f.app.db.prepare("UPDATE app_context_answer_holds SET search_profile_version=? WHERE plan_id=?").run(profile.version + 1, b.planId), /CONTEXT_HOLD_IMMUTABLE/);
});

test("MEM-3A parallel prepares cannot spend another Persona's answer reservation", async t => {
  const f = fixture(t, { maxCalls: 3 }); f.configure();
  const a = f.hold(), b = f.hold();
  const results = await Promise.allSettled([f.dispatch(a), f.dispatch(b)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(results.filter(r => r.status === "rejected").length, 1);
  assert.equal(f.calls(), 1);
  assert.equal(runBudgetStatus(f.app, f.run.runId).calls, 3);
});

test("MEM-3A unknown usage keeps reservations without mislabeling a received vector as unknown outcome", async t => {
  const f = fixture(t); f.configure(); const b = f.hold();
  await f.dispatch(b, f.provider({ completeness: "UNKNOWN", unit: "input_token" }));
  assert.equal(f.app.db.prepare("SELECT state FROM app_generation_runs WHERE run_id=?").get(f.run.runId)!.state, "RUNNING");
  const budget = runBudgetStatus(f.app, f.run.runId);
  assert.equal(budget.tokens, 8192 + 200); assert.equal(budget.costMicros, 820 + 10);
  assert.equal(getRunSearchUsage(f.app, f.actor, f.run.runId)[0].usage.completeness, "UNKNOWN");
});

test("MEM-3A unknown transport suspends its parent Run and startup never replays it", async t => {
  const f = fixture(t); f.configure(); const a = f.hold(), b = f.hold();
  let attempts = 0;
  const broken: EmbeddingProvider = { spaceId, async embed() { attempts++; throw Error("connection lost"); } };
  await assert.rejects(f.dispatch(a, broken), /connection lost/);
  const run = f.app.db.prepare("SELECT state,error_code FROM app_generation_runs WHERE run_id=?").get(f.run.runId)!;
  assert.equal(run.state, "NEEDS_REVIEW"); assert.equal(run.error_code, "SEARCH_OUTCOME_UNKNOWN");
  await assert.rejects(f.dispatch(b, broken), /RUN_NOT_ACTIVE/);
  recoverSearchDispatches(f.app);
  assert.equal(runBudgetStatus(f.app, f.run.runId).answerHolds, 0);
  assert.equal(runBudgetStatus(f.app, f.run.runId).searchCalls, 1);
  await assert.rejects(f.dispatch(a, broken), /RUN_NOT_ACTIVE/);
  assert.equal(attempts, 1);
});

test("MEM-3A cancellation discards adoption but preserves a late successful usage receipt", async t => {
  const f = fixture(t); f.configure(); const b = f.hold(); const abort = new AbortController();
  await assert.rejects(f.dispatch(b, f.provider(undefined, () => {
    f.app.db.prepare("UPDATE app_generation_runs SET state='CANCELLED',cancelled_at=? WHERE run_id=?").run(Date.now(), f.run.runId);
    abort.abort();
  }), { signal: abort.signal }), /abort/i);
  const row = getRunSearchUsage(f.app, f.actor, f.run.runId)[0];
  assert.equal(row.state, "SUCCEEDED"); assert.equal(row.usage.quantity, 4);
  releaseAnswerHolds(f.app, f.run.runId);
  assert.equal(runBudgetStatus(f.app, f.run.runId).tokens, 4);
  assert.equal(f.calls(), 1);
});

test("MEM-3A transferring a held answer to its provider call does not double count or reuse its ordinal", async t => {
  const f = fixture(t); f.configure(); const b = f.hold(); await f.dispatch(b);
  const call = randomUUID();
  const used = runBudgetStatus(f.app, f.run.runId, { excludePlanId: b.planId });
  assert.equal(used.calls, 1); assert.equal(used.providerCalls, 0);
  f.app.transaction(() => {
    f.app.db.prepare(`INSERT INTO app_provider_calls(workspace_id,room_id,run_id,call_id,ordinal,persona_id,purpose,
      provider,model,state,owner_id,manifest_json,manifest_digest,reserved_input_tokens,reserved_output_tokens,
      reserved_cost_micros,pricing_version,usage_state,reserved_at)
      VALUES(?,?,?,?,?,?,'answer','synthetic','synthetic','RESERVED','fixture','{}','digest',100,100,10,'host-test','UNKNOWN',?)`)
      .run(f.actor.workspaceId, f.room.id, f.run.runId, call, used.providerCalls + 1, f.persona.id, Date.now());
    assert.equal(consumeAnswerHold(f.app, b.planId, call), true);
  });
  const after = runBudgetStatus(f.app, f.run.runId);
  assert.equal(after.calls, 2); assert.equal(after.tokens, 204); assert.equal(after.answerHolds, 0);
  assert.equal(consumeAnswerHold(f.app, b.planId, call), false);
  assert.throws(() => f.app.db.prepare("UPDATE app_context_answer_holds SET state='HELD',call_id=NULL WHERE plan_id=?").run(b.planId), /CONTEXT_HOLD_IMMUTABLE/);
});
