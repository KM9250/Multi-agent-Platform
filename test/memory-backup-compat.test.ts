import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { AppDatabase } from "../server/app-data/db.ts";
import { SessionService } from "../server/auth/sessions.ts";
import { AuthorizationPolicy } from "../server/auth/authorization.ts";
import { publishNext } from "../server/memory/worker.ts";
import { setVaultPaused } from "../server/memory/vault.ts";
import { restoreBackup, resumeRestore } from "../server/operations/backup.ts";

const previous = "b98241429466f1ad6406288c1f0ad724bafe6115";

test("F-03/F-04: previous MEM-1 binary backups and paused restore reports stay readable, including an archive made after old resume", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "map-mem-old-backup-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const old = join(dir, "release");
  mkdirSync(old);
  execFileSync("tar", ["-xf", "-", "-C", old], {
    input: execFileSync(
      "git",
      [
        "archive",
        previous,
        "server",
        "shared",
        "services",
        "utils",
        "constants.ts",
        "types.ts",
        "package.json",
        "test/ts-loader.mjs",
        "test/app-data-fixture.ts",
        "test/memory-publication-child.ts",
      ],
      { maxBuffer: 32 * 1024 * 1024 },
    ),
  });
  symlinkSync(resolve("node_modules"), join(old, "node_modules"), "dir");
  const original = join(dir, "original-backup"),
    stopped = join(dir, "old-stopped"),
    secondGeneration = join(dir, "old-second-backup");
  const fixture = "test/memory-backup-legacy-fixture.mjs";
  copyFileSync(resolve(fixture), join(old, fixture));
  const output = execFileSync(
    process.execPath,
    [
      "--experimental-transform-types",
      "--loader",
      "./test/ts-loader.mjs",
      "test/memory-backup-legacy-fixture.mjs",
      dir,
    ],
    {
      cwd: old,
      env: { ...process.env, TMPDIR: dir },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const { actor, markdown } = JSON.parse(output);
  for (const [archive, root] of [
    [original, join(dir, "v3-first")],
    [secondGeneration, join(dir, "v3-second")],
    [null, stopped],
  ] as const) {
    if (archive) await restoreBackup(archive, root);
    const app = new AppDatabase({ root });
    try {
      assert.equal(
        app.db.prepare("SELECT schema_version FROM app_metadata").get()!
          .schema_version,
        5,
      );
      assert.deepEqual(
        app.db
          .prepare("SELECT status FROM memory_jobs ORDER BY operation_id")
          .all()
          .map((r) => r.status),
        ["CONFLICT", "CONFLICT"],
      );
      assert.equal(
        app.db.prepare("SELECT count(*) n FROM memory_receipts").get()!.n,
        0,
      );
      assert.equal(
        app.db.prepare("SELECT count(*) n FROM memory_reviews").get()!.n,
        2,
      );
      assert.equal(
        readFileSync(join(root, "restored-vault", "original.md"), "utf8"),
        markdown,
      );
      const policy = new AuthorizationPolicy(app);
      assert.equal(publishNext(app, policy), false);
      await new SessionService(app).resetPassword(
        actor,
        "synthetic-new-reset-password",
      );
      await resumeRestore(root);
      assert.equal(
        app.db.prepare("SELECT paused FROM memory_vault").get()!.paused,
        1,
      );
      setVaultPaused(app, false);
      assert.equal(publishNext(app, policy), false);
      assert.equal(
        app.db.prepare("SELECT count(*) n FROM memory_receipts").get()!.n,
        0,
      );
    } finally {
      app.close();
    }
  }
});
