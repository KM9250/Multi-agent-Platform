import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AppDatabase } from "../server/app-data/db.ts";
import {
  AuthorizationPolicy,
  PUBLIC_USER_OPERATIONS,
} from "../server/auth/authorization.ts";
import { ConversationRepository } from "../server/app-data/repository.ts";
import { GenerationCoordinator } from "../server/generation/coordinator.ts";
import { FakeProvider } from "../server/generation/provider.ts";
import { MemoryCandidates } from "../server/memory/candidates.ts";
import type { CoordinatorOptions } from "../server/generation/types.ts";

function setup(
  t: { after(fn: () => void): void },
  options: Partial<CoordinatorOptions> = {},
) {
  const root = mkdtempSync(join(tmpdir(), "map-candidates-"));
  const app = new AppDatabase({ root }),
    policy = new AuthorizationPolicy(app);
  const actor = { workspaceId: "workspace", actorId: "reviewer" };
  const second = { workspaceId: actor.workspaceId, actorId: "reader" };
  app.db.prepare("INSERT INTO workspaces VALUES(?,1)").run(actor.workspaceId);
  for (const a of [actor, second]) {
    app.db
      .prepare("INSERT INTO principals VALUES(?,?,1)")
      .run(a.actorId, a.workspaceId);
    for (const op of PUBLIC_USER_OPERATIONS)
      policy.grant(a.actorId, a.workspaceId, op);
  }
  const repo = new ConversationRepository(app, policy);
  const room = repo.createRoom(actor, {
    title: "Synthetic",
    internalStateSettings: { enabled: true },
  });
  const persona = repo.createPersona(actor, room.id, {
    name: "Synthetic",
    model: "synthetic",
  });
  const scope = {
    roomId: room.id,
    personaId: persona.id,
    visibility: "persona_private",
  };
  const grant = (op: string, who = actor, visibility = scope.visibility) =>
    policy.grant(who.actorId, who.workspaceId, op, { ...scope, visibility });
  for (const op of [
    "READ_MEMORY",
    "PROPOSE_MEMORY",
    "EDIT_MEMORY",
    "REVIEW_MEMORY",
    "PUBLISH_MEMORY",
  ])
    grant(op);
  grant("READ_PRIVATE_SEGMENT", actor, "self_only");
  const provider =
    options.provider ??
    new FakeProvider(() => ({
      text: JSON.stringify({
        memory_export: [
          { visibility: "self_only", content: "Synthetic A" },
          { visibility: "self_only", content: "Synthetic B" },
        ],
      }),
      finish: "STOP",
      usage: {
        completeness: "COMPLETE",
        inputTokens: 4,
        outputTokens: 4,
        totalTokens: 8,
        semantics: "synthetic",
      },
    }));
  const coordinator = new GenerationCoordinator(app, repo, policy, {
    provider,
    defaultModel: "synthetic",
    ...options,
  });
  const candidates = new MemoryCandidates(app, policy);
  async function generate(content = " /memory ", requestId = randomUUID()) {
    const run = coordinator.accept(actor, room.id, {
      requestId,
      expectedRoomRevision: room.revision,
      content,
      recipient: { type: "all" },
    });
    await coordinator.execute(run.runId);
    return coordinator.get(actor, room.id, run.runId);
  }
  const list = () => candidates.list(actor, room.id).items;
  const count = (name: string) =>
    Number(app.db.prepare("SELECT count(*) n FROM " + name).get()?.n);
  t.after(() => {
    app.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    app,
    actor,
    second,
    repo,
    policy,
    room,
    persona,
    provider,
    coordinator,
    candidates,
    generate,
    list,
    grant,
    count,
  };
}

test("MEM-1 committed export items and receipt survive lost ack, repeated acceptance and execution", async (t) => {
  const f = setup(t, {
    hooks: {
      afterResultCommit() {
        throw new Error("synthetic ack loss");
      },
    },
  });
  const requestId = randomUUID();
  const run = await f.generate(" /memory ", requestId);
  const repeated = await f.generate(" /memory ", requestId);
  assert.equal(run.runId, repeated.runId);
  assert.equal((f.provider as FakeProvider).calls.length, 1);
  assert.equal(f.count("memory_candidates"), 2);
  assert.equal(f.count("app_generation_receipts"), 1);
  assert.equal(f.count("memory_jobs"), 0);
  for (const row of f.list()) {
    assert.equal(row.state, "PENDING_REVIEW");
    assert.equal(row.kind, "unclassified");
    assert.equal(row.assertionType, "unclassified");
    assert.equal(row.scope, "persona_private");
    assert.equal(row.provenance?.runId, run.runId);
    assert.equal(row.provenance?.provider, "synthetic");
    assert.equal(row.sourceRefs.length, 1);
    assert.equal(
      f.candidates.source(f.actor, f.room.id, row.id).body,
      row.body,
    );
    assert.ok(!JSON.stringify(run.results).includes(row.body));
  }
});

test("MEM-1 uncommitted result, incomplete output and ineligible answer exports do not create candidates", async (t) => {
  const f = setup(t, {
    hooks: {
      beforeResultCommit() {
        throw new Error("synthetic before commit");
      },
    },
  });
  await f.generate();
  assert.equal(f.count("memory_candidates"), 0);
  assert.equal(f.count("app_generation_receipts"), 0);
  const incomplete = setup(t, {
    provider: new FakeProvider(() => ({
      text: '{"memory_export":[]}',
      finish: "INCOMPLETE",
      usage: { completeness: "UNKNOWN", semantics: "test" },
    })),
  });
  await incomplete.generate();
  assert.equal(incomplete.count("memory_candidates"), 0);
  const answer = setup(t, {
    provider: new FakeProvider(() => ({
      text: JSON.stringify({
        public_message: "Quoted /memory",
        memory_export: [
          { visibility: "self_only", content: "Unexpected proposal" },
        ],
      }),
      finish: "STOP",
      usage: {
        completeness: "COMPLETE",
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        semantics: "test",
      },
    })),
  });
  await answer.generate("Quoted /memory from another message");
  assert.equal(answer.count("memory_candidates"), 0);
});

test("MEM-1 unauthorized candidate, counts and private original remain opaque", async (t) => {
  const f = setup(t);
  await f.generate();
  const [item] = f.list();
  assert.deepEqual(f.candidates.list(f.second, f.room.id), {
    items: [],
    nextCursor: null,
  });
  assert.throws(
    () => f.candidates.get(f.second, f.room.id, item.id),
    /NOT_FOUND/,
  );
  const other = f.repo.createPersona(f.actor, f.room.id, {
    name: "Other",
    model: "synthetic",
  });
  f.policy.grant(f.second.actorId, f.second.workspaceId, "READ_MEMORY", {
    roomId: f.room.id,
    personaId: other.id,
    visibility: "persona_private",
  });
  assert.equal(f.candidates.list(f.second, f.room.id).items.length, 0);
  f.grant("READ_MEMORY", f.second);
  const readable = f.candidates.get(f.second, f.room.id, item.id);
  assert.equal(readable.body, item.body);
  assert.deepEqual(readable.sourceRefs, []);
  assert.equal(readable.provenance, null);
  assert.throws(
    () => f.candidates.source(f.second, f.room.id, item.id),
    /NOT_FOUND/,
  );
  assert.throws(
    () => f.candidates.get(f.actor, "different", item.id),
    /NOT_FOUND/,
  );
});

test("MEM-1 batch validates every reviewed field before enqueueing, edits and reviews are idempotent", async (t) => {
  const f = setup(t);
  await f.generate();
  let [first, second] = f.list();
  const edit = {
    requestId: randomUUID(),
    expectedRevision: 1,
    body: "Edited by reviewer",
    kind: "episodic",
    assertionType: "user_assertion",
    scope: "persona_private",
  };
  const approve = (items: unknown[], requestId = randomUUID()) =>
    f.candidates.review(f.actor, f.room.id, {
      requestId,
      decision: "approve",
      items,
    });
  const old = second.binding;
  second = f.candidates.edit(f.actor, f.room.id, second.id, edit);
  assert.equal(
    f.candidates.edit(f.actor, f.room.id, second.id, edit).revision,
    2,
  );
  assert.throws(
    () =>
      f.candidates.edit(f.actor, f.room.id, second.id, {
        ...edit,
        body: "other",
      }),
    /REQUEST_CONFLICT/,
  );
  for (const altered of [
    old,
    { ...second.binding, bodyDigest: "x" },
    { ...second.binding, sourcesDigest: "x" },
    { ...second.binding, scope: "room_shared" },
    { ...second.binding, ownerPersonaId: "other" },
    { ...second.binding, targetNoteId: "stolen" },
  ]) {
    assert.throws(() => approve([first.binding, altered]), /REVISION_CONFLICT/);
    assert.equal(f.count("memory_reviews"), 0);
    assert.equal(f.count("memory_jobs"), 0);
    assert.equal(
      f.candidates.get(f.actor, f.room.id, first.id).state,
      "PENDING_REVIEW",
    );
  }
  const request = randomUUID(),
    bindings = [first.binding, second.binding];
  approve(bindings, request);
  approve(bindings, request);
  assert.equal(f.count("memory_reviews"), 2);
  assert.equal(f.count("memory_jobs"), 2);
  assert.equal(f.count("memory_candidate_revisions"), 3);
});

test("MEM-1 scope promotion needs explicit separate authority and stays private until publication", async (t) => {
  const f = setup(t);
  await f.generate();
  const [item] = f.list();
  const edit = {
    requestId: randomUUID(),
    expectedRevision: 1,
    body: item.body,
    kind: item.kind,
    assertionType: item.assertionType,
    scope: "room_shared",
  };
  assert.throws(
    () => f.candidates.edit(f.actor, f.room.id, item.id, edit),
    /FORBIDDEN/,
  );
  f.grant("CHANGE_MEMORY_SCOPE", f.actor, "room_shared");
  const updated = f.candidates.edit(f.actor, f.room.id, item.id, edit);
  f.grant("READ_MEMORY", f.second, "room_shared");
  assert.equal(f.candidates.list(f.second, f.room.id).items.length, 0);
  const request = {
    requestId: randomUUID(),
    decision: "approve",
    items: [updated.binding],
  };
  assert.throws(
    () => f.candidates.review(f.actor, f.room.id, request),
    /FORBIDDEN/,
  );
  f.grant("PUBLISH_MEMORY", f.actor, "room_shared");
  assert.equal(
    f.candidates.review(f.actor, f.room.id, request).items[0].state,
    "APPROVED",
  );
});

test("MEM-1 withdrawing a pending or approved candidate requires permission, binds its revision and cancels the durable job", async (t) => {
  const f = setup(t);
  const run = await f.generate();
  const [a, b] = f.list();
  const withdraw = (candidate: typeof a, requestId = randomUUID()) =>
    f.candidates.retract(f.actor, f.room.id, candidate.id, {
      requestId,
      binding: candidate.binding,
    });
  assert.throws(() => withdraw(a), /FORBIDDEN/);
  f.grant("RETRACT_MEMORY");
  assert.throws(
    () => withdraw({ ...a, binding: { ...a.binding, bodyDigest: "other" } }),
    /REVISION_CONFLICT/,
  );
  const request = randomUUID();
  assert.equal(withdraw(a, request).state, "RETRACTED");
  assert.equal(withdraw(a, request).state, "RETRACTED");
  f.candidates.review(f.actor, f.room.id, {
    requestId: randomUUID(),
    decision: "approve",
    items: [b.binding],
  });
  assert.equal(withdraw(b).state, "RETRACTED");
  assert.equal(
    f.app.db.prepare("SELECT status FROM memory_jobs").get()?.status,
    "RETRACTED",
  );
  assert.equal(f.count("memory_receipts"), 0);
  assert.equal(f.count("app_generation_receipts"), 1);
  assert.equal(
    f.coordinator.readInternal(f.actor, f.room.id, run.runId).segments.length,
    2,
  );
});

test("MEM-1 result rejected by budget or incomplete usage preserves DATA-1 usage, without a proposal", async (t) => {
  for (const [usage, reason] of [
    [{ completeness: "PARTIAL", inputTokens: 1 }, "USAGE_INCOMPLETE"],
    [
      {
        completeness: "COMPLETE",
        inputTokens: 1,
        outputTokens: 140000,
        totalTokens: 140001,
      },
      "ACTUAL_BUDGET_EXCEEDED",
    ],
  ] as const) {
    const f = setup(t, {
      provider: new FakeProvider(() => ({
        text: JSON.stringify({
          memory_export: [
            { visibility: "self_only", content: "Synthetic segment" },
          ],
        }),
        finish: "STOP",
        usage: { ...usage, semantics: "test" },
      })),
    });
    const run = await f.generate();
    assert.equal(run.errorCode, reason);
    assert.equal(f.count("memory_candidates"), 0);
    assert.equal(f.count("app_generation_receipts"), 1);
    assert.equal(run.usage[0].completeness, usage.completeness);
    if (usage.completeness === "PARTIAL")
      assert.equal(run.usage[0].actualCostMicros, null);
  }
});

test("MEM-1 batch rejection needs review authority and current bindings, persists no publication", async (t) => {
  const f = setup(t);
  await f.generate();
  f.grant("READ_MEMORY", f.second);
  const items = f.list().map((candidate) => candidate.binding);
  const request = { decision: "reject", requestId: randomUUID(), items };
  assert.throws(
    () => f.candidates.review(f.second, f.room.id, request),
    /FORBIDDEN/,
  );
  f.grant("REVIEW_MEMORY", f.second);
  assert.throws(
    () =>
      f.candidates.review(f.second, f.room.id, {
        ...request,
        items: [items[0], { ...items[1], revision: 20 }],
      }),
    /REVISION_CONFLICT/,
  );
  assert.equal(f.count("memory_reviews"), 0);
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = f.candidates.review(f.second, f.room.id, request);
    assert.deepEqual(
      result.items.map((item) => item.state),
      ["REJECTED", "REJECTED"],
    );
  }
  assert.equal(f.count("memory_reviews"), 2);
  assert.equal(f.count("memory_jobs"), 0);
  assert.throws(
    () =>
      f.candidates.review(f.second, f.room.id, {
        ...request,
        decision: "approve",
      }),
    /REQUEST_CONFLICT/,
  );
});
