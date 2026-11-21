import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { AppDatabase } from "../server/app-data/db.ts";
import { ConversationRepository } from "../server/app-data/repository.ts";
import { AuthorizationPolicy } from "../server/auth/authorization.ts";
import { GenerationCoordinator } from "../server/generation/coordinator.ts";
import { FakeProvider } from "../server/generation/provider.ts";
import { advanceLineage } from "../server/memory/lineage.ts";
import { MemoryCandidates } from "../server/memory/candidates.ts";

test("PR39 F-07 schema 3 revocation with no exact grant evidence remains held across migration, regrant and new generation", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "map-old-revocation-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const old = join(dir, "audit");
  mkdirSync(old);
  const archive = execFileSync(
    "git",
    [
      "archive",
      "3370f59f60a4131676b5324a2ff4abdf714c65e3",
      "server",
      "shared",
      "services",
      "utils",
      "types.ts",
      "constants.ts",
      "package.json",
      "test/app-data-fixture.ts",
      "test/memory-lineage-fixture.ts",
      "test/ts-loader.mjs",
    ],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  execFileSync("tar", ["-xf", "-", "-C", old], { input: archive });
  symlinkSync(resolve("node_modules"), join(old, "node_modules"), "dir");
  const source = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--experimental-transform-types",
        "--loader",
        "./test/ts-loader.mjs",
        "--input-type=module",
        "-e",
        `
    import assert from "node:assert/strict";
    import {lineageFixture} from "./test/memory-lineage-fixture.ts";
    const f=lineageFixture();
    f.policy.grant(f.actor.actorId,f.actor.workspaceId,"MANAGE_VAULT");
    f.original(); await f.memory();
    const first=await f.memory();
    f.policy.revoke(f.actor.actorId,f.actor.workspaceId,"MANAGE_VAULT");
    const revokedAt=f.policy.revision(f.actor);
    f.policy.grant(f.actor.actorId,f.actor.workspaceId,"MANAGE_VAULT");
    const second=await f.memory();
    assert.ok(second.manifestInputs.includes(first.outputId));
    assert.equal(second.candidate.state,"NEEDS_REVIEW");
    console.log(JSON.stringify({root:f.root,actor:f.actor,room:f.room.id,revokedAt,
      secondId:second.candidate.id,output:second.outputId,version:f.app.db.prepare("SELECT schema_version FROM app_metadata").get().schema_version}));
    f.app.close();
  `,
      ],
      { cwd: old, env: { ...process.env, TMPDIR: dir }, encoding: "utf8" },
    ),
  );
  assert.equal(source.version, 3);
  const app = new AppDatabase({ root: source.root });
  t.after(() => app.close());
  const policy = new AuthorizationPolicy(app),
    repo = new ConversationRepository(app, policy);
  const candidates = new MemoryCandidates(app, policy),
    generation = new GenerationCoordinator(app, repo, policy, {
      provider: new FakeProvider(),
      defaultModel: "synthetic",
    });
  assert.equal(
    candidates.get(source.actor, source.room, source.secondId).state,
    "NEEDS_REVIEW",
  );
  // Wait for the real upgrade re-verification job to finish; an initial quarantine alone is insufficient.
  for (let step = 0; step < 16; step++) {
    const work = app.db
      .prepare("SELECT status FROM memory_lineage_work WHERE candidate_id=?")
      .get(source.secondId)!;
    if (work.status !== "PENDING") break;
    assert.equal(advanceLineage(app), true);
  }
  assert.equal(
    app.db
      .prepare("SELECT status FROM memory_lineage_work WHERE candidate_id=?")
      .get(source.secondId)!.status,
    "INVALID",
  );
  assert.equal(
    candidates.get(source.actor, source.room, source.secondId).state,
    "NEEDS_REVIEW",
  );
  const hasEvidence = app.db
    .prepare(
      "SELECT 1 FROM auth_revoked_grants WHERE workspace_id=? AND actor_id=? AND revision=?",
    )
    .get(source.actor.workspaceId, source.actor.actorId, source.revokedAt);
  assert.equal(
    hasEvidence,
    undefined,
    "migration cannot invent an exact historical grant",
  );
  const run = generation.accept(source.actor, source.room, {
    requestId: "post-migration",
    expectedRoomRevision: repo.getRoom(source.actor, source.room).revision,
    content: "/memory",
    recipient: { type: "all" },
  });
  await generation.execute(run.runId);
  assert.equal(
    generation.get(source.actor, source.room, run.runId).status,
    "COMPLETED",
  );
  const row = app.db
    .prepare(
      `SELECT c.candidate_id,p.manifest_json FROM memory_candidates c JOIN app_provider_calls p USING(call_id) WHERE p.run_id=?`,
    )
    .get(run.runId)!;
  assert.ok(
    JSON.parse(String(row.manifest_json)).messages.some(
      (m: { id: string }) => m.id === source.output,
    ),
  );
  const candidate = candidates.get(
    source.actor,
    source.room,
    String(row.candidate_id),
  );
  assert.equal(candidate.state, "NEEDS_REVIEW");
  for (const id of [source.secondId, candidate.id]) {
    const item = candidates.get(source.actor, source.room, id);
    assert.throws(() =>
      candidates.review(source.actor, source.room, {
        requestId: "legacy-" + id,
        decision: "approve",
        items: [item.binding],
      }),
    );
    assert.equal(
      app.db
        .prepare("SELECT COUNT(*) AS n FROM memory_jobs WHERE candidate_id=?")
        .get(id)!.n,
      0,
    );
  }
});
