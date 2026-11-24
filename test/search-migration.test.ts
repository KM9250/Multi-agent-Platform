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
import test from "node:test";
import { AppDatabase, identifyAppSchema } from "../server/app-data/db.ts";
import { restoreBackup } from "../server/operations/backup.ts";
import {
  MEMORY_CONTRACT,
  SEARCH_CONTRACT,
} from "../shared/app-contracts/index.ts";

const schema4Release = "cd1ffca5474902b7b90381e598f0741737e482f7";

test("MEM-2 migration accepts a released schema 4 installation and backup, and applies once", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "map-search-migrate-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const previous = join(directory, "previous");
  const live = join(directory, "live");
  const backup = join(directory, "backup");
  const restore = join(directory, "restore");
  mkdirSync(previous);
  const release = execFileSync(
    "git",
    [
      "archive",
      schema4Release,
      "server",
      "services",
      "shared",
      "types.ts",
      "utils",
      "constants.ts",
      "package.json",
      "test/ts-loader.mjs",
    ],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  execFileSync("tar", ["-xf", "-", "-C", previous], { input: release });
  symlinkSync(resolve("node_modules"), join(previous, "node_modules"), "dir");
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
        assert.equal(identifyAppSchema(app.db), 5);
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
