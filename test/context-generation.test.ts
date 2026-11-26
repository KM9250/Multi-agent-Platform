import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appFixture } from "./app-data-fixture.ts";
import { GenerationCoordinator } from "../server/generation/coordinator.ts";
import { FakeProvider } from "../server/generation/provider.ts";
import {
  requestIndexUpdate,
  shutdownIndexWorkers,
} from "../server/search/index.ts";

function setup(t: any, options: any = {}) {
  const f = appFixture();
  f.repository.updatePersona(f.actor, f.room.id, f.persona.id, {
    expectedRevision: 1,
    historyWindow: 1,
    pinFirstMessage: false,
  });
  const provider =
    options.provider ??
    new FakeProvider(() => ({
      text: "Archive answer [[MAP_SOURCE:S1]]",
      finish: "STOP",
      usage: {
        inputTokens: 3,
        outputTokens: 2,
        totalTokens: 5,
        completeness: "COMPLETE",
        semantics: "synthetic",
      },
    }));
  const generation = new GenerationCoordinator(f.app, f.repository, f.policy, {
    provider,
    defaultModel: "synthetic",
    ...options,
  });
  t.after(async () => {
    await generation.shutdown();
    await shutdownIndexWorkers(f.app);
    f.dispose();
  });
  const accept = (content: string, extra: any = {}) =>
    generation.accept(f.actor, f.room.id, {
      requestId: randomUUID(),
      expectedRoomRevision: f.room.revision,
      content,
      recipient: { type: "all" },
      ...extra,
    });
  const manifest = (runId: string) =>
    JSON.parse(
      String(
        f.app.db
          .prepare(
            "SELECT manifest_json FROM app_provider_calls WHERE run_id=? AND purpose='answer'",
          )
          .get(runId)?.manifest_json,
      ),
    );
  return { ...f, provider, generation, accept, manifest };
}

test("MEM-3A context idempotency keeps accepted date snapshot and rejects changed modes/dates", async (t) => {
  let now = Date.now();
  const f = setup(t, { now: () => now });
  const requestId = randomUUID();
  const context = { mode: "archive", timeZone: "Asia/Tokyo" };
  const first = f.accept("昨日に話した cedar", { requestId, context });
  const snapshot = String(
    f.app.db
      .prepare("SELECT request_json FROM app_generation_runs WHERE run_id=?")
      .get(first.runId)!.request_json,
  );
  assert.equal(
    JSON.parse(snapshot).contextDateInterpretation.source,
    "relative_text",
  );
  now += 86400000;
  assert.equal(
    f.accept("昨日に話した cedar", { requestId, context }).runId,
    first.runId,
  );
  assert.equal(
    f.app.db
      .prepare("SELECT request_json FROM app_generation_runs WHERE run_id=?")
      .get(first.runId)!.request_json,
    snapshot,
  );
  assert.throws(
    () =>
      f.accept("昨日に話した cedar", { requestId, context: { mode: "none" } }),
    /REQUEST_CONFLICT/,
  );
  assert.throws(
    () =>
      f.accept("昨日に話した cedar", {
        requestId,
        context: {
          ...context,
          date: { mode: "strict", anchorDate: "2026-11-11" },
        },
      }),
    /REQUEST_CONFLICT/,
  );
  assert.throws(
    () =>
      f.accept("cedar", {
        context: {
          mode: "memory",
          date: { mode: "strict", anchorDate: "2026-11-11" },
        },
      }),
    /INVALID_CONTEXT_DATE_MODE/,
  );
  assert.throws(
    () =>
      f.accept("cedar", {
        context: { mode: "archive", consumerPersonaId: f.persona.id },
      }),
    /INVALID_INPUT|UNKNOWN_FIELD/,
  );
  assert.equal(f.provider.calls.length, 0);
});

test("MEM-3A archive prepare freezes old public sources, cutoff, and regenerated current input", async (t) => {
  const f = setup(t);
  const old = f.repository.appendMessage(f.actor, f.room.id, {
    role: "user",
    content: "cedar original decision",
  });
  const run = f.accept("cedar", { context: { mode: "archive" } });
  const future = f.repository.appendMessage(f.actor, f.room.id, {
    role: "user",
    content: "cedar FUTURE_CANARY",
  });
  await requestIndexUpdate(f.app, f.policy, f.actor, f.room.id, {
    force: true,
  });
  await f.generation.execute(run.runId);
  const receipt = f.generation.get(f.actor, f.room.id, run.runId);
  assert.equal(receipt.status, "COMPLETED", receipt.errorCode);
  const plan = f.manifest(run.runId).retrieval;
  assert.equal(plan.searches.length, 1);
  assert.equal(plan.route.mode, "archive");
  assert(plan.sources.some((s: any) => s.citation.messageId === old.id));
  assert(!plan.sources.some((s: any) => s.citation.messageId === future.id));
  assert(!JSON.stringify(f.provider.calls).includes("FUTURE_CANARY"));
  const before = f.provider.calls.length;
  await f.generation.execute(run.runId);
  assert.equal(f.provider.calls.length, before);
  const answer = receipt.results[0];
  f.repository.correctMessage(f.actor, f.room.id, run.inputMessageId, {
    expectedRevision: 1,
    content: "cedar corrected input",
  });
  const regen = f.generation.regenerate(f.actor, f.room.id, answer.id, {
    requestId: randomUUID(),
    expectedRevision: 1,
  });
  await requestIndexUpdate(f.app, f.policy, f.actor, f.room.id, {
    force: true,
  });
  await f.generation.execute(regen.runId);
  const regenerated = f.generation.get(f.actor, f.room.id, regen.runId);
  assert.equal(regenerated.status, "COMPLETED", regenerated.errorCode);
  const newPlan = f.manifest(regen.runId).retrieval;
  assert.notEqual(newPlan.id, plan.id);
  assert.equal(newPlan.inputBinding.revision, 2);
  assert.equal(newPlan.inputBinding.messageId, run.inputMessageId);
  assert.equal(newPlan.inputBinding.excludeMessageId, answer.id);
  assert.equal(newPlan.route.query.text, "cedar corrected input");
  assert(
    !newPlan.sources.some((s: any) =>
      [answer.id, future.id].includes(s.citation.messageId),
    ),
  );
});

for (const boundary of [
  "afterContext",
  "beforeIntentCommit",
  "afterIntentCommit",
  "afterProviderResponse",
  "beforeResultCommit",
] as const) {
  test(`MEM-3A frozen archive change at ${boundary} discards output without replacement or new search`, async (t) => {
    let change = () => {};
    const f = setup(t, { hooks: { [boundary]: () => change() } });
    const old = f.repository.appendMessage(f.actor, f.room.id, {
      role: "user",
      content: "cedar source before change",
    });
    const run = f.accept("cedar", { context: { mode: "archive" } });
    await requestIndexUpdate(f.app, f.policy, f.actor, f.room.id, {
      force: true,
    });
    change = () => {
      change = () => {};
      f.repository.correctMessage(f.actor, f.room.id, old.id, {
        expectedRevision: 1,
        content: "replaced source",
      });
    };
    await f.generation.execute(run.runId);
    const receipt = f.generation.get(f.actor, f.room.id, run.runId);
    assert.notEqual(receipt.status, "COMPLETED");
    assert.equal(receipt.results.length, 0);
    const sent = ["afterProviderResponse", "beforeResultCommit"].includes(
      boundary,
    );
    assert.equal(f.provider.calls.length, sent ? 1 : 0);
    if (sent) assert.equal(receipt.usage[0].completeness, "COMPLETE");
    assert.equal(f.manifest(run.runId).retrieval.searches.length, 1);
    await f.generation.execute(run.runId);
    assert.equal(f.provider.calls.length, sent ? 1 : 0);
  });
}

test("MEM-3A none retains current input and normal history without search operations", async (t) => {
  const f = setup(t);
  const run = f.accept("CURRENT_CANARY", { context: { mode: "none" } });
  await f.generation.execute(run.runId);
  const receipt = f.generation.get(f.actor, f.room.id, run.runId);
  assert.equal(receipt.status, "COMPLETED", receipt.errorCode);
  assert(JSON.stringify(f.provider.calls).includes("CURRENT_CANARY"));
  assert.equal(f.manifest(run.runId).retrieval.searches.length, 0);
  assert.equal(
    f.app.db.prepare("SELECT COUNT(*) n FROM search_operations").get()!.n,
    0,
  );
});

test("MEM-3A optional answer hold cannot crowd out mandatory fixed workers when no paid search is requested", async (t) => {
  const f = setup(t, { limits: { maxTotalTokens: 19000 } });
  f.repository.updatePersona(f.actor, f.room.id, f.persona.id, {
    expectedRevision: 2,
    subAgentPolicy: { mode: "fixed_serial" },
    subAgents: [
      {
        id: "worker",
        name: "worker",
        provider: "google",
        model: "synthetic",
        systemInstruction: "check",
        isEnabled: true,
      },
    ],
  });
  const run = f.accept("hello", { context: { mode: "none" } });
  await f.generation.execute(run.runId);
  const receipt = f.generation.get(f.actor, f.room.id, run.runId);
  assert.equal(receipt.status, "COMPLETED", receipt.errorCode);
  assert.deepEqual(
    f.provider.calls.map((call: any) => call.purpose),
    ["subagent", "answer"],
  );
  assert.equal(
    f.app.db.prepare("SELECT COUNT(*) n FROM app_context_answer_holds").get()!
      .n,
    0,
  );
});
