import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AppDatabase } from "../server/app-data/db";
import { ConversationRepository } from "../server/app-data/repository";
import {
  AuthorizationPolicy,
  PUBLIC_USER_OPERATIONS,
} from "../server/auth/authorization";
import { GenerationCoordinator } from "../server/generation/coordinator";
import {
  FakeProvider,
  GeminiProvider,
  type ProviderResult,
} from "../server/generation/provider";
import type { CoordinatorOptions } from "../server/generation/types";
const good = (text = "Synthetic result"): ProviderResult => ({
  text,
  finish: "STOP",
  usage: {
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    completeness: "COMPLETE",
    semantics: "test-v1",
  },
});
function fixture(options: Partial<CoordinatorOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), "map-generation-"));
  const app = new AppDatabase({ root });
  const actor = { actorId: "actor", workspaceId: "workspace" };
  app.db.prepare("INSERT INTO workspaces VALUES(?,1)").run(actor.workspaceId);
  app.db
    .prepare(
      "INSERT INTO principals(actor_id,workspace_id,active) VALUES(?,?,1)",
    )
    .run(actor.actorId, actor.workspaceId);
  const policy = new AuthorizationPolicy(app);
  for (const operation of PUBLIC_USER_OPERATIONS)
    policy.grant(actor.actorId, actor.workspaceId, operation);
  const repository = new ConversationRepository(app, policy);
  const room = repository.createRoom(actor, { title: "Test" });
  const persona = repository.createPersona(actor, room.id, {
    name: "Alice",
    model: "synthetic",
  });
  const provider = options.provider ?? new FakeProvider();
  const coordinator = new GenerationCoordinator(app, repository, policy, {
    provider,
    defaultModel: "synthetic",
    ...options,
  });
  const accept = (content = "hello", extra: any = {}) =>
    coordinator.accept(actor, room.id, {
      requestId: randomUUID(),
      expectedRoomRevision: room.revision,
      content,
      recipient: { type: "all" },
      ...extra,
    });
  return {
    root,
    app,
    actor,
    policy,
    repository,
    room,
    persona,
    provider,
    coordinator,
    accept,
    close() {
      app.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
test("DATA-1 accept idempotency, input binding and repeated readers never resend", async () => {
  const f = fixture();
  try {
    const requestId = randomUUID();
    const first = f.accept("hello", { requestId });
    const repeat = f.accept("hello", { requestId });
    assert.equal(first.runId, repeat.runId);
    assert.equal(repeat.newlyAccepted, false);
    assert.throws(() => f.accept("changed", { requestId }), /REQUEST_CONFLICT/);
    await Promise.all([
      f.coordinator.execute(first.runId),
      f.coordinator.execute(first.runId),
    ]);
    const receipt = f.coordinator.get(f.actor, f.room.id, first.runId);
    assert.equal(receipt.status, "COMPLETED");
    assert.equal(receipt.results.length, 1);
    assert.equal((f.provider as FakeProvider).calls.length, 1);
    assert.equal(
      f.app.db.prepare("SELECT count(*) n FROM messages").get()?.n,
      2,
    );
    await f.coordinator.execute(first.runId);
    assert.equal((f.provider as FakeProvider).calls.length, 1);
  } finally {
    f.close();
  }
});
test("DATA-1 intent before COMMIT rollback and lost ACK produce zero sends", async () => {
  for (const point of ["beforeIntentCommit", "afterIntentCommit"] as const) {
    const f = fixture({
      hooks: {
        [point]: () => {
          throw new Error("synthetic loss");
        },
      },
    });
    try {
      const run = f.accept();
      await f.coordinator.execute(run.runId);
      assert.equal((f.provider as FakeProvider).calls.length, 0);
      const row = f.app.db
        .prepare("SELECT state FROM app_provider_calls")
        .get();
      assert.equal(
        row?.state,
        point === "beforeIntentCommit" ? "RESERVED" : "OUTCOME_UNKNOWN",
      );
      f.coordinator.recoverInterrupted();
      await f.coordinator.execute(run.runId);
      assert.equal((f.provider as FakeProvider).calls.length, 0);
    } finally {
      f.close();
    }
  }
});
test("DATA-1 transport failure is unknown, reservation retained, no automatic retry", async () => {
  const provider = new FakeProvider(() => {
    throw new Error("body may have been sent");
  });
  const f = fixture({ provider });
  try {
    const run = f.accept();
    await f.coordinator.execute(run.runId);
    assert.equal(provider.calls.length, 1);
    const receipt = f.coordinator.get(f.actor, f.room.id, run.runId);
    assert.equal(receipt.status, "NEEDS_REVIEW");
    assert.equal(receipt.usage[0].completeness, "UNKNOWN");
    assert.ok(receipt.usage[0].reservedOutputTokens > 0);
    await f.coordinator.execute(run.runId);
    assert.equal(provider.calls.length, 1);
  } finally {
    f.close();
  }
});
test("DATA-1 current ACL before dispatch rejects cached context and leaves zero calls", async () => {
  let f: ReturnType<typeof fixture>;
  f = fixture({
    hooks: {
      afterContext: () =>
        f.policy.revoke(
          f.actor.actorId,
          f.actor.workspaceId,
          "SEND_TO_PROVIDER",
        ),
    },
  });
  try {
    const run = f.accept();
    await f.coordinator.execute(run.runId);
    assert.equal((f.provider as FakeProvider).calls.length, 0);
    assert.equal(
      f.app.db.prepare("SELECT count(*) n FROM message_segments").get()?.n,
      1,
    );
  } finally {
    f.close();
  }
});
test("DATA-1 public context excludes saved private state even after separation OFF", async () => {
  const f = fixture();
  try {
    f.repository.appendMessage(f.actor, f.room.id, {
      role: "model",
      personaId: f.persona.id,
      segments: [
        { channel: "public_message", visibility: "public", content: "public" },
        {
          channel: "private_state",
          visibility: "self_only",
          content: "PRIVATE_CANARY",
        },
      ],
    });
    const run = f.accept();
    await f.coordinator.execute(run.runId);
    assert.equal((f.provider as FakeProvider).calls.length, 1);
    assert.ok(
      !JSON.stringify((f.provider as FakeProvider).calls).includes(
        "PRIVATE_CANARY",
      ),
    );
    assert.ok(
      !JSON.stringify(
        f.coordinator.get(f.actor, f.room.id, run.runId),
      ).includes("PRIVATE_CANARY"),
    );
  } finally {
    f.close();
  }
});
test("DATA-1 regeneration failure preserves original revision and successful explicit retry creates version", async () => {
  const provider = new FakeProvider((req, i) =>
    i === 2 ? { ...good(), finish: "SAFETY" } : good(`reply ${i}`),
  );
  const f = fixture({ provider });
  try {
    const run = f.accept();
    await f.coordinator.execute(run.runId);
    const message = f.coordinator.get(f.actor, f.room.id, run.runId).results[0];
    const retry = f.coordinator.regenerate(f.actor, f.room.id, message.id, {
      requestId: randomUUID(),
      expectedRevision: 1,
    });
    await f.coordinator.execute(retry.runId);
    assert.equal(
      f.repository.getMessage(f.actor, f.room.id, message.id).revision,
      1,
    );
    const next = f.coordinator.regenerate(f.actor, f.room.id, message.id, {
      requestId: randomUUID(),
      expectedRevision: 1,
    });
    await f.coordinator.execute(next.runId);
    assert.equal(
      f.repository.getMessage(f.actor, f.room.id, message.id).revision,
      2,
    );
    assert.equal(
      f.repository.getMessage(f.actor, f.room.id, message.id, 1).content,
      "reply 1",
    );
  } finally {
    f.close();
  }
});
test("DATA-1 unknown usage is retained and stops subsequent personas", async () => {
  const provider = new FakeProvider(() => ({
    ...good(),
    usage: { completeness: "UNKNOWN", semantics: "missing" },
  }));
  const f = fixture({ provider });
  try {
    f.repository.createPersona(f.actor, f.room.id, {
      name: "Bob",
      model: "synthetic",
    });
    const run = f.accept();
    await f.coordinator.execute(run.runId);
    const receipt = f.coordinator.get(f.actor, f.room.id, run.runId);
    assert.equal(provider.calls.length, 1);
    assert.equal(receipt.errorCode, "USAGE_INCOMPLETE");
    assert.equal(receipt.usage[0].actualCostMicros, null);
    assert.equal(receipt.usage[0].usage.inputTokens, undefined);
  } finally {
    f.close();
  }
});
test("DATA-1 canceled and ACL revoked responses preserve usage but do not publish", async () => {
  let f: ReturnType<typeof fixture>;
  let runId = "";
  const provider = new FakeProvider(() => {
    f.coordinator.cancel(f.actor, f.room.id, runId);
    return good("MUST_NOT_PUBLISH");
  });
  f = fixture({ provider });
  try {
    const run = f.accept();
    runId = run.runId;
    await f.coordinator.execute(runId);
    const receipt = f.coordinator.get(f.actor, f.room.id, runId);
    assert.equal(receipt.status, "CANCELLED");
    assert.equal(receipt.results.length, 0);
    assert.equal(receipt.usage[0].completeness, "COMPLETE");
    assert.equal(
      f.app.db.prepare("SELECT count(*) n FROM messages").get()?.n,
      1,
    );
  } finally {
    f.close();
  }
});
test("DATA-1 fixed workers have private receipts and are not echoed into public prompt", async () => {
  const provider = new FakeProvider((req) =>
    good(
      req.purpose === "subagent" ? "PRIVATE_WORKER_CANARY" : "public answer",
    ),
  );
  const f = fixture({ provider });
  try {
    f.repository.updatePersona(f.actor, f.room.id, f.persona.id, {
      expectedRevision: 1,
      subAgentPolicy: { mode: "fixed_serial" },
      subAgents: [
        {
          id: "worker",
          name: "Worker",
          provider: "synthetic",
          model: "synthetic",
          systemInstruction: "Summarize task",
          isEnabled: true,
        },
      ],
    });
    const run = f.accept();
    await f.coordinator.execute(run.runId);
    const receipt = f.coordinator.get(f.actor, f.room.id, run.runId);
    assert.equal(receipt.status, "COMPLETED");
    assert.equal(provider.calls.length, 2);
    assert.deepEqual(
      receipt.usage.map((c) => c.purpose),
      ["answer"],
    );
    assert.equal(
      f.app.db.prepare("SELECT count(*) n FROM app_provider_calls").get()?.n,
      2,
    );
    assert.ok(
      !JSON.stringify(provider.calls[1]).includes("PRIVATE_WORKER_CANARY"),
    );
    assert.ok(!JSON.stringify(receipt).includes("PRIVATE_WORKER_CANARY"));
  } finally {
    f.close();
  }
});
test("DATA-1 strict JSON rejects partial/unknown fields without exposing raw body", async () => {
  const f = fixture({
    provider: new FakeProvider(() =>
      good('{"public_message":"hello","isAdmin":true}'),
    ),
  });
  try {
    f.repository.updateRoom(f.actor, f.room.id, {
      expectedRevision: 1,
      internalStateSettings: { enabled: true },
    });
    const run = f.accept("hello", { expectedRoomRevision: 2 });
    await f.coordinator.execute(run.runId);
    const receipt = f.coordinator.get(f.actor, f.room.id, run.runId);
    assert.equal(receipt.status, "FAILED");
    assert.equal(receipt.results.length, 0);
    assert.equal(receipt.usage[0].completeness, "COMPLETE");
    assert.ok(!JSON.stringify(receipt).includes("isAdmin"));
  } finally {
    f.close();
  }
});
test("DATA-1 monotonic deadline catches delayed timers and keeps usage", async () => {
  let monotonic = 0;
  const provider = new FakeProvider(() => {
    monotonic = 121000;
    return good();
  });
  const f = fixture({ provider, monotonic: () => monotonic });
  try {
    const run = f.accept();
    await f.coordinator.execute(run.runId);
    const receipt = f.coordinator.get(f.actor, f.room.id, run.runId);
    assert.equal(receipt.errorCode, "DEADLINE_EXCEEDED");
    assert.equal(receipt.results.length, 0);
    assert.equal(receipt.usage[0].completeness, "COMPLETE");
  } finally {
    f.close();
  }
});
test("DATA-1 Gemini adapter uses exactly one HTTP request, header secret and fixed endpoint", async () => {
  let count = 0;
  const provider = new GeminiProvider({
    apiKey: "SYNTHETIC_SECRET",
    allowedModels: ["gemini-test"],
    fetch: async (url, init) => {
      count++;
      assert.equal(
        String(url),
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent",
      );
      assert.equal(
        (init?.headers as any)["x-goog-api-key"],
        "SYNTHETIC_SECRET",
      );
      throw new Error("connection reset");
    },
  });
  await assert.rejects(() =>
    provider.generate({
      model: "gemini-test",
      purpose: "answer",
      systemInstruction: "test",
      contents: [{ role: "user", parts: [{ text: "synthetic" }] }],
      maxOutputTokens: 16,
      structured: false,
      signal: new AbortController().signal,
    }),
  );
  assert.equal(count, 1);
});
test("DATA-1 queued turns remain bound to their own input and edited sources refuse dispatch", async () => {
  const f = fixture();
  try {
    const first = f.accept("FIRST_INPUT");
    const second = f.accept("SECOND_INPUT");
    await f.coordinator.execute(first.runId);
    const call = (f.provider as FakeProvider).calls[0];
    assert.ok(JSON.stringify(call).includes("FIRST_INPUT"));
    assert.ok(!JSON.stringify(call).includes("SECOND_INPUT"));
    f.repository.correctMessage(f.actor, f.room.id, second.inputMessageId, {
      expectedRevision: 1,
      content: "EDITED",
    });
    await f.coordinator.execute(second.runId);
    assert.equal((f.provider as FakeProvider).calls.length, 1);
    assert.equal(
      f.coordinator.get(f.actor, f.room.id, second.runId).errorCode,
      "INPUT_REVISION_CHANGED",
    );
  } finally {
    f.close();
  }
});
test("DATA-1 explicit group recipients use server membership while other personas retain participation decisions", async () => {
  const f = fixture({
    provider: new FakeProvider((request) =>
      good(request.purpose === "decision" ? "STAMP:ACK" : "Group answer"),
    ),
  });
  try {
    f.repository.updatePersona(f.actor, f.room.id, f.persona.id, {
      expectedRevision: 1,
      groups: ["alpha"],
    });
    f.repository.createPersona(f.actor, f.room.id, {
      name: "Bob",
      model: "synthetic",
      groups: ["beta"],
    });
    const run = f.accept("hello", {
      recipient: {
        type: "group",
        groupId: "alpha",
        agentIds: ["client-forged"],
      },
    });
    await f.coordinator.execute(run.runId);
    const receipt = f.coordinator.get(f.actor, f.room.id, run.runId);
    assert.equal((f.provider as FakeProvider).calls.length, 2);
    assert.match(
      (f.provider as FakeProvider).calls[0].systemInstruction,
      /you are explicitly targeted: no/,
    );
    assert.match(
      (f.provider as FakeProvider).calls[0].systemInstruction,
      /recipient group: alpha/,
    );
    assert.equal(receipt.results[0].agentId, f.persona.id);
    assert.equal(
      receipt.decisions.find((d) => d.agentId !== f.persona.id).outcome,
      "STAMP",
    );
  } finally {
    f.close();
  }
});
test("DATA-1 /memory stores private classified memo, excludes public output and Vault publication", async () => {
  const f = fixture();
  try {
    f.repository.updateRoom(f.actor, f.room.id, {
      expectedRevision: 1,
      internalStateSettings: { enabled: true },
    });
    const run = f.accept("/memory", { expectedRoomRevision: 2 });
    await f.coordinator.execute(run.runId);
    const receipt = f.coordinator.get(f.actor, f.room.id, run.runId);
    assert.equal(receipt.status, "COMPLETED");
    assert.equal(receipt.results.length, 0);
    assert.equal(receipt.usage.length, 0);
    const memo = f.app.db
      .prepare(
        "SELECT channel,visibility,content FROM message_segments WHERE channel='memory_export'",
      )
      .get();
    assert.equal(memo?.visibility, "self_only");
    assert.match(String(memo?.content), /Vault unpublished/);
    assert.equal((f.provider as FakeProvider).calls.length, 1);
  } finally {
    f.close();
  }
});
test("DATA-1 actual aggregate usage is recorded without clamping and stops next persona", async () => {
  const f = fixture({
    provider: new FakeProvider(() => ({
      ...good(),
      usage: {
        inputTokens: 10,
        outputTokens: 131080,
        totalTokens: 131090,
        completeness: "COMPLETE",
        semantics: "test",
      },
    })),
  });
  try {
    f.repository.createPersona(f.actor, f.room.id, {
      name: "Bob",
      model: "synthetic",
    });
    const run = f.accept();
    await f.coordinator.execute(run.runId);
    const receipt = f.coordinator.get(f.actor, f.room.id, run.runId);
    assert.equal(receipt.errorCode, "ACTUAL_BUDGET_EXCEEDED");
    assert.equal(receipt.usage[0].usage.totalTokens, 131090);
    assert.equal((f.provider as FakeProvider).calls.length, 1);
  } finally {
    f.close();
  }
});
test("DATA-1 no partial COMMIT on result audit/storage failure", async () => {
  let calls = 0;
  const f = fixture({
    hooks: {
      beforeResultCommit: () => {
        calls++;
        throw new Error("disk failure");
      },
    },
  });
  try {
    const run = f.accept();
    await f.coordinator.execute(run.runId);
    assert.equal(calls, 1);
    const receipt = f.coordinator.get(f.actor, f.room.id, run.runId);
    assert.equal(receipt.status, "NEEDS_REVIEW");
    assert.equal(receipt.results.length, 0);
    assert.equal(
      f.app.db.prepare("SELECT count(*) n FROM app_generation_receipts").get()
        ?.n,
      0,
    );
    assert.equal(
      f.app.db.prepare("SELECT count(*) n FROM messages").get()?.n,
      1,
    );
    assert.equal(receipt.usage[0].completeness, "UNKNOWN");
  } finally {
    f.close();
  }
});
test("DATA-1 result COMMIT ACK loss preserves receipt and never replays HTTP", async () => {
  const f = fixture({
    hooks: {
      afterResultCommit: () => {
        throw new Error("ACK lost");
      },
    },
  });
  try {
    const run = f.accept();
    await f.coordinator.execute(run.runId);
    const receipt = f.coordinator.get(f.actor, f.room.id, run.runId);
    assert.equal(receipt.results.length, 1);
    assert.equal(receipt.usage[0].state, "COMPLETED");
    await f.coordinator.execute(run.runId);
    assert.equal((f.provider as FakeProvider).calls.length, 1);
  } finally {
    f.close();
  }
});
test("DATA-1 outstanding accepted requests drain under finite concurrency", async () => {
  let release: () => void = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const provider = new FakeProvider(async (req, i) => {
    if (i === 1) await blocked;
    return good();
  });
  const f = fixture({ provider, limits: { maxConcurrentRuns: 1 } });
  try {
    const one = f.accept("one"),
      two = f.accept("two");
    const running = f.coordinator.execute(one.runId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await f.coordinator.execute(two.runId);
    assert.equal(provider.calls.length, 1);
    release();
    await running;
    for (
      let i = 0;
      i < 20 &&
      f.coordinator.get(f.actor, f.room.id, two.runId).status !== "COMPLETED";
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      f.coordinator.get(f.actor, f.room.id, two.runId).status,
      "COMPLETED",
    );
    assert.equal(provider.calls.length, 2);
  } finally {
    f.close();
  }
});
test("DATA-1 model names from browser never cause silent remapping or unauthorized sends", async () => {
  const f = fixture();
  try {
    f.repository.updatePersona(f.actor, f.room.id, f.persona.id, {
      expectedRevision: 1,
      model: "arbitrary-provider-model",
    });
    assert.throws(() => f.accept(), /MODEL_NOT_ALLOWED/);
    assert.equal((f.provider as FakeProvider).calls.length, 0);
    assert.equal(
      f.app.db.prepare("SELECT count(*) n FROM app_turns").get()?.n,
      0,
    );
  } finally {
    f.close();
  }
});
test("DATA-1 explicit regeneration uses current corrected input, preserving original source history", async () => {
  const f = fixture();
  try {
    const first = f.accept("ORIGINAL_INPUT");
    await f.coordinator.execute(first.runId);
    const output = f.coordinator.get(f.actor, f.room.id, first.runId)
      .results[0];
    f.repository.correctMessage(f.actor, f.room.id, first.inputMessageId, {
      expectedRevision: 1,
      content: "CORRECTED_INPUT",
    });
    const retry = f.coordinator.regenerate(f.actor, f.room.id, output.id, {
      requestId: randomUUID(),
      expectedRevision: 1,
    });
    await f.coordinator.execute(retry.runId);
    assert.equal(
      f.coordinator.get(f.actor, f.room.id, retry.runId).status,
      "COMPLETED",
    );
    const payload = JSON.stringify((f.provider as FakeProvider).calls[1]);
    assert.match(payload, /CORRECTED_INPUT/);
    assert.ok(!payload.includes("ORIGINAL_INPUT"));
    assert.equal(
      f.repository.getMessage(f.actor, f.room.id, first.inputMessageId, 1)
        .content,
      "ORIGINAL_INPUT",
    );
  } finally {
    f.close();
  }
});
test("DATA-1 malformed COMPLETE usage retains reservations and stops further calls", async () => {
  const f = fixture({
    provider: new FakeProvider(() => ({
      ...good(),
      usage: { completeness: "COMPLETE", semantics: "malformed" },
    })),
  });
  try {
    f.repository.createPersona(f.actor, f.room.id, {
      name: "Bob",
      model: "synthetic",
    });
    const run = f.accept();
    await f.coordinator.execute(run.runId);
    const receipt = f.coordinator.get(f.actor, f.room.id, run.runId);
    assert.equal(receipt.usage[0].completeness, "PARTIAL");
    assert.equal(receipt.usage[0].actualCostMicros, null);
    assert.equal(receipt.errorCode, "USAGE_INCOMPLETE");
    assert.equal((f.provider as FakeProvider).calls.length, 1);
  } finally {
    f.close();
  }
});
test("DATA-1 aggregate actual usage stops after two individually in-budget calls", async () => {
  const f = fixture({
    limits: { maxTotalTokens: 10000 },
    provider: new FakeProvider(() => ({
      ...good(),
      usage: {
        inputTokens: 1000,
        outputTokens: 5000,
        totalTokens: 6000,
        completeness: "COMPLETE",
        semantics: "test",
      },
    })),
  });
  try {
    f.repository.createPersona(f.actor, f.room.id, {
      name: "Bob",
      model: "synthetic",
    });
    f.repository.createPersona(f.actor, f.room.id, {
      name: "Carol",
      model: "synthetic",
    });
    const run = f.accept();
    await f.coordinator.execute(run.runId);
    const receipt = f.coordinator.get(f.actor, f.room.id, run.runId);
    assert.equal(receipt.errorCode, "ACTUAL_BUDGET_EXCEEDED");
    assert.equal((f.provider as FakeProvider).calls.length, 2);
    assert.equal(
      receipt.usage.reduce((sum, u) => sum + u.usage.totalTokens, 0),
      12000,
    );
  } finally {
    f.close();
  }
});
test("DATA-1 STAMP persists decision and reaction without unnecessary answer call", async () => {
  const f = fixture({ provider: new FakeProvider(() => good("STAMP:ACK")) });
  try {
    const run = f.accept("ありがとう", { recipient: { type: "auto" } });
    await f.coordinator.execute(run.runId);
    const receipt = f.coordinator.get(f.actor, f.room.id, run.runId);
    assert.equal(receipt.status, "COMPLETED");
    assert.equal(receipt.decisions[0].outcome, "STAMP");
    assert.equal(receipt.reactions[0].semantic, "ACK");
    assert.equal(receipt.results.length, 0);
    assert.equal((f.provider as FakeProvider).calls.length, 1);
  } finally {
    f.close();
  }
});
test("DATA-1 revoke after intent acknowledgement still results in zero external sends", async () => {
  let f: ReturnType<typeof fixture>;
  f = fixture({
    hooks: {
      afterIntentCommit: () =>
        f.policy.revoke(
          f.actor.actorId,
          f.actor.workspaceId,
          "SEND_TO_PROVIDER",
        ),
    },
  });
  try {
    const run = f.accept();
    await f.coordinator.execute(run.runId);
    assert.equal((f.provider as FakeProvider).calls.length, 0);
    assert.equal(
      f.app.db.prepare("SELECT state FROM app_provider_calls").get()?.state,
      "OUTCOME_UNKNOWN",
    );
  } finally {
    f.close();
  }
});
test("DATA-1 accepted settings bind their revisions and cannot be silently replaced", async () => {
  const f = fixture();
  try {
    const run = f.accept();
    f.repository.updatePersona(f.actor, f.room.id, f.persona.id, {
      expectedRevision: 1,
      systemInstruction: "Changed after acceptance",
    });
    await f.coordinator.execute(run.runId);
    assert.equal((f.provider as FakeProvider).calls.length, 0);
    assert.equal(
      f.coordinator.get(f.actor, f.room.id, run.runId).errorCode,
      "CONFIGURATION_REVISION_CHANGED",
    );
  } finally {
    f.close();
  }
});
test("DATA-1 private serial reports bind persisted source refs and cannot be reused after deletion", async () => {
  let f: ReturnType<typeof fixture>;
  let sent = 0;
  f = fixture({
    provider: new FakeProvider((request) => {
      sent++;
      return good(request.purpose === "subagent" ? "PRIVATE_CHAIN" : "answer");
    }),
    hooks: {
      afterResultCommit: () => {
        if (sent === 1) {
          const message = f.app.db
            .prepare("SELECT message_id FROM messages WHERE role='model'")
            .get() as any;
          f.app.db
            .prepare("UPDATE messages SET deleted_at=? WHERE message_id=?")
            .run(Date.now(), message.message_id);
        }
      },
    },
  });
  try {
    f.repository.updatePersona(f.actor, f.room.id, f.persona.id, {
      expectedRevision: 1,
      subAgentPolicy: { mode: "fixed_serial" },
      subAgents: [1, 2].map((n) => ({
        id: `worker-${n}`,
        name: `Worker ${n}`,
        provider: "synthetic",
        model: "synthetic",
        systemInstruction: "Task",
        isEnabled: true,
      })),
    });
    const run = f.accept();
    await f.coordinator.execute(run.runId);
    assert.equal(sent, 1);
    assert.equal(
      f.coordinator.get(f.actor, f.room.id, run.runId).errorCode,
      "PRIVATE_SOURCE_CHANGED",
    );
  } finally {
    f.close();
  }
});
test("DATA-1 authorized internal reader discovers memo, current revocation and deletion remove it", async () => {
  const f = fixture();
  try {
    f.repository.updateRoom(f.actor, f.room.id, {
      expectedRevision: 1,
      internalStateSettings: { enabled: true },
    });
    const run = f.accept("/memory", { expectedRoomRevision: 2 });
    await f.coordinator.execute(run.runId);
    assert.deepEqual(
      f.coordinator.readInternal(f.actor, f.room.id, run.runId).segments,
      [],
    );
    f.policy.grant(
      f.actor.actorId,
      f.actor.workspaceId,
      "READ_PRIVATE_SEGMENT",
      { roomId: f.room.id, personaId: f.persona.id, visibility: "self_only" },
    );
    const internal = f.coordinator.readInternal(f.actor, f.room.id, run.runId);
    assert.equal(internal.segments.length, 1);
    assert.equal(internal.segments[0].channel, "memory_export");
    f.repository.deleteMessage(
      f.actor,
      f.room.id,
      internal.segments[0].messageId,
      { expectedRevision: 1 },
    );
    assert.deepEqual(
      f.coordinator.readInternal(f.actor, f.room.id, run.runId).segments,
      [],
    );
  } finally {
    f.close();
  }
});
test("DATA-1 nested array accessors are rejected without invoking getters or side effects", () => {
  const f = fixture();
  try {
    let invoked = 0;
    const ids: any[] = [];
    Object.defineProperty(ids, "0", {
      enumerable: true,
      get() {
        invoked++;
        return "id";
      },
    });
    assert.throws(
      () => f.accept("test", { attachmentIds: ids }),
      /INVALID_INPUT/,
    );
    assert.equal(invoked, 0);
    assert.equal(
      f.app.db.prepare("SELECT count(*) n FROM messages").get()?.n,
      0,
    );
  } finally {
    f.close();
  }
});
test("DATA-1 deleted source persona after intent cannot escape cached context checks", async () => {
  let f: ReturnType<typeof fixture>;
  let other = "";
  f = fixture({
    hooks: {
      afterIntentCommit: () => {
        f.app.db
          .prepare("UPDATE personas SET deleted_at=? WHERE persona_id=?")
          .run(Date.now(), other);
      },
    },
  });
  try {
    const old = f.repository.createPersona(f.actor, f.room.id, {
      name: "Old persona",
      model: "synthetic",
      isEnabled: false,
    });
    other = old.id;
    f.repository.appendMessage(f.actor, f.room.id, {
      role: "model",
      personaId: other,
      content: "DELETED_SOURCE",
    });
    const run = f.accept();
    await f.coordinator.execute(run.runId);
    assert.equal((f.provider as FakeProvider).calls.length, 0);
    assert.equal(
      f.app.db.prepare("SELECT state FROM app_provider_calls").get()?.state,
      "OUTCOME_UNKNOWN",
    );
  } finally {
    f.close();
  }
});
test("DATA-1 schema rejects mismatched receipt run and mismatched turn actor", async () => {
  const f = fixture();
  try {
    const first = f.accept("first"),
      second = f.accept("second");
    await f.coordinator.execute(first.runId);
    assert.throws(
      () =>
        f.app.db
          .prepare("UPDATE app_generation_receipts SET run_id=? WHERE run_id=?")
          .run(second.runId, first.runId),
      /FOREIGN KEY/,
    );
    f.app.db
      .prepare(
        "INSERT INTO principals(actor_id,workspace_id,active) VALUES(?,?,1)",
      )
      .run("another", f.actor.workspaceId);
    assert.throws(
      () =>
        f.app.db
          .prepare("UPDATE app_generation_runs SET actor_id=? WHERE run_id=?")
          .run("another", first.runId),
      /FOREIGN KEY/,
    );
    assert.equal(
      f.coordinator.get(f.actor, f.room.id, first.runId).results.length,
      1,
    );
  } finally {
    f.close();
  }
});
test("DATA-1 generation permission without source-read permission cannot accept or send", () => {
  const f = fixture();
  try {
    f.policy.revoke(f.actor.actorId, f.actor.workspaceId, "READ_CONVERSATION");
    assert.throws(() => f.accept(), /FORBIDDEN/);
    assert.equal(
      f.app.db.prepare("SELECT count(*) n FROM messages").get()?.n,
      0,
    );
    assert.equal(
      f.app.db.prepare("SELECT count(*) n FROM app_generation_runs").get()?.n,
      0,
    );
    assert.equal((f.provider as FakeProvider).calls.length, 0);
  } finally {
    f.close();
  }
});
test("DATA-1 async private-read callback cannot expose internal memo", async () => {
  const f = fixture();
  try {
    f.repository.updateRoom(f.actor, f.room.id, {
      expectedRevision: 1,
      internalStateSettings: { enabled: true },
    });
    const run = f.accept("/memory", { expectedRoomRevision: 2 });
    await f.coordinator.execute(run.runId);
    const hostile = {
      assert: f.policy.assert.bind(f.policy),
      revision: f.policy.revision.bind(f.policy),
      canReadSegment: () => Promise.resolve(false),
    } as any;
    const other = new GenerationCoordinator(f.app, f.repository, hostile, {
      provider: f.provider,
      defaultModel: "synthetic",
    });
    assert.throws(
      () => other.readInternal(f.actor, f.room.id, run.runId),
      /INVALID_AUTHORIZATION_CALLBACK/,
    );
    assert.throws(
      () => other.get(f.actor, f.room.id, run.runId),
      /INVALID_AUTHORIZATION_CALLBACK/,
    );
  } finally {
    f.close();
  }
});
test("DATA-1 overlapping regenerations retain complete usage when one target revision becomes stale", async () => {
  let resolveA: () => void = () => {},
    resolveB: () => void = () => {};
  const a = new Promise<void>((r) => {
      resolveA = r;
    }),
    b = new Promise<void>((r) => {
      resolveB = r;
    });
  const provider = new FakeProvider(async (_request, i) => {
    if (i === 2) await a;
    if (i === 3) await b;
    return good(`answer ${i}`);
  });
  const f = fixture({ provider });
  try {
    const initial = f.accept();
    await f.coordinator.execute(initial.runId);
    const message = f.coordinator.get(f.actor, f.room.id, initial.runId)
      .results[0];
    const first = f.coordinator.regenerate(f.actor, f.room.id, message.id, {
      requestId: randomUUID(),
      expectedRevision: 1,
    });
    const second = f.coordinator.regenerate(f.actor, f.room.id, message.id, {
      requestId: randomUUID(),
      expectedRevision: 1,
    });
    const runA = f.coordinator.execute(first.runId),
      runB = f.coordinator.execute(second.runId);
    for (let i = 0; i < 20 && provider.calls.length < 3; i++)
      await new Promise((r) => setTimeout(r, 5));
    assert.equal(provider.calls.length, 3);
    resolveA();
    await runA;
    resolveB();
    await runB;
    const receipt = f.coordinator.get(f.actor, f.room.id, second.runId);
    assert.equal(receipt.errorCode, "REVISION_CONFLICT");
    assert.equal(receipt.usage[0].completeness, "COMPLETE");
    assert.equal(receipt.usage[0].state, "DISCARDED");
    assert.equal(
      f.repository.getMessage(f.actor, f.room.id, message.id).content,
      "answer 2",
    );
    assert.equal(
      f.repository.getMessage(f.actor, f.room.id, message.id).revision,
      2,
    );
  } finally {
    resolveA();
    resolveB();
    f.close();
  }
});
test("DATA-1 regeneration queue and shutdown are bounded before acceptance", async () => {
  const f = fixture();
  try {
    const initial = f.accept();
    await f.coordinator.execute(initial.runId);
    const message = f.coordinator.get(f.actor, f.room.id, initial.runId)
      .results[0];
    for (let i = 0; i < 64; i++)
      f.coordinator.regenerate(f.actor, f.room.id, message.id, {
        requestId: randomUUID(),
        expectedRevision: 1,
      });
    assert.throws(
      () =>
        f.coordinator.regenerate(f.actor, f.room.id, message.id, {
          requestId: randomUUID(),
          expectedRevision: 1,
        }),
      /QUEUE_FULL/,
    );
    assert.equal(
      f.app.db.prepare("SELECT count(*) n FROM app_generation_runs").get()?.n,
      65,
    );
    await f.coordinator.shutdown();
    assert.throws(
      () =>
        f.coordinator.regenerate(f.actor, f.room.id, message.id, {
          requestId: randomUUID(),
          expectedRevision: 1,
        }),
      /SERVER_STOPPING/,
    );
  } finally {
    f.close();
  }
});
