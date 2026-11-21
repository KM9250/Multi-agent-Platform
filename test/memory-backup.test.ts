import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppDatabase } from "../server/app-data/db.ts";
import { APP_SCHEMA } from "../shared/app-contracts/index.ts";
import { digest } from "../server/app-data/validation.ts";
import { AttachmentStore } from "../server/attachments/store.ts";
import { AuthorizationPolicy } from "../server/auth/authorization.ts";
import { SessionService } from "../server/auth/sessions.ts";
import { MemoryCandidates } from "../server/memory/candidates.ts";
import {
  MEMORY_SETTLE_MS,
  scanVault,
  registerHandwrittenNote,
} from "../server/memory/importer.ts";
import { registerVault, setVaultPaused } from "../server/memory/vault.ts";
import { publishNext } from "../server/memory/worker.ts";
import {
  BackupService,
  restoreBackup,
  resumeRestore,
} from "../server/operations/backup.ts";
import { appFixture } from "./app-data-fixture.ts";

test("MEM-1 backup binds immutable note revisions, pending jobs, reviews and attachments to a detached, paused restore", async (t) => {
  const f = appFixture();
  t.after(() => f.dispose());
  const parent = mkdtempSync(join(tmpdir(), "map-mem-backup-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const vault = join(parent, "live-vault"),
    backup = join(parent, "backup"),
    destination = join(parent, "restored");
  registerVault(f.app, vault, { trustNew: true });
  setVaultPaused(f.app, false);
  f.app.db
    .prepare("INSERT INTO auth_accounts VALUES(?,?,?,1,1)")
    .run(f.actor.actorId, "host", "synthetic");
  const scope = {
    roomId: f.room.id,
    personaId: f.persona.id,
    visibility: "persona_private",
  };
  for (const op of [
    "READ_MEMORY",
    "PROPOSE_MEMORY",
    "REVIEW_MEMORY",
    "PUBLISH_MEMORY",
  ])
    f.policy.grant(f.actor.actorId, f.actor.workspaceId, op, scope);
  f.policy.grant(f.actor.actorId, f.actor.workspaceId, "READ_PRIVATE_SEGMENT", {
    ...scope,
    visibility: "self_only",
  });
  f.repository.updateRoom(f.actor, f.room.id, {
    expectedRevision: 1,
    internalStateSettings: { enabled: true },
  });
  const candidates = new MemoryCandidates(f.app, f.policy);
  async function approve(requestId: string) {
    const run = f.generation.accept(f.actor, f.room.id, {
      requestId,
      expectedRoomRevision: 2,
      content: "/memory",
      recipient: { type: "all" },
    });
    await f.generation.execute(run.runId);
    const row = f.app.db
      .prepare(
        "SELECT candidate_id FROM memory_candidates WHERE state='PENDING_REVIEW'",
      )
      .get();
    assert.ok(row);
    const candidate = candidates.get(
      f.actor,
      f.room.id,
      String(row.candidate_id),
    );
    candidates.review(f.actor, f.room.id, {
      requestId: requestId + "-review",
      decision: "approve",
      items: [candidate.binding],
    });
    return f.app.db
      .prepare("SELECT * FROM memory_jobs WHERE candidate_id=?")
      .get(row.candidate_id)!;
  }
  const first = await approve("first");
  assert.equal(publishNext(f.app, f.policy), true);
  const path = join(vault, String(first.relative_path));
  assert.equal(readFileSync(path, "utf8"), first.markdown);
  const edit = String(first.markdown) + "\nA verified external edit.";
  writeFileSync(path, edit);
  await scanVault(f.app);
  await new Promise((resolve) => setTimeout(resolve, MEMORY_SETTLE_MS + 50));
  await scanVault(f.app);
  assert.equal(
    f.app.db.prepare("SELECT version FROM memory_documents").get()!.version,
    2,
  );
  const second = await approve("second");
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [
          "--experimental-transform-types",
          "--loader",
          "./test/ts-loader.mjs",
          "test/memory-publication-child.ts",
          f.root,
          "afterPrepared",
        ],
        { stdio: "pipe" },
      ),
    (error: NodeJS.ErrnoException & { signal?: string }) =>
      error.signal === "SIGKILL",
  );
  assert.equal(
    f.app.db
      .prepare("SELECT status FROM memory_jobs WHERE operation_id=?")
      .get(second.operation_id)!.status,
    "PUBLISHING",
  );
  const third = await approve("third");
  const attachment = await new AttachmentStore(f.app, f.policy).upload(
    f.actor,
    f.room.id,
    {
      name: "proof.txt",
      mimeType: "text/plain",
      data: Buffer.from("synthetic attachment"),
    },
  );

  // Simulate an edit during the maintenance window; only committed versions
  // belong to this snapshot. Never copy the user's live file to build history.
  const liveOnly = edit + "\nAn edit not imported at snapshot time.";
  writeFileSync(path, liveOnly);
  const manifest = await new BackupService(f.app).backup(backup);
  assert.equal(manifest.appSchema, APP_SCHEMA);
  assert.equal(manifest.schema, "MAP-MEM-1:BACKUP:3");
  assert.equal(manifest.memory.versions.count, 2);
  assert.equal(manifest.memory.current.count, 1);
  assert.equal(manifest.attachments.count, 1);
  await assert.rejects(
    restoreBackup(backup, join(vault, "nested")),
    /BACKUP_DESTINATION_OVERLAP/,
  );
  await restoreBackup(backup, destination);
  assert.equal(readFileSync(path, "utf8"), liveOnly);
  const restored = new AppDatabase({ root: destination });
  t.after(() => restored.close());
  assert.equal(
    restored.db.prepare("SELECT attachment_id FROM attachments").get()!
      .attachment_id,
    attachment.id,
  );
  assert.notDeepEqual(restored.cursorKey, f.app.cursorKey);
  const restoredPolicy = new AuthorizationPolicy(restored);
  assert.equal(publishNext(restored, restoredPolicy), false);
  assert.equal(
    restored.db.prepare("SELECT paused FROM memory_vault").get()!.paused,
    1,
  );
  const restoredFile = join(
    destination,
    "restored-vault",
    String(first.relative_path),
  );
  assert.equal(readFileSync(restoredFile, "utf8"), edit);
  const history = [String(first.file_digest), digest(edit)].map((fileDigest) =>
    join(destination, "memory-versions", fileDigest + ".md"),
  );
  assert.equal(readFileSync(history[0], "utf8"), first.markdown);
  assert.notEqual(statSync(restoredFile).ino, statSync(history[1]).ino);
  const job = restored.db
    .prepare(
      "SELECT operation_id,markdown,status,error_code FROM memory_jobs WHERE operation_id=?",
    )
    .get(second.operation_id)!;
  assert.equal(job.status, "CONFLICT");
  assert.equal(job.error_code, "RESTORE_PUBLICATION_UNCERTAIN");
  assert.equal(job.markdown, second.markdown);
  assert.equal(job.operation_id, second.operation_id);
  assert.equal(
    restored.db.prepare("SELECT count(*) AS n FROM memory_reviews").get()!.n,
    3,
  );
  assert.equal(
    restored.db.prepare("SELECT count(*) AS n FROM memory_receipts").get()!.n,
    1,
  );
  await new SessionService(restored).resetPassword(
    f.actor.actorId,
    "synthetic-reset-password",
  );
  await resumeRestore(destination);
  assert.equal(publishNext(restored, restoredPolicy), false);
  setVaultPaused(restored, false);
  assert.equal(publishNext(restored, restoredPolicy), true);
  assert.equal(
    restored.db.prepare("SELECT count(*) AS n FROM memory_receipts").get()!.n,
    2,
  );
  assert.equal(
    readFileSync(
      join(destination, "restored-vault", String(third.relative_path)),
      "utf8",
    ),
    third.markdown,
  );
  assert.equal(
    existsSync(
      join(destination, "restored-vault", String(second.relative_path)),
    ),
    false,
  );
  assert.equal(existsSync(join(vault, String(second.relative_path))), false);
  assert.equal(f.provider.calls.length, 3);

  const next = join(parent, "tampered-restore");
  writeFileSync(
    join(backup, "memory-versions", String(first.file_digest) + ".md"),
    "altered historical bytes",
  );
  await assert.rejects(
    restoreBackup(backup, next),
    /BACKUP_MEMORY_DIGEST_MISMATCH/,
  );
  assert.equal(existsSync(next), false);
});

test("MEM-1 restores handwritten Markdown and its registration provenance without fabricating a message", async (t) => {
  const f = appFixture();
  t.after(() => f.dispose());
  const parent = mkdtempSync(join(tmpdir(), "map-mem-handwritten-backup-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const vault = join(parent, "vault"),
    backup = join(parent, "backup"),
    restored = join(parent, "restore");
  registerVault(f.app, vault);
  setVaultPaused(f.app, false);
  const scope = {
    roomId: f.room.id,
    personaId: f.persona.id,
    visibility: "persona_private",
  };
  f.policy.grant(f.actor.actorId, f.actor.workspaceId, "MANAGE_VAULT");
  for (const op of ["READ_MEMORY", "REVIEW_MEMORY", "PUBLISH_MEMORY"])
    f.policy.grant(f.actor.actorId, f.actor.workspaceId, op, scope);
  const noteId = "mem_hand",
    relativePath = "筆記.md";
  const markdown = "---\nmap_id: mem_hand\n---\n自分で記録した内容。";
  writeFileSync(join(vault, relativePath), markdown);
  const expectedDigest = digest(markdown);
  await registerHandwrittenNote(f.app, f.policy, f.actor, {
    roomId: f.room.id,
    personaId: f.persona.id,
    scope: "persona_private",
    noteId,
    relativePath,
    expectedDigest,
    requestId: "register-handwritten",
    trusted: true,
  });
  const provenance = f.app.db
    .prepare("SELECT * FROM memory_handwritten WHERE note_id=?")
    .get(noteId)!;
  assert.equal(provenance.registrar_id, f.actor.actorId);
  assert.equal(provenance.original_digest, expectedDigest);
  assert.ok(Number(provenance.registered_at) > 0);
  await new BackupService(f.app).backup(backup);
  await restoreBackup(backup, restored);
  const app = new AppDatabase({ root: restored });
  t.after(() => app.close());
  assert.deepEqual(
    app.db
      .prepare("SELECT * FROM memory_handwritten WHERE note_id=?")
      .get(noteId),
    provenance,
  );
  assert.equal(app.db.prepare("SELECT count(*) n FROM messages").get()!.n, 0);
  assert.equal(
    readFileSync(join(restored, "restored-vault", relativePath), "utf8"),
    markdown,
  );
  assert.equal(
    readFileSync(
      join(restored, "memory-versions", expectedDigest + ".md"),
      "utf8",
    ),
    markdown,
  );
});
