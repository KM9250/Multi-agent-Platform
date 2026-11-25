import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
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
import { AppDatabase, identifyAppSchema } from "../server/app-data/db.ts";
import { restoreBackup, resumeRestore } from "../server/operations/backup.ts";
import { AuthorizationPolicy } from "../server/auth/authorization.ts";
import { SessionService } from "../server/auth/sessions.ts";
import { SearchSources } from "../server/search/sources.ts";
import { acquireActiveIndex } from "../server/search/index.ts";
import {
  APP_SCHEMA,
  MEMORY_CONTRACT,
  SEARCH_CONTRACT,
} from "../shared/app-contracts/index.ts";

const schema4Release = "cd1ffca5474902b7b90381e598f0741737e482f7";

function checkoutRelease(
  previous: string,
  commit: string,
  extraFiles: string[] = [],
) {
  mkdirSync(previous);
  const release = execFileSync(
    "git",
    [
      "archive",
      commit,
      "server",
      "services",
      "shared",
      "types.ts",
      "utils",
      "constants.ts",
      "package.json",
      "test/ts-loader.mjs",
      ...extraFiles,
    ],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  execFileSync("tar", ["-xf", "-", "-C", previous], { input: release });
  symlinkSync(resolve("node_modules"), join(previous, "node_modules"), "dir");
}

test("MEM-2 migration accepts a released schema 4 installation and backup, and applies once", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "map-search-migrate-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const previous = join(directory, "previous");
  const live = join(directory, "live");
  const backup = join(directory, "backup");
  const restore = join(directory, "restore");
  checkoutRelease(previous, schema4Release);
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
      import { AppDatabase, identifyAppSchema } from "./server/app-data/db.ts";
      import { BackupService } from "./server/operations/backup.ts";
      const app = new AppDatabase({root:process.argv[1]});
      assert.equal(identifyAppSchema(app.db),4);
      app.db.prepare("INSERT INTO workspaces VALUES('schema4',1)").run();
      const manifest=await new BackupService(app).backup(process.argv[2]);
      assert.equal(manifest.appSchema,4);
      app.close();`,
      live,
      backup,
    ],
    { cwd: previous },
  );

  const before = readFileSync(join(live, "app-data.sqlite"));
  assert.throws(
    () => new AppDatabase({ root: live, readOnly: true }),
    /WRONG_DATABASE/,
  );
  assert.deepEqual(readFileSync(join(live, "app-data.sqlite")), before);
  const saved = readFileSync(join(backup, "app-data.sqlite"));
  await restoreBackup(backup, restore);
  assert.deepEqual(readFileSync(join(backup, "app-data.sqlite")), saved);
  for (const root of [live, restore]) {
    for (let restart = 0; restart < 2; restart++) {
      const app = new AppDatabase({ root });
      try {
        assert.equal(identifyAppSchema(app.db), APP_SCHEMA);
        assert.equal(
          app.db
            .prepare("SELECT count(*) n FROM app_migrations WHERE version=5")
            .get()!.n,
          1,
        );
        assert.deepEqual(
          app.db
            .prepare(
              "SELECT contract FROM app_feature_contracts ORDER BY contract",
            )
            .all()
            .map((row) => row.contract),
          [MEMORY_CONTRACT, SEARCH_CONTRACT],
        );
        assert.equal(
          app.db.prepare("SELECT count(*) n FROM search_profiles").get()!.n,
          0,
        );
        assert.equal(
          app.db.prepare("SELECT count(*) n FROM search_operations").get()!.n,
          0,
        );
        assert.ok(
          app.db
            .prepare("SELECT 1 FROM workspaces WHERE workspace_id='schema4'")
            .get(),
        );
      } finally {
        app.close();
      }
    }
  }
});

test("F-03 schema 5 installation retains its active index, cursor and document receipt; its detached backup restores on schema 6", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "map-schema5-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const old = join(dir, "audited");
  const backup = join(dir, "backup");
  const restore = join(dir, "restore");
  const calls = join(dir, "calls.jsonl");
  checkoutRelease(old, "c154e404318d5033483d20da88e42e905af23af8", [
    "test/app-data-fixture.ts",
    "test/memory-lineage-fixture.ts",
  ]);
  const fixture = "test/search-schema5-fixture.mjs";
  copyFileSync(resolve(fixture), join(old, fixture));
  const source = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--experimental-transform-types",
        "--loader",
        "./test/ts-loader.mjs",
        "--import",
        resolve("test/search-cli-recovery-fetch.mjs"),
        fixture,
        backup,
      ],
      {
        cwd: old,
        encoding: "utf8",
        env: {
          TMPDIR: dir,
          NODE_NO_WARNINGS: "1",
          GEMINI_API_KEY: "synthetic-only",
          MAP_TEST_SEARCH_CALLS: calls,
        },
      },
    ),
  );
  assert.equal(readFileSync(calls, "utf8").trim().split("\n").length, 1);
  const oldBytes = readFileSync(join(backup, "app-data.sqlite"));
  const operations = (app: AppDatabase) =>
    app.db
      .prepare("SELECT * FROM search_operations")
      .all()
      .map((row) => ({ ...row }));
  const indexSql =
    "SELECT sql FROM sqlite_schema WHERE type='index' AND name='search_message_changes'";
  for (let reopen = 0; reopen < 2; reopen++) {
    const app = new AppDatabase({ root: source.root });
    try {
      assert.equal(identifyAppSchema(app.db), APP_SCHEMA);
      assert.equal(
        app.db
          .prepare("SELECT count(*) n FROM app_migrations WHERE version=6")
          .get()!.n,
        1,
      );
      assert.match(
        String(app.db.prepare(indexSql).get()!.sql),
        /WHERE target_type='MESSAGE'/,
      );
      assert.deepEqual(operations(app), [source.receipt]);
      assert.equal(app.cursorKey.toString("hex"), source.key);
      const policy = new AuthorizationPolicy(app);
      const active = acquireActiveIndex(app, policy, source.actor, source.room);
      assert.equal(active.state, "ACTIVE");
      assert.equal(active.generationId, source.generation);
      assert.deepEqual(active.manifest.positions, source.positions);
      const reader = new SearchSources(app, policy, source.actor, source.room);
      assert.equal(
        reader.hasUnindexedChanges("archive", source.positions.archive),
        false,
      );
      assert.equal(
        reader.hasUnindexedChanges("memory", source.positions.memory),
        false,
      );
      const index = new DatabaseSync(active.path, { readOnly: true });
      try {
        assert.equal(
          index
            .prepare(
              "SELECT count(*) n FROM search_vectors WHERE operation_id=? AND length(vector)=768*4",
            )
            .get(source.receipt.operation_id)!.n,
          1,
        );
      } finally {
        index.close();
      }
    } finally {
      app.close();
    }
  }
  assert.equal((await restoreBackup(backup, restore)).appSchema, 5);
  assert.deepEqual(readFileSync(join(backup, "app-data.sqlite")), oldBytes);
  const restored = new AppDatabase({ root: restore });
  try {
    assert.equal(identifyAppSchema(restored.db), APP_SCHEMA);
    assert.ok(restored.db.prepare(indexSql).get());
    assert.deepEqual(operations(restored), [source.receipt]);
    assert.equal(
      restored.db.prepare("SELECT active FROM search_profiles").get()!.active,
      0,
    );
    assert.notEqual(restored.cursorKey.toString("hex"), source.key);
    assert.equal(existsSync(join(restore, "search-index")), false);
    await new SessionService(restored).resetPassword(
      source.actor.actorId,
      "synthetic-reset-schema-five",
    );
    await resumeRestore(restore);
    assert.equal(
      restored.db.prepare("SELECT restored FROM app_operational_state").get()!
        .restored,
      0,
    );
  } finally {
    restored.close();
  }
});

test("search reader opens a query-only current snapshot and cannot bootstrap storage", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "map-search-readonly-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, "missing");
  assert.throws(
    () => new AppDatabase({ root, readOnly: true }),
    /WRONG_DATABASE/,
  );
  assert.equal(existsSync(root), false);
  const writer = new AppDatabase({ root });
  t.after(() => writer.close());
  const reader = new AppDatabase({ root, readOnly: true });
  t.after(() => reader.close());
  assert.deepEqual(reader.cursorKey, writer.cursorKey);
  assert.equal(reader.db.prepare("PRAGMA query_only").get()!.query_only, 1);
  assert.throws(
    () => reader.db.exec("DELETE FROM search_profiles"),
    /readonly/i,
  );
});
