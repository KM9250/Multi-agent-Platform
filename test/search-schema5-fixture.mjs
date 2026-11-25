// Run only inside the archived PR #40 checkout to produce its actual schema, cursors and backup.
import assert from "node:assert/strict";
import { lineageFixture } from "./memory-lineage-fixture.ts";
import { runCli } from "../server/cli.ts";
import { identifyAppSchema } from "../server/app-data/db.ts";
import { acquireActiveIndex } from "../server/search/index.ts";
import { configureSearchProfile } from "../server/search/profile.ts";

const f = lineageFixture();
try {
  assert.equal(identifyAppSchema(f.app.db), 5);
  f.app.db
    .prepare(
      "INSERT INTO auth_accounts VALUES(?, 'schema-five', 'synthetic', 1, 1)",
    )
    .run(f.actor.actorId);
  f.original();
  const note = await f.memory();
  f.publish(note.candidate.id);
  configureSearchProfile(f.app, f.actor, f.room.id, {
    personaId: f.persona.id,
    scopes: ["persona_private"],
    purposes: ["DOCUMENT_EMBEDDING"],
    maxCalls: 1,
    maxTokens: 8192,
    maxCostMicros: 1000,
    priceMicrosPerThousandTokens: 100,
  });
  process.env.MAP_TEST_SEARCH_APP_PATH = f.app.path;
  const scope = [
    "--root",
    f.root,
    "--workspace",
    f.actor.workspaceId,
    "--actor",
    f.actor.actorId,
    "--room",
    f.room.id,
  ];
  await runCli(["search-sync", ...scope]);
  const active = acquireActiveIndex(f.app, f.policy, f.actor, f.room.id);
  assert.equal(active.state, "ACTIVE");
  assert.equal(active.manifest.dense.indexed, 1);
  const receipt = f.app.db.prepare("SELECT * FROM search_operations").get();
  assert.equal(receipt.state, "SUCCEEDED");
  const manifest = await runCli([
    "backup",
    "--root",
    f.root,
    "--destination",
    process.argv[2],
  ]);
  assert.equal(manifest.appSchema, 5);
  console.log(
    JSON.stringify({
      root: f.root,
      actor: f.actor,
      room: f.room.id,
      key: f.app.cursorKey.toString("hex"),
      generation: active.generationId,
      positions: active.manifest.positions,
      receipt,
    }),
  );
} finally {
  // The parent opens these temporary files using the current program and owns their cleanup.
  f.app.close();
}
