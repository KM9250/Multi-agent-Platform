import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { AppDatabase, identifyAppSchema } from "../server/app-data/db.ts";
import { APP_SCHEMA, CONTEXT_CONTRACT } from "../shared/app-contracts/index.ts";
import { BackupService, restoreBackup, resumeRestore } from "../server/operations/backup.ts";
import { SessionService } from "../server/auth/sessions.ts";

const release = "b21e6760f04ce42b2135619e8524188f887b5fc6";

test("MEM-3A released schema 6, old backup and paused restore preserve their receipts through schema 7", async (t) => {
  const temp = mkdtempSync(join(tmpdir(), "map-context-migration-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const old = join(temp, "release");
  mkdirSync(old);
  const archive = execFileSync("git", ["archive", release, "server", "shared", "services", "utils",
    "constants.ts", "types.ts", "package.json", "test/ts-loader.mjs", "test/app-data-fixture.ts",
    "test/memory-lineage-fixture.ts"], { maxBuffer: 32 * 1024 * 1024 });
  execFileSync("tar", ["-xf", "-", "-C", old], { input: archive });
  symlinkSync(resolve("node_modules"), join(old, "node_modules"), "dir");
  const backup = join(temp, "old-backup"), paused = join(temp, "old-paused");
  const source = JSON.parse(execFileSync(process.execPath,
    ["--experimental-transform-types", "--loader", "./test/ts-loader.mjs", "--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import {lineageFixture} from './test/memory-lineage-fixture.ts';
      import {BackupService,restoreBackup} from './server/operations/backup.ts';
      import {configureSearchProfile} from './server/search/profile.ts';
      import {identifyAppSchema} from './server/app-data/db.ts';
      const f=lineageFixture();
      try {
        assert.equal(identifyAppSchema(f.app.db),6);
        f.app.db.prepare("INSERT INTO auth_accounts VALUES(?,'migration-host','synthetic',1,1)").run(f.actor.actorId);
        f.original();
        const candidate=await f.memory();
        f.publish(candidate.candidate.id);
        configureSearchProfile(f.app,f.actor,f.room.id,{
          personaId:f.persona.id,scopes:['persona_private'],purposes:['QUERY_EMBEDDING'],
          maxCalls:1,maxTokens:8192,maxCostMicros:1000,priceMicrosPerThousandTokens:100
        });
        const receipt=f.app.db.prepare('SELECT * FROM app_provider_calls ORDER BY call_id').all();
        const profiles=f.app.db.prepare('SELECT * FROM search_profiles').all();
        const reviews=f.app.db.prepare('SELECT * FROM memory_reviews ORDER BY review_id').all();
        const manifest=await new BackupService(f.app).backup(process.argv[1]);
        assert.equal(manifest.appSchema,6);
        await restoreBackup(process.argv[1],process.argv[2]);
        console.log(JSON.stringify({root:f.root,actor:f.actor,receipt,profiles,reviews}));
      } finally {f.app.close();}
    `, backup, paused], {
      cwd: old, encoding: "utf8", env: { ...process.env, TMPDIR: temp, NODE_NO_WARNINGS: "1" },
    }));
  const rawRows = (db: DatabaseSync, query: string) => JSON.parse(JSON.stringify(db.prepare(query).all()));
  const oldBackupBytes = readFileSync(join(backup, "app-data.sqlite"));

  await t.test("read-only opening and failed migration leave the released catalogue intact", () => {
    const rollbackRoot = join(temp, "rollback");
    cpSync(source.root, rollbackRoot, { recursive: true });
    assert.throws(() => new AppDatabase({ root: rollbackRoot, readOnly: true }), /WRONG_DATABASE/);
    assert.throws(() => new AppDatabase({ root: rollbackRoot, hooks: {
      beforeCommit: (phase) => { if (phase === "app_007_answer_context") throw Error("synthetic rollback"); },
    } }), /synthetic rollback/);
    const db = new DatabaseSync(join(rollbackRoot, "app-data.sqlite"), { readOnly: true });
    try {
      assert.equal(identifyAppSchema(db), 6);
      assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='app_context_answer_holds'").get(), undefined);
      assert.deepEqual(rawRows(db, "SELECT * FROM app_provider_calls ORDER BY call_id"), source.receipt);
    } finally { db.close(); }
  });

  await t.test("upgrade applies once without rewriting old JSON, digests or approvals", () => {
    for (let reopen = 0; reopen < 2; reopen++) {
      const app = new AppDatabase({ root: source.root });
      try {
        assert.equal(identifyAppSchema(app.db), APP_SCHEMA);
        assert.equal(app.db.prepare("SELECT count(*) n FROM app_migrations WHERE version=7").get()!.n, 1);
        assert.ok(app.db.prepare("SELECT 1 FROM app_feature_contracts WHERE contract=?").get(CONTEXT_CONTRACT));
        assert.deepEqual(rawRows(app.db, "SELECT * FROM app_provider_calls ORDER BY call_id"), source.receipt);
        assert.deepEqual(rawRows(app.db, "SELECT * FROM search_profiles"), source.profiles);
        assert.deepEqual(rawRows(app.db, "SELECT * FROM memory_reviews ORDER BY review_id"), source.reviews);
        assert.equal(app.db.prepare("SELECT count(*) n FROM memory_documents WHERE state='PUBLISHED'").get()!.n, 1);
        assert.equal(app.db.prepare("SELECT count(*) n FROM memory_lineage_work WHERE notes_done<>0").get()!.n, 0);
      } finally { app.close(); }
    }
  });

  await t.test("an old paused report bridges its pre-migration memory ledger and resumes", async () => {
    const oldReport = readFileSync(join(paused, "restore-report.json"), "utf8");
    assert.equal(JSON.parse(oldReport).schema, "MAP-MEM-2:RESTORE:5");
    const app = new AppDatabase({ root: paused });
    try {
      const migration = app.db.prepare("SELECT * FROM app_restore_context_migration").get()!;
      assert.equal(migration.source_schema, 6);
      assert.notEqual(migration.before_digest, migration.after_digest);
      assert.equal(readFileSync(join(paused, "restore-report.json"), "utf8"), oldReport);
      await new SessionService(app).resetPassword(source.actor.actorId, "synthetic-context-reset");
      await resumeRestore(paused);
      assert.equal(app.db.prepare("SELECT restored FROM app_operational_state").get()!.restored, 0);
    } finally { app.close(); }
  });

  await t.test("old backup restores to schema 7 without changing its source bytes", async () => {
    const restored = join(temp, "new-restored");
    assert.equal((await restoreBackup(backup, restored)).appSchema, 6);
    assert.deepEqual(readFileSync(join(backup, "app-data.sqlite")), oldBackupBytes);
    const app = new AppDatabase({ root: restored });
    try {
      assert.equal(identifyAppSchema(app.db), 7);
      assert.deepEqual(rawRows(app.db, "SELECT * FROM app_provider_calls ORDER BY call_id"), source.receipt);
      assert.equal(JSON.parse(readFileSync(join(restored, "restore-report.json"), "utf8")).schema, "MAP-MEM-3:RESTORE:7");
      await new SessionService(app).resetPassword(source.actor.actorId, "synthetic-context-reset");
      await resumeRestore(restored);
    } finally { app.close(); }
  });
});
