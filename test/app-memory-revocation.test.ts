import assert from "node:assert/strict";
import test from "node:test";
import {
  PUBLIC_USER_OPERATIONS,
  type ResourceScope,
} from "../server/auth/authorization.ts";
import { publishNext } from "../server/memory/worker.ts";
import { readNote } from "../server/memory/notes.ts";
import { lineageFixture } from "./memory-lineage-fixture.ts";

const cases = [
  { name: "unchanged ACL", operation: "unchanged", allowed: true },
  { name: "MANAGE_VAULT only", operation: "MANAGE_VAULT", allowed: true },
  {
    name: "used READ_PRIVATE_SEGMENT then regrant",
    operation: "READ_PRIVATE_SEGMENT",
    allowed: false,
  },
  { name: "all operations then regrant", operation: "ALL", allowed: false },
];

function grantsUsedByFixture(f: ReturnType<typeof lineageFixture>) {
  return f.app.db
    .prepare(
      `SELECT operation,room_id,persona_id,visibility,provider FROM access_grants
    WHERE workspace_id=? AND actor_id=? AND revoked_at IS NULL ORDER BY grant_id`,
    )
    .all(f.actor.workspaceId, f.actor.actorId)
    .map((row) => {
      const scope: ResourceScope = {};
      if (row.room_id !== "*") scope.roomId = String(row.room_id);
      if (row.persona_id !== "*") scope.personaId = String(row.persona_id);
      if (row.visibility !== "*") scope.visibility = String(row.visibility);
      if (row.provider !== "*") scope.provider = String(row.provider);
      return { operation: String(row.operation), scope };
    });
}

for (const scenario of cases) {
  test(
    "PR39 F-07 real generation and approval with " + scenario.name,
    async (t) => {
      const f = lineageFixture();
      t.after(f.close);
      f.policy.grant(f.actor.actorId, f.actor.workspaceId, "MANAGE_VAULT");
      f.original();
      const privateSeed = await f.memory();
      const first = await f.memory();
      assert.ok(first.manifestInputs.includes(privateSeed.outputId));
      assert.ok(
        f.app.db
          .prepare(
            `SELECT 1 FROM memory_authorities WHERE candidate_id=? AND operation='READ_PRIVATE_SEGMENT'
      AND actor_id=? AND room_id=? AND persona_id=? AND visibility='self_only'`,
          )
          .get(first.candidate.id, f.actor.actorId, f.room.id, f.persona.id),
      );
      f.publish(first.candidate.id);
      assert.equal(
        readNote(f.app, f.policy, f.actor, first.noteId).body,
        "予定は月曜",
      );
      const grants = grantsUsedByFixture(f);
      if (scenario.operation !== "unchanged") {
        f.policy.revoke(
          f.actor.actorId,
          f.actor.workspaceId,
          scenario.operation === "ALL" ? undefined : scenario.operation,
        );
        if (
          scenario.operation === "READ_PRIVATE_SEGMENT" ||
          scenario.operation === "ALL"
        ) {
          // The original scoped grant is genuinely absent. Restore the same scopes before generating.
          assert.throws(() =>
            f.policy.assert(f.actor, "READ_PRIVATE_SEGMENT", {
              roomId: f.room.id,
              personaId: f.persona.id,
              visibility: "self_only",
            }),
          );
          for (const g of grants)
            if (
              scenario.operation === "ALL" ||
              g.operation === scenario.operation
            )
              f.policy.grant(
                f.actor.actorId,
                f.actor.workspaceId,
                g.operation,
                g.scope,
              );
          f.policy.assert(f.actor, "READ_PRIVATE_SEGMENT", {
            roomId: f.room.id,
            personaId: f.persona.id,
            visibility: "self_only",
          });
        }
      }
      const next = await f.memory();
      assert.ok(
        next.manifestInputs.includes(first.outputId),
        "second manifest includes the first committed output",
      );
      // Attempt normal human review even for a held candidate; a state label alone cannot establish refusal.
      let approved = false;
      try {
        f.publish(next.candidate.id);
        approved = true;
      } catch (error) {
        if (
          !["REVISION_CONFLICT", "SOURCE_CHANGED"].includes(
            (error as { code: string }).code,
          )
        )
          throw error;
      }
      const state = f.candidates.get(
        f.actor,
        f.room.id,
        next.candidate.id,
      ).state;
      const jobs = Number(
        f.app.db
          .prepare("SELECT count(*) AS n FROM memory_jobs WHERE candidate_id=?")
          .get(next.candidate.id)!.n,
      );
      const outcome = {
        stateAfterGeneration: next.candidate.state,
        approved,
        finalState: state,
        jobs,
      };
      t.diagnostic(
        JSON.stringify({
          includesFirstOutput: next.manifestInputs.includes(first.outputId),
          ...outcome,
        }),
      );
      assert.deepEqual(
        outcome,
        scenario.allowed
          ? {
              stateAfterGeneration: "PENDING_REVIEW",
              approved: true,
              finalState: "PUBLISHED",
              jobs: 1,
            }
          : {
              stateAfterGeneration: "NEEDS_REVIEW",
              approved: false,
              finalState: "NEEDS_REVIEW",
              jobs: 0,
            },
      );
      if (scenario.allowed)
        assert.equal(
          readNote(f.app, f.policy, f.actor, next.noteId).body,
          "予定は月曜",
        );
    },
  );
}

test("PR39 F-07 an operation revoke records each affected grant atomically with memory invalidation and preserves scope boundaries", async (t) => {
  const { createHistoricalGrantCheck } =
    await import("../server/auth/revocations.ts");
  const f = lineageFixture();
  t.after(f.close);
  const { app, policy, actor } = f;
  const otherRoom = f.repository.createRoom(actor, {
    title: "Second room",
    internalStateSettings: { enabled: true },
  });
  const otherPersona = f.repository.createPersona(actor, f.room.id, {
    name: "Second persona",
    model: "synthetic",
  });
  // Keep the second persona out of generation while using its real ID for grant scope checks.
  f.repository.updatePersona(actor, f.room.id, otherPersona.id, {
    expectedRevision: 1,
    isEnabled: false,
  });
  const a = {
    roomId: f.room.id,
    personaId: f.persona.id,
    visibility: "self_only",
  };
  const b = { ...a, personaId: otherPersona.id, visibility: "gm_only" };
  const otherActor = {
    workspaceId: actor.workspaceId,
    actorId: "different-actor",
  };
  app.db
    .prepare("INSERT INTO principals VALUES(?,?,1)")
    .run(otherActor.actorId, actor.workspaceId);
  policy.grant(actor.actorId, actor.workspaceId, "READ_PRIVATE_SEGMENT", b);
  policy.grant(
    otherActor.actorId,
    actor.workspaceId,
    "READ_PRIVATE_SEGMENT",
    a,
  );
  // Publish an independent note through the same DB and worker, with its own actor, room and persona.
  const independentPersona = f.repository.createPersona(actor, otherRoom.id, {
    name: "Independent",
    model: "synthetic",
  });
  const independentScope = {
    roomId: otherRoom.id,
    personaId: independentPersona.id,
    visibility: "persona_private",
  };
  for (const op of PUBLIC_USER_OPERATIONS)
    policy.grant(otherActor.actorId, actor.workspaceId, op);
  for (const op of [
    "READ_MEMORY",
    "PROPOSE_MEMORY",
    "REVIEW_MEMORY",
    "PUBLISH_MEMORY",
  ])
    policy.grant(otherActor.actorId, actor.workspaceId, op, independentScope);
  policy.grant(otherActor.actorId, actor.workspaceId, "READ_PRIVATE_SEGMENT", {
    ...independentScope,
    visibility: "self_only",
  });
  const independent = f.generation.accept(otherActor, otherRoom.id, {
    requestId: "independent",
    expectedRoomRevision: otherRoom.revision,
    content: "/memory",
    recipient: { type: "all" },
  });
  await f.generation.execute(independent.runId);
  assert.equal(
    f.generation.get(otherActor, otherRoom.id, independent.runId).status,
    "COMPLETED",
  );
  const [item] = f.candidates.list(otherActor, otherRoom.id).items;
  f.candidates.review(otherActor, otherRoom.id, {
    requestId: "review-independent",
    decision: "approve",
    items: [item.binding],
  });
  assert.equal(publishNext(app, policy), true);
  const published = readNote(
    app,
    policy,
    otherActor,
    item.binding.targetNoteId,
  );
  f.original();
  await f.memory();
  const source = await f.memory();
  f.publish(source.candidate.id);
  const before = policy.revision(actor);
  const entries = (revision: number) =>
    app.db
      .prepare(
        `SELECT grant_id,operation,room_id,persona_id,provider,visibility FROM auth_revoked_grants
    WHERE workspace_id=? AND actor_id=? AND revision=? ORDER BY grant_id`,
      )
      .all(actor.workspaceId, actor.actorId, revision);
  const affected = app.db
    .prepare(
      `SELECT grant_id,operation,room_id,persona_id,provider,visibility FROM access_grants
    WHERE workspace_id=? AND actor_id=? AND operation='READ_PRIVATE_SEGMENT' AND revoked_at IS NULL ORDER BY grant_id`,
    )
    .all(actor.workspaceId, actor.actorId);
  assert.equal(affected.length, 2);
  assert.throws(
    () =>
      app.transaction(() => {
        policy.revoke(actor.actorId, actor.workspaceId, "READ_PRIVATE_SEGMENT");
        assert.equal(
          f.candidates.get(actor, f.room.id, source.candidate.id).state,
          "NEEDS_REVIEW",
        );
        assert.deepEqual(entries(before + 1), affected);
        throw new Error("synthetic rollback");
      }),
    /synthetic rollback/,
  );
  assert.equal(policy.revision(actor), before);
  assert.deepEqual(entries(before + 1), []);
  assert.equal(
    f.candidates.get(actor, f.room.id, source.candidate.id).state,
    "PUBLISHED",
  );
  policy.assert(actor, "READ_PRIVATE_SEGMENT", a);
  policy.revoke(actor.actorId, actor.workspaceId, "READ_PRIVATE_SEGMENT");
  assert.deepEqual(entries(before + 1), affected);
  const matches = createHistoricalGrantCheck(app.db);
  const grant = (scope: ResourceScope) => ({
    operation: "READ_PRIVATE_SEGMENT",
    roomId: scope.roomId!,
    personaId: scope.personaId,
    visibility: scope.visibility,
  });
  // The check asks whether an input grant has uninterrupted history; current authorization is independent.
  const uninterrupted = (target: typeof actor, s: ResourceScope) =>
    matches(actor.workspaceId, target.actorId, before, [grant(s)]);
  assert.equal(uninterrupted(actor, a), false);
  assert.equal(uninterrupted(actor, b), false);
  assert.equal(uninterrupted(actor, { ...a, roomId: otherRoom.id }), true);
  assert.equal(
    uninterrupted(actor, { ...a, personaId: otherPersona.id }),
    true,
  );
  assert.equal(uninterrupted(actor, { ...a, visibility: "self_and_gm" }), true);
  assert.equal(uninterrupted(otherActor, a), true);
  policy.assert(otherActor, "READ_PRIVATE_SEGMENT", a);
  assert.deepEqual(
    readNote(app, policy, otherActor, item.binding.targetNoteId),
    published,
  );
});
