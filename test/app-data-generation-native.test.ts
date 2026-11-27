import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { appFixture } from "./app-data-fixture";
import { GenerationCoordinator } from "../server/generation/coordinator";
import { GeminiProvider } from "../server/generation/provider";
const pricing = {
  version: "synthetic-pricing-test",
  inputMicrosPerMillion: 1_000_000,
  outputMicrosPerMillion: 2_000_000,
};
function nativeFixture(fetcher: typeof fetch) {
  const f = appFixture();
  f.repository.updatePersona(f.actor, f.room.id, f.persona.id, {
    expectedRevision: 1,
    model: "gemini-test",
  });
  const provider = new GeminiProvider({
    apiKey: "SYNTHETIC-NOT-A-REAL-KEY",
    allowedModels: ["gemini-test"],
    fetch: fetcher,
  });
  const generation = new GenerationCoordinator(f.app, f.repository, f.policy, {
    provider,
    defaultModel: "gemini-test",
    pricing,
  });
  return { ...f, generation };
}
for (const sample of [
  {
    name: "complete without optional counters",
    usage: {
      promptTokenCount: 10,
      candidatesTokenCount: 5,
      totalTokenCount: 15,
    },
    expected: "COMPLETE",
    cost: 20,
  },
  {
    name: "partial missing required output counters",
    usage: { promptTokenCount: 10 },
    expected: "PARTIAL",
    cost: null,
  },
  {
    name: "missing all counters",
    usage: undefined,
    expected: "UNKNOWN",
    cost: null,
  },
  {
    name: "unexplained total without thoughts",
    usage: {
      promptTokenCount: 10,
      candidatesTokenCount: 5,
      totalTokenCount: 20,
    },
    expected: "PARTIAL",
    cost: null,
  },
  {
    name: "explicit reconciled thoughts",
    usage: {
      promptTokenCount: 10,
      candidatesTokenCount: 5,
      thoughtsTokenCount: 5,
      totalTokenCount: 20,
    },
    expected: "COMPLETE",
    cost: 30,
  },
])
  test(`native Gemini ${sample.name}: persisted usage remains valid, absent counters stay absent and readers never resend`, async () => {
    let httpCalls = 0;
    const f = nativeFixture(async (url) => {
      httpCalls++;
      assert.equal(
        String(url),
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent",
      );
      return new Response(
        JSON.stringify({
          candidates: [
            {
              finishReason: "STOP",
              content: { parts: [{ text: "NATIVE_MOCK_PUBLIC" }] },
            },
          ],
          ...(sample.usage ? { usageMetadata: sample.usage } : {}),
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
    try {
      const input = {
        requestId: randomUUID(),
        expectedRoomRevision: 1,
        content: "synthetic",
        recipient: { type: "all" as const },
      };
      const accepted = f.generation.accept(f.actor, f.room.id, input);
      await f.generation.execute(accepted.runId);
      const receipt = f.generation.get(f.actor, f.room.id, accepted.runId);
      assert.equal(receipt.usage[0].completeness, sample.expected);
      assert.equal(receipt.usage[0].actualCostMicros, sample.cost);
      assert.equal(
        Object.hasOwn(receipt.usage[0].usage, "cachedInputTokens"),
        false,
      );
      if (!Object.hasOwn(sample.usage ?? {}, "thoughtsTokenCount"))
        assert.equal(
          Object.hasOwn(receipt.usage[0].usage, "thoughtsTokens"),
          false,
        );
      assert.equal(
        f.app.db
          .prepare(
            "SELECT json_valid(usage_json) valid FROM app_provider_calls",
          )
          .get()?.valid,
        1,
      );
      assert.equal(
        receipt.status,
        sample.expected === "COMPLETE" ? "COMPLETED" : "PARTIAL",
      );
      if (sample.expected !== "COMPLETE") {
        assert.ok(receipt.usage[0].reservedCostMicros > 0);
        assert.equal(receipt.errorCode, "USAGE_INCOMPLETE");
      }
      const duplicate = f.generation.accept(f.actor, f.room.id, input);
      assert.equal(duplicate.newlyAccepted, false);
      assert.deepEqual(duplicate.usage, receipt.usage);
      assert.deepEqual(
        f.generation.list(f.actor, f.room.id)[0].usage,
        receipt.usage,
      );
      await f.generation.execute(accepted.runId);
      assert.equal(httpCalls, 1);
    } finally {
      f.dispose();
    }
  });
for (const mode of ["socket-close", "503"] as const)
  test(`native Gemini ${mode} counts one actual loopback POST and retains unknown reservation`, async () => {
    let posts = 0;
    const server = createServer(async (req, res) => {
      for await (const _ of req) {
      }
      posts++;
      assert.equal(req.method, "POST");
      if (mode === "socket-close") req.socket.destroy();
      else {
        res.writeHead(503, { connection: "close" });
        res.end("UNTRUSTED_PROVIDER_BODY");
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const origin = `http://127.0.0.1:${(server.address() as any).port}`;
    const f = nativeFixture(async (url, init) => {
      assert.equal(
        String(url),
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent",
      );
      return fetch(origin, init);
    });
    try {
      const accepted = f.generation.accept(f.actor, f.room.id, {
        requestId: randomUUID(),
        expectedRoomRevision: 1,
        content: "synthetic",
        recipient: { type: "all" },
      });
      await f.generation.execute(accepted.runId);
      const receipt = f.generation.get(f.actor, f.room.id, accepted.runId);
      assert.equal(receipt.status, "NEEDS_REVIEW");
      assert.equal(receipt.results.length, 0);
      assert.equal(receipt.usage[0].completeness, "UNKNOWN");
      assert.ok(receipt.usage[0].reservedCostMicros > 0);
      assert.equal(
        f.app.db.prepare("SELECT count(*) n FROM messages").get()?.n,
        1,
      );
      assert.ok(!JSON.stringify(receipt).includes("UNTRUSTED_PROVIDER_BODY"));
      await f.generation.execute(accepted.runId);
      assert.equal(posts, 1);
    } finally {
      f.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
test("text-only answer preflight still rejects actual Host overflow before search or dispatch", async () => {
  const f = appFixture();
  const generation = new GenerationCoordinator(f.app, f.repository, f.policy, {
    provider: f.provider, defaultModel: "synthetic", limits: { maxInputTokens: 789 },
  });
  try {
    const run = generation.accept(f.actor, f.room.id, {
      requestId: randomUUID(), expectedRoomRevision: f.room.revision,
      content: "本文。".repeat(400), recipient: { type: "all" }, context: { mode: "both" },
    });
    await generation.execute(run.runId);
    assert.equal(generation.get(f.actor, f.room.id, run.runId).errorCode, "CONTEXT_LIMIT");
    assert.equal(f.provider.calls.length, 0);
    assert.equal(f.app.db.prepare("SELECT count(*) n FROM app_provider_calls").get()!.n, 0);
    assert.equal(f.app.db.prepare("SELECT count(*) n FROM search_operations").get()!.n, 0);
  } finally {
    await generation.shutdown(); await f.generation.shutdown(); f.dispose();
  }
});

for (const count of [1, 8])
  test(`context preflight rejects ${count === 1 ? "single oversized" : "aggregate"} attachments before any body read or provider dispatch`, async () => {
    const f = appFixture();
    let reads = 0;
    try {
      const attachmentIds: string[] = [];
      for (let i = 0; i < count; i++) {
        const id = randomUUID();
        attachmentIds.push(id);
        f.app.db
          .prepare(
            "INSERT INTO attachments VALUES(?,?,?,?,?,?,?,?,?,'AVAILABLE',?,NULL)",
          )
          .run(
            f.actor.workspaceId,
            f.room.id,
            id,
            f.actor.actorId,
            "synthetic.txt",
            "text/plain",
            randomUUID(),
            "a".repeat(64),
            count === 1 ? 8 * 1024 * 1024 : 2048,
            Date.now(),
          );
      }
      const attachmentStore = {
        async read() {
          reads++;
          throw new Error("must not read");
        },
        async readForContext() {
          reads++;
          throw new Error("must not read");
        },
      };
      const generation = new GenerationCoordinator(
        f.app,
        f.repository,
        f.policy,
        { provider: f.provider, defaultModel: "synthetic", attachmentStore },
      );
      const accepted = generation.accept(f.actor, f.room.id, {
        requestId: randomUUID(),
        expectedRoomRevision: 1,
        content: "synthetic",
        attachmentIds,
        recipient: { type: "all" },
      });
      await generation.execute(accepted.runId);
      assert.equal(
        generation.get(f.actor, f.room.id, accepted.runId).errorCode,
        "CONTEXT_LIMIT",
      );
      assert.equal(reads, 0);
      assert.equal(f.provider.calls.length, 0);
      assert.equal(
        f.app.db.prepare("SELECT count(*) n FROM app_provider_calls").get()?.n,
        0,
      );
    } finally {
      f.dispose();
    }
  });
