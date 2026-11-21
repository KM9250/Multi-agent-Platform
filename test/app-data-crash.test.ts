import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../server/app-data/db.ts";
import { AuthorizationPolicy } from "../server/auth/authorization.ts";
import { ConversationRepository } from "../server/app-data/repository.ts";
import { GenerationCoordinator } from "../server/generation/coordinator.ts";
import { FakeProvider } from "../server/generation/provider.ts";
import { appFixture } from "./app-data-fixture.ts";
import { AttachmentStore } from "../server/attachments/store.ts";

async function killAt(root: string, boundary: string, roomId = "", runId = "") {
  const child = spawn(
    process.execPath,
    [
      "--experimental-transform-types",
      "--loader",
      "./test/ts-loader.mjs",
      "test/app-data-crash-child.ts",
      root,
      boundary,
      roomId,
      runId,
    ],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "",
    errors = "";
  child.stderr.on("data", (d) => {
    errors += d.toString();
  });
  const exit = once(child, "exit");
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Boundary timeout ${boundary}: ${errors}`)),
        15000,
      );
      child.stdout.on("data", (d) => {
        output += d.toString();
        if (output.includes("BOUNDARY")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Early exit ${code}: ${errors}`));
      });
      child.on("error", reject);
    });
    child.kill("SIGKILL");
    const result = await exit;
    assert.equal(result[1], "SIGKILL");
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  }
}

for (const migration of [
  "migration",
  "app_002_memory_vault",
  "app_003_memory_integrity",
  "app_004_resumable_memory_lineage",
])
  for (const when of ["before", "after"])
    test(`C1-08: real SIGKILL ${when} ${migration} COMMIT recovers schema exactly once`, async (t) => {
      const root = mkdtempSync(join(tmpdir(), "map-migration-crash-"));
      chmodSync(root, 0o700);
      t.after(() => rmSync(root, { recursive: true, force: true }));
      await killAt(root, `${migration}:${when}`);
      if (migration !== "migration") {
        const beforeRestart = new DatabaseSync(join(root, "app-data.sqlite"), {
          readOnly: true,
        });
        try {
          const schema2 = migration === "app_002_memory_vault";
          // Migration 003 and 004 share a commit for a direct upgrade from schema 2.
          const expectedVersion = schema2
            ? when === "before"
              ? 1
              : 2
            : when === "before"
              ? 2
              : 4;
          assert.equal(
            beforeRestart
              .prepare("SELECT schema_version FROM app_metadata")
              .get()!.schema_version,
            expectedVersion,
          );
          assert.equal(
            beforeRestart
              .prepare("SELECT count(*) AS n FROM app_migrations")
              .get()!.n,
            expectedVersion,
          );
          assert.equal(
            beforeRestart
              .prepare(
                "SELECT count(*) AS n FROM sqlite_schema WHERE name='memory_candidates'",
              )
              .get()!.n,
            Number(expectedVersion >= 2),
          );
          assert.equal(
            beforeRestart
              .prepare(
                "SELECT count(*) AS n FROM sqlite_schema WHERE name='memory_receipt_source'",
              )
              .get()!.n,
            Number(expectedVersion >= 3),
          );
          assert.equal(
            beforeRestart
              .prepare(
                "SELECT count(*) AS n FROM sqlite_schema WHERE name='memory_lineage_work'",
              )
              .get()!.n,
            Number(expectedVersion >= 4),
          );
        } finally {
          beforeRestart.close();
        }
      }
      const app = new AppDatabase({ root });
      t.after(() => app.close());
      assert.deepEqual(
        app.db
          .prepare("SELECT name FROM app_migrations ORDER BY version")
          .all()
          .map((row) => row.name),
        [
          "app_001_conversation_persistence",
          "app_002_memory_vault",
          "app_003_memory_integrity",
          "app_004_resumable_memory_lineage",
        ],
      );
      assert.deepEqual(app.db.prepare("PRAGMA foreign_key_check").all(), []);
    });

for (const boundary of ["beforeAcceptCommit", "afterAcceptCommit"])
  test(`C1-01: SIGKILL ${boundary} converges same input request without execution`, async (t) => {
    const f = appFixture();
    t.after(() => f.dispose());
    f.app.close();
    await killAt(f.root, `generation:${boundary}`, f.room.id);
    const app = new AppDatabase({ root: f.root });
    t.after(() => app.close());
    const policy = new AuthorizationPolicy(app),
      repository = new ConversationRepository(app, policy),
      provider = new FakeProvider(),
      generation = new GenerationCoordinator(app, repository, policy, {
        provider,
        defaultModel: "synthetic",
      });
    const request = {
      requestId: "crash-request",
      expectedRoomRevision: 1,
      content: "Synthetic crash input",
      recipient: { type: "all" as const },
    };
    const receipt = generation.accept(f.actor, f.room.id, request),
      again = generation.accept(f.actor, f.room.id, request);
    assert.equal(receipt.runId, again.runId);
    assert.equal(
      repository.listMessages(f.actor, f.room.id).messages.length,
      1,
    );
    assert.equal(
      app.db.prepare("SELECT count(*) AS n FROM app_turns").get()!.n,
      1,
    );
    assert.equal(provider.calls.length, 0);
  });

for (const boundary of [
  "beforeIntentCommit",
  "afterIntentCommit",
  "providerSent",
  "afterProviderResponse",
  "beforeResultCommit",
  "afterResultCommit",
])
  test(`C1-02/G1: SIGKILL ${boundary} never recreates dispatch authority`, async (t) => {
    const f = appFixture();
    t.after(() => f.dispose());
    const receipt = f.generation.accept(f.actor, f.room.id, {
      requestId: "crash-run",
      expectedRoomRevision: 1,
      content: "Synthetic input",
      recipient: { type: "all" },
    });
    f.app.close();
    await killAt(f.root, `generation:${boundary}`, f.room.id, receipt.runId);
    const app = new AppDatabase({ root: f.root });
    t.after(() => app.close());
    const policy = new AuthorizationPolicy(app),
      repo = new ConversationRepository(app, policy),
      provider = new FakeProvider(),
      generation = new GenerationCoordinator(app, repo, policy, {
        provider,
        defaultModel: "synthetic",
      });
    generation.recoverInterrupted();
    await generation.execute(receipt.runId);
    const countFile = join(f.root, "synthetic-provider-count"),
      sent = existsSync(countFile)
        ? readFileSync(countFile, "utf8").trim().split("\n").length
        : 0;
    assert.equal(
      sent,
      ["beforeIntentCommit", "afterIntentCommit"].includes(boundary) ? 0 : 1,
    );
    assert.equal(provider.calls.length, 0);
    const saved = boundary === "afterResultCommit" ? 1 : 0;
    assert.equal(
      app.db.prepare("SELECT count(*) AS n FROM app_generation_receipts").get()!
        .n,
      saved,
    );
    assert.equal(
      generation.get(f.actor, f.room.id, receipt.runId).results.length,
      saved,
    );
    assert.equal(
      repo.listMessages(f.actor, f.room.id).messages.length,
      1 + saved,
    );
    assert.deepEqual(app.db.prepare("PRAGMA foreign_key_check").all(), []);
  });

test("G1-11: two independent worker processes send the same accepted call once", async (t) => {
  const f = appFixture();
  t.after(() => f.dispose());
  const receipt = f.generation.accept(f.actor, f.room.id, {
    requestId: "race-run",
    expectedRoomRevision: 1,
    content: "Synthetic two-worker input",
    recipient: { type: "all" },
  });
  f.app.close();
  const work = () =>
    new Promise<void>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          "--experimental-transform-types",
          "--loader",
          "./test/ts-loader.mjs",
          "test/app-data-crash-child.ts",
          f.root,
          "race",
          f.room.id,
          receipt.runId,
        ],
        { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
      );
      let errors = "";
      child.stderr.on("data", (d) => {
        errors += d;
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Worker timeout"));
      }, 15000);
      child.on("error", reject);
      child.on("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(errors));
      });
    });
  await Promise.all([work(), work()]);
  assert.equal(
    readFileSync(join(f.root, "synthetic-provider-count"), "utf8")
      .trim()
      .split("\n").length,
    1,
  );
  const app = new AppDatabase({ root: f.root });
  t.after(() => app.close());
  assert.equal(
    app.db.prepare("SELECT count(*) AS n FROM app_generation_receipts").get()!
      .n,
    1,
  );
});

for (const boundary of ["afterStaging", "afterFileCommit"])
  test(`C1-03: SIGKILL attachment ${boundary} never exposes uncommitted file`, async (t) => {
    const f = appFixture();
    t.after(() => f.dispose());
    f.app.close();
    await killAt(f.root, `attachment:${boundary}`, f.room.id);
    const app = new AppDatabase({ root: f.root });
    t.after(() => app.close());
    const policy = new AuthorizationPolicy(app),
      attachments = new AttachmentStore(app, policy);
    assert.equal(
      app.db.prepare("SELECT count(*) AS n FROM attachments").get()!.n,
      0,
    );
    const pending = await attachments.collectOrphans();
    assert.equal(pending.staging.length, boundary === "afterStaging" ? 1 : 0);
    assert.equal(
      pending.orphans.length,
      boundary === "afterFileCommit" ? 1 : 0,
    );
    const saved = await attachments.upload(f.actor, f.room.id, {
      name: "synthetic.txt",
      mimeType: "text/plain",
      data: Buffer.from("valid retry"),
    });
    await attachments.collectOrphans(true);
    assert.equal(
      (await attachments.read(f.actor, f.room.id, saved.id)).data.toString(),
      "valid retry",
    );
    assert.deepEqual(await attachments.collectOrphans(), {
      staging: [],
      orphans: [],
    });
  });

for (const when of ["before", "after"])
  test(`C1-07: real SIGKILL ${when} transaction COMMIT preserves all-or-none business and audit`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "map-atomic-crash-"));
    chmodSync(root, 0o700);
    t.after(() => rmSync(root, { recursive: true, force: true }));
    new AppDatabase({ root }).close();
    await killAt(root, `atomic:${when}`);
    const app = new AppDatabase({ root });
    t.after(() => app.close());
    const expected = when === "after" ? 1 : 0;
    for (const table of ["workspaces", "principals", "app_audit_events"])
      assert.equal(
        app.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n,
        expected,
      );
    assert.deepEqual(app.db.prepare("PRAGMA foreign_key_check").all(), []);
  });
