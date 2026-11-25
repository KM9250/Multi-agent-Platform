import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { AppDatabase } from "../server/app-data/db.ts";
import { restoreBackup } from "../server/operations/backup.ts";
import { APP_SCHEMA, MEMORY_CONTRACT } from "../shared/app-contracts/index.ts";

// Use the released program both to produce the backup and attempt the downgrade.
// Recreating a schema-1 manifest with the new writer would miss wire incompatibilities.
const baseline = "2309d5e4b30f3eabb60ead959e16611b2ae50cfb";

test("DATA-1 program, populated v1 backup, and MEM-1 migration interoperate without expanding existing grants", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "map-mem-legacy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const old = join(dir, "data-1"),
    snapshot = join(dir, "old-backup");
  mkdirSync(old);
  const archive = execFileSync(
    "git",
    [
      "archive",
      baseline,
      "server",
      "shared",
      "services",
      "utils",
      "constants.ts",
      "types.ts",
      "package.json",
      "test/app-data-fixture.ts",
      "test/ts-loader.mjs",
    ],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  execFileSync("tar", ["-xf", "-", "-C", old], { input: archive });

  symlinkSync(resolve("node_modules"), join(old, "node_modules"), "dir");
  const runOld = (script: string, ...args: string[]) =>
    execFileSync(
      process.execPath,
      [
        "--experimental-transform-types",
        "--loader",
        "./test/ts-loader.mjs",
        "--input-type=module",
        "-e",
        script,
        ...args,
      ],
      { cwd: old, env: { ...process.env, TMPDIR: dir }, encoding: "utf8" },
    );
  const source = JSON.parse(
    runOld(
      `
    import { appFixture } from "./test/app-data-fixture.ts";
    import { BackupService } from "./server/operations/backup.ts";
    import { AttachmentStore } from "./server/attachments/store.ts";
    const f = appFixture();
    f.app.db.prepare("INSERT INTO auth_accounts VALUES(?,?,?,1,1)").run(f.actor.actorId, "legacy-host", "synthetic");
    const store = new AttachmentStore(f.app, f.policy);
    const receipt = f.generation.accept(f.actor,f.room.id,{requestId:"migrate",expectedRoomRevision:f.room.revision,content:"old turn",recipient:{type:"all"}});
    await f.generation.execute(receipt.runId);
    const attachment = await store.upload(f.actor, f.room.id, {name:"old.txt",mimeType:"text/plain",data:Buffer.from("old attachment")});
    f.repository.appendMessage(f.actor, f.room.id, {role:"user",content:"old conversation",attachmentIds:[attachment.id]});
    const manifest = await new BackupService(f.app).backup(process.argv[1]);
    const operations = f.app.db.prepare("SELECT operation FROM access_grants ORDER BY operation").all();
    console.log(JSON.stringify({root:f.root,operations,manifest,blob:manifest.attachments[0].blobKey}));
    f.app.close();
  `,
      snapshot,
    ),
  );
  assert.equal(source.manifest.appSchema, 1);
  const oldBytes = readFileSync(join(snapshot, "app-data.sqlite"));
  const sourcePath = join(source.root, "app-data.sqlite");
  const restored = join(dir, "new-root");
  await restoreBackup(snapshot, restored);
  assert.deepEqual(readFileSync(join(snapshot, "app-data.sqlite")), oldBytes);

  for (const root of [source.root, restored]) {
    const app = new AppDatabase({ root });
    try {
      assert.equal(
        app.db.prepare("SELECT schema_version FROM app_metadata").get()!
          .schema_version,
        APP_SCHEMA,
      );
      assert.equal(
        app.db.prepare("SELECT contract FROM app_feature_contracts").get()!
          .contract,
        MEMORY_CONTRACT,
      );
      assert.deepEqual(
        app.db
          .prepare("SELECT operation FROM access_grants ORDER BY operation")
          .all()
          .map((r) => r.operation),
        source.operations.map((r: { operation: string }) => r.operation),
      );
      assert.equal(
        app.db
          .prepare(
            "SELECT count(*) AS n FROM message_segments WHERE content='old conversation'",
          )
          .get()!.n,
        1,
      );
      assert.ok(
        Number(
          app.db
            .prepare("SELECT count(*) AS n FROM app_generation_receipts")
            .get()!.n,
        ) > 0,
      );
      assert.equal(
        readFileSync(join(root, "attachments", source.blob), "utf8"),
        "old attachment",
      );
      assert.equal(
        app.db.prepare("SELECT count(*) AS n FROM memory_candidates").get()!.n,
        0,
      );
    } finally {
      app.close();
    }
  }
  const afterMigration = readFileSync(sourcePath);
  assert.equal(
    runOld(
      `
    import { AppDatabase } from "./server/app-data/db.ts";
    try { new AppDatabase({root:process.argv[1]}); } catch (e) { console.log(e.code); }
  `,
      source.root,
    ).trim(),
    "WRONG_DATABASE",
  );
  const rollbackRoot = join(dir, "rollback");
  const rollback = runOld(
    `
    import { AppDatabase } from "./server/app-data/db.ts";
    import { SessionService } from "./server/auth/sessions.ts";
    import { restoreBackup, resumeRestore } from "./server/operations/backup.ts";
    const root = process.argv[2];
    await restoreBackup(process.argv[1], root);
    const app = new AppDatabase({root});
    await new SessionService(app).resetPassword("synthetic-actor", "synthetic-rollback-password-2026");
    app.close();
    await resumeRestore(root);
    const ready = new AppDatabase({root});
    console.log(JSON.stringify(ready.db.prepare("SELECT schema_version,maintenance FROM app_metadata CROSS JOIN app_operational_state").get()));
    ready.close();
  `,
    snapshot,
    rollbackRoot,
  );
  assert.deepEqual(JSON.parse(rollback), { schema_version: 1, maintenance: 0 });
  assert.deepEqual(readFileSync(join(snapshot, "app-data.sqlite")), oldBytes);
  assert.deepEqual(readFileSync(sourcePath), afterMigration);
});

for (const mutation of [
  `UPDATE app_metadata SET schema_version=${APP_SCHEMA + 1}`,
  "DELETE FROM app_migrations WHERE version=2",
  "DELETE FROM app_migrations WHERE version=3",
  "DELETE FROM app_migrations WHERE version=4",
  "DELETE FROM app_migrations WHERE version=5",
  "DELETE FROM app_feature_contracts WHERE contract='MAP-MEM-2:SEARCH:1'",
  "DROP TABLE search_operations",
  "DELETE FROM app_migrations WHERE version=6",
  "DROP INDEX search_message_changes",
  "DROP INDEX search_persona_deletions",
  "DROP INDEX memory_receipt_source",
  "DELETE FROM app_feature_contracts",
  "CREATE TABLE foreign_data(x)",
])
  test(
    "refuses unrecognized schema before modifying storage: " + mutation,
    (t) => {
      const root = mkdtempSync(join(tmpdir(), "map-mem-mismatch-"));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const app = new AppDatabase({ root });
      const path = app.path;
      app.close();
      const raw = new DatabaseSync(path);
      raw.exec(mutation);
      raw.close();
      const before = readFileSync(path);
      assert.throws(() => new AppDatabase({ root }), /WRONG_DATABASE/);
      assert.deepEqual(readFileSync(path), before);
      assert.equal(existsSync(join(root, "memory-versions")), false);
    },
  );
