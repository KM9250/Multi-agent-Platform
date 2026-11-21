import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  renameSync,
  readdirSync,
  symlinkSync,
  linkSync,
  mkdirSync,
  statSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appFixture } from "./app-data-fixture.ts";
import { MemoryCandidates } from "../server/memory/candidates.ts";
import {
  MAX_LIVE_NOTES,
  assertPublicationCapacity,
} from "../server/memory/limits.ts";
import { retractNote } from "../server/memory/notes.ts";
import { publishNext, retryPublication } from "../server/memory/worker.ts";
import {
  readVaultFile,
  readVersion,
  registerVault,
  setVaultPaused,
  assertVaultOutsideStatic,
} from "../server/memory/vault.ts";

const run = promisify(execFile);
const child = (root: string, boundary = "", participant = "") =>
  run(
    process.execPath,
    [
      "--experimental-transform-types",
      "--loader",
      "./test/ts-loader.mjs",
      "test/memory-publication-child.ts",
      root,
      boundary,
      participant,
    ],
    { timeout: 20000 },
  );
function dirs(t: TestContext) {
  const outer = mkdtempSync(join(tmpdir(), "map-mem-publication-"));
  t.after(() => rmSync(outer, { recursive: true, force: true }));
  return { outer, vault: join(outer, "vault") };
}
async function approved(
  t: TestContext,
  scope: "persona_private" | "room_shared" = "persona_private",
) {
  const f = appFixture();
  t.after(() => f.dispose());
  const { outer, vault } = dirs(t);
  registerVault(f.app, vault, { trustNew: true });
  setVaultPaused(f.app, false);
  for (const operation of [
    "READ_MEMORY",
    "PROPOSE_MEMORY",
    "EDIT_MEMORY",
    "REVIEW_MEMORY",
    "PUBLISH_MEMORY",
  ])
    f.policy.grant(f.actor.actorId, f.actor.workspaceId, operation, {
      roomId: f.room.id,
      personaId: f.persona.id,
      visibility: "persona_private",
    });
  f.policy.grant(f.actor.actorId, f.actor.workspaceId, "READ_PRIVATE_SEGMENT", {
    roomId: f.room.id,
    personaId: f.persona.id,
    visibility: "self_only",
  });
  f.repository.updateRoom(f.actor, f.room.id, {
    expectedRevision: 1,
    internalStateSettings: { enabled: true },
  });
  const accepted = f.generation.accept(f.actor, f.room.id, {
    requestId: "test-generate",
    expectedRoomRevision: 2,
    content: "/memory",
    recipient: { type: "all" },
  });
  await f.generation.execute(accepted.runId);
  const id = String(
    f.app.db.prepare("SELECT candidate_id FROM memory_candidates").get()
      ?.candidate_id,
  );
  const candidates = new MemoryCandidates(f.app, f.policy);
  let dto = candidates.get(f.actor, f.room.id, id);
  if (scope === "room_shared") {
    const destination = {
      roomId: f.room.id,
      personaId: f.persona.id,
      visibility: scope,
    };
    for (const operation of ["PUBLISH_MEMORY", "CHANGE_MEMORY_SCOPE"])
      f.policy.grant(
        f.actor.actorId,
        f.actor.workspaceId,
        operation,
        destination,
      );
    dto = candidates.edit(f.actor, f.room.id, id, {
      requestId: "test-share",
      expectedRevision: dto.revision,
      body: dto.body,
      kind: dto.kind,
      assertionType: dto.assertionType,
      scope,
    });
  }
  candidates.review(f.actor, f.room.id, {
    requestId: "test-review",
    decision: "approve",
    items: [dto.binding],
  });
  const job = f.app.db
    .prepare("SELECT relative_path,file_digest,markdown FROM memory_jobs")
    .get()!;
  return {
    ...f,
    outer,
    vault,
    file: join(vault, String(job.relative_path)),
    job,
  };
}

for (const boundary of [
  "afterSelection",
  "afterPrepared",
  "afterLink",
  "beforeReceipt",
])
  test(
    "MEM-1 SIGKILL " +
      boundary +
      " followed by concurrent publishers yields one note and receipt",
    async (t) => {
      const f = await approved(t);
      await assert.rejects(
        child(f.root, boundary),
        (e: any) => e.signal === "SIGKILL",
      );
      assert.equal(
        f.app.db.prepare("SELECT status FROM memory_jobs").get()?.status,
        boundary === "afterSelection" ? "PENDING" : "PUBLISHING",
      );
      await Promise.all([child(f.root, "", "one"), child(f.root, "", "two")]);
      assert.equal(
        f.app.db.prepare("SELECT status FROM memory_jobs").get()?.status,
        "PUBLISHED",
      );
      assert.deepEqual(
        readdirSync(f.vault).filter((p) => p.endsWith(".md")),
        [f.job.relative_path],
      );
      assert.equal(
        f.app.db.prepare("SELECT count(*) AS n FROM memory_receipts").get()?.n,
        1,
      );
      assert.equal(
        f.app.db.prepare("SELECT count(*) AS n FROM memory_versions").get()?.n,
        1,
      );
      assert.equal(
        f.app.db.prepare("SELECT count(*) AS n FROM app_provider_calls").get()
          ?.n,
        1,
      );
      assert.equal(readFileSync(f.file, "utf8"), f.job.markdown);
      const digest = String(f.job.file_digest);
      assert.notEqual(
        statSync(f.file).ino,
        statSync(join(f.root, "memory-versions", digest + ".md")).ino,
      );
      writeFileSync(f.file, "Synthetic external edit");
      assert.equal(readVersion(f.app, digest).toString("utf8"), f.job.markdown);
    },
  );

for (const situation of ["occupied", "edited", "renamed"] as const)
  test(
    "MEM-1 " +
      situation +
      " human note is preserved across publication/recovery",
    async (t) => {
      const f = await approved(t);
      let userFile = f.file;
      if (situation !== "occupied") {
        await assert.rejects(
          child(f.root, "beforeReceipt"),
          (e: any) => e.signal === "SIGKILL",
        );
        if (situation === "renamed") {
          userFile = join(f.vault, "renamed.md");
          renameSync(f.file, userFile);
        }
      }
      writeFileSync(userFile, "Human text");
      assert.equal(publishNext(f.app, f.policy), true);
      assert.equal(
        f.app.db.prepare("SELECT status FROM memory_jobs").get()?.status,
        "CONFLICT",
      );
      assert.equal(
        f.app.db.prepare("SELECT count(*) AS n FROM memory_receipts").get()?.n,
        0,
      );
      assert.equal(readFileSync(userFile, "utf8"), "Human text");
      assert.equal(
        readdirSync(f.vault).filter((p) => p.endsWith(".md")).length,
        1,
      );
      assert.equal(publishNext(f.app, f.policy), false);
    },
  );

test("MEM-1 inactive or revoked publication is not dispatched", async (t) => {
  const f = await approved(t);
  setVaultPaused(f.app, true);
  assert.equal(publishNext(f.app, f.policy), false);
  setVaultPaused(f.app, false);
  f.policy.revoke(f.actor.actorId, f.actor.workspaceId, "PUBLISH_MEMORY");
  publishNext(f.app, f.policy);
  assert.equal(existsSync(f.file), false);
  assert.equal(
    f.app.db.prepare("SELECT count(*) AS n FROM memory_receipts").get()?.n,
    0,
  );
  assert.equal(
    f.app.db.prepare("SELECT state FROM memory_candidates").get()?.state,
    "NEEDS_REVIEW",
  );
});

test("MEM-1 Vault registration and file reads enforce directory identity, size and link constraints", (t) => {
  const f = appFixture();
  t.after(() => f.dispose());
  const { outer, vault } = dirs(t);
  mkdirSync(vault, { mode: 0o700 });
  writeFileSync(join(vault, "existing.md"), "Personal");
  assert.throws(
    () => registerVault(f.app, vault),
    /DEDICATED_EMPTY_VAULT_REQUIRED/,
  );
  assert.throws(() => registerVault(f.app, vault, { staticRoot: outer }));
  assert.throws(() => registerVault(f.app, join(f.root, "attachments")));
  unlinkSync(join(vault, "existing.md"));
  registerVault(f.app, vault);
  assert.throws(() => assertVaultOutsideStatic(f.app, vault));
  const file = join(vault, "note.md");
  writeFileSync(file, "Good");
  assert.equal(readVaultFile(f.app, "note.md").toString(), "Good");
  symlinkSync(file, join(vault, "alias.md"));
  assert.throws(() => readVaultFile(f.app, "alias.md"));
  linkSync(file, join(outer, "other"));
  assert.throws(() => readVaultFile(f.app, "note.md"));
  unlinkSync(join(outer, "other"));
  symlinkSync(outer, join(vault, "outside"), "dir");
  assert.throws(() => readVaultFile(f.app, "outside/other.md"));
  assert.throws(() => readVaultFile(f.app, "../other.md"));
  writeFileSync(file, Buffer.alloc(256 * 1024 + 1));
  assert.throws(() => readVaultFile(f.app, "note.md"));
  renameSync(vault, join(outer, "old"));
  mkdirSync(vault, { mode: 0o700 });
  assert.throws(
    () => readVaultFile(f.app, "note.md"),
    /VAULT_IDENTITY_CHANGED/,
  );
});

for (const scope of ["persona_private", "room_shared"] as const)
  test(
    "MEM-1 retry preserves the reviewed operation and original grants for " +
      scope,
    async (t) => {
      const f = await approved(t, scope);
      const badDir = join(f.root, "memory-versions");
      writeFileSync(badDir, "blocked by synthetic fixture");
      publishNext(f.app, f.policy);
      const failed = f.app.db
        .prepare(
          "SELECT operation_id,candidate_id,status,markdown FROM memory_jobs",
        )
        .get()!;
      assert.equal(failed.status, "FAILED");
      unlinkSync(badDir);
      const retry = () =>
        retryPublication(
          f.app,
          f.policy,
          f.actor,
          f.room.id,
          String(failed.candidate_id),
          { requestId: "recover" },
        );
      assert.equal(retry().state, "PENDING");
      assert.equal(retry().state, "PENDING");
      assert.equal(publishNext(f.app, f.policy), true);
      assert.equal(retry().state, "PUBLISHED");
      assert.equal(publishNext(f.app, f.policy), false);
      const result = f.app.db
        .prepare("SELECT operation_id,file_digest FROM memory_receipts")
        .get()!;
      assert.equal(result.operation_id, failed.operation_id);
      assert.equal(result.file_digest, f.job.file_digest);
      assert.equal(readFileSync(f.file, "utf8"), failed.markdown);
      f.policy.revoke(f.actor.actorId, f.actor.workspaceId, "READ_ROOM");
      assert.throws(retry, /NOT_FOUND/);
    },
  );

test("MEM-1 a full Vault defers a new file; withdrawal frees a slot reserved until receipt", async (t) => {
  const f = await approved(t);
  const hash = "a".repeat(64);
  f.app.transaction(() => {
    // Each synthetic registered note has been removed from disk and can still be recovered or withdrawn.
    const fill = f.app.db.prepare(`INSERT INTO memory_documents
      (note_id,workspace_id,room_id,owner_persona_id,scope,state,relative_path,version,digest,body_digest,trusted)
      VALUES(?,?,?,?,'persona_private','DELETED',?,1,?,?,1)`);
    for (let n = 0; n < MAX_LIVE_NOTES; n++) {
      const id = "synthetic-slot-" + n;
      fill.run(
        id,
        f.actor.workspaceId,
        f.room.id,
        f.persona.id,
        id + ".md",
        hash,
        hash,
      );
    }
  });
  publishNext(f.app, f.policy);
  const job = f.app.db
    .prepare("SELECT candidate_id,status,error_code,prepared FROM memory_jobs")
    .get()!;
  assert.equal(job.status, "FAILED");
  assert.equal(job.error_code, "VAULT_NOTE_CAPACITY");
  assert.equal(job.prepared, 0);
  assert.deepEqual(readdirSync(f.vault), []);
  assert.equal(
    existsSync(join(f.root, "memory-versions", f.job.file_digest + ".md")),
    false,
  );
  const retry = () =>
    retryPublication(
      f.app,
      f.policy,
      f.actor,
      f.room.id,
      String(job.candidate_id),
      { requestId: "retry-capacity" },
    );
  assert.throws(retry, /VAULT_NOTE_CAPACITY/);
  f.policy.grant(f.actor.actorId, f.actor.workspaceId, "RETRACT_MEMORY", {
    roomId: f.room.id,
    personaId: f.persona.id,
    visibility: "persona_private",
  });
  retractNote(f.app, f.policy, f.actor, "synthetic-slot-0", {
    expectedVersion: 1,
    expectedDigest: hash,
    requestId: "withdraw-slot",
  });
  assert.equal(retry().state, "PENDING");
  publishNext(f.app, f.policy, {
    afterPrepared: () => {
      // A different registrar cannot consume the same slot between preparation and the file transaction.
      assert.throws(
        () => f.app.transaction(() => assertPublicationCapacity(f.app)),
        /VAULT_NOTE_CAPACITY/,
      );
    },
  });
  assert.equal(
    f.app.db.prepare("SELECT status FROM memory_jobs").get()?.status,
    "PUBLISHED",
  );
  assert.equal(readFileSync(f.file, "utf8"), f.job.markdown);
});
