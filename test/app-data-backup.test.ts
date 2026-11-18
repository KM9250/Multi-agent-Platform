import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../server/app-data/db.ts";
import { ConversationRepository } from "../server/app-data/repository.ts";
import {
  AuthorizationPolicy,
  PUBLIC_USER_OPERATIONS,
} from "../server/auth/authorization.ts";
import { SessionService } from "../server/auth/sessions.ts";
import { AttachmentStore } from "../server/attachments/store.ts";
import {
  BackupService,
  restoreBackup,
  resumeRestore,
} from "../server/operations/backup.ts";
import {
  acquireHostLock,
  assertOperationalRoot,
} from "../server/operations/locks.ts";
import { ExportService } from "../server/operations/export.ts";

function fixture() {
  const parent = mkdtempSync(join(tmpdir(), "map-backup-")),
    root = join(parent, "live"),
    app = new AppDatabase({ root });
  app.db.exec(
    "INSERT INTO workspaces VALUES('w',1);INSERT INTO principals VALUES('a','w',1);INSERT INTO auth_accounts VALUES('a','synthetic','OLD_PASSWORD_HASH',1,1)",
  );
  const actor = { actorId: "a", workspaceId: "w" },
    policy = new AuthorizationPolicy(app);
  for (const operation of PUBLIC_USER_OPERATIONS)
    policy.grant("a", "w", operation);
  const repo = new ConversationRepository(app, policy),
    attachments = new AttachmentStore(app, policy),
    room = repo.createRoom(actor, { title: "Backup synthetic" }),
    persona = repo.createPersona(actor, room.id, {
      name: "Persona",
      model: "synthetic",
    });
  return {
    parent,
    root,
    app,
    actor,
    policy,
    repo,
    attachments,
    room,
    persona,
    backup: join(parent, "backup"),
    restored: join(parent, "restored"),
    close() {
      app.close();
      rmSync(parent, { recursive: true, force: true });
    },
  };
}

test("C1-09/C1-10 backup and verified separate-root restore preserve bytes/revisions/deletions and invalidate sessions/credentials", async () => {
  const f = fixture();
  let restored: AppDatabase | undefined;
  try {
    const attachment = await f.attachments.upload(f.actor, f.room.id, {
      name: "synthetic.txt",
      mimeType: "text/plain",
      data: Buffer.from("RESTORE_ATTACHMENT_CANARY"),
    });
    const original = f.repo.appendMessage(f.actor, f.room.id, {
      role: "user",
      content: "original",
      occurredAt: 100,
      attachmentIds: [attachment.id],
    });
    f.repo.correctMessage(f.actor, f.room.id, original.id, {
      expectedRevision: 1,
      content: "revision",
    });
    const deleted = f.repo.appendMessage(f.actor, f.room.id, {
      role: "user",
      content: "DELETED_RESTORE_CANARY",
    });
    f.repo.deleteMessage(f.actor, f.room.id, deleted.id, {
      expectedRevision: 1,
    });
    f.app.db
      .prepare("INSERT INTO auth_sessions VALUES(?,?,?,?,?,?,?,NULL)")
      .run("oldsession", "a", "oldcsrf", 1, 1, Date.now() + 99999, Date.now());
    const manifest = await new BackupService(f.app).backup(f.backup);
    assert.equal(manifest.integrity, "ok");
    assert.equal(manifest.restoreTested, false);
    assert.equal(manifest.attachments.length, 1);
    const sourceBytes = readFileSync(join(f.backup, "app-data.sqlite"));
    await restoreBackup(f.backup, f.restored);
    assert.deepEqual(
      readFileSync(join(f.backup, "app-data.sqlite")),
      sourceBytes,
    );
    assert.throws(
      () => assertOperationalRoot(f.restored),
      /RESTORE_RESUME_REQUIRED/,
    );
    restored = new AppDatabase({ root: f.restored });
    const policy = new AuthorizationPolicy(restored),
      repo = new ConversationRepository(restored, policy),
      attachments = new AttachmentStore(restored, policy);
    assert.equal(
      restored.db.prepare("SELECT count(*) n FROM auth_sessions").get()!.n,
      0,
    );
    assert.equal(
      restored.db.prepare("SELECT password_hash FROM auth_accounts").get()!
        .password_hash,
      "RESTORE_RESET_REQUIRED",
    );
    assert.equal(
      restored.db
        .prepare("SELECT maintenance FROM app_operational_state")
        .get()!.maintenance,
      1,
    );
    assert.deepEqual(
      repo.history(f.actor, f.room.id, original.id).map((m) => m.content),
      ["revision", "original"],
    );
    assert.throws(
      () => repo.getMessage(f.actor, f.room.id, deleted.id),
      /NOT_FOUND/,
    );
    assert.equal(
      (
        await attachments.read(f.actor, f.room.id, attachment.id)
      ).data.toString(),
      "RESTORE_ATTACHMENT_CANARY",
    );
    assert.ok(
      !JSON.stringify(
        await new ExportService(restored, repo, attachments, policy).exportRoom(
          f.actor,
          f.room.id,
        ),
      ).includes("DELETED_RESTORE_CANARY"),
    );
    await assert.rejects(
      resumeRestore(f.restored),
      /RESTORE_CREDENTIAL_RESET_REQUIRED/,
    );
    await new SessionService(restored).resetPassword(
      "a",
      "synthetic-reset-password-2026",
    );
    restored.close();
    restored = undefined;
    await resumeRestore(f.restored);
    assertOperationalRoot(f.restored);
    restored = new AppDatabase({ root: f.restored });
    assert.equal(
      restored.db
        .prepare("SELECT maintenance FROM app_operational_state")
        .get()!.maintenance,
      0,
    );
    assert.equal(
      restored.db.prepare("SELECT count(*) n FROM app_provider_calls").get()!.n,
      0,
    );
    const session = await new SessionService(restored).login(
      "synthetic",
      "synthetic-reset-password-2026",
    );
    assert.equal(session.actor.actorId, "a");
  } finally {
    restored?.close();
    f.close();
  }
});

test("C1-10 restored queued run and reserved call remain diagnostic and never dispatch", async () => {
  const f = fixture();
  try {
    const { GenerationCoordinator } = await import(
        "../server/generation/coordinator.ts"
      ),
      { FakeProvider } = await import("../server/generation/provider.ts");
    const provider = new FakeProvider(),
      generation = new GenerationCoordinator(f.app, f.repo, f.policy, {
        provider,
        defaultModel: "synthetic",
      });
    const receipt = generation.accept(f.actor, f.room.id, {
      requestId: "queued",
      content: "synthetic restore input",
      expectedRoomRevision: 1,
      recipient: { type: "all" },
    });
    await new BackupService(f.app).backup(f.backup);
    await restoreBackup(f.backup, f.restored);
    const restored = new AppDatabase({ root: f.restored });
    try {
      const row = restored.db
        .prepare(
          "SELECT state,error_code FROM app_generation_runs WHERE run_id=?",
        )
        .get(receipt.runId)!;
      assert.equal(row.state, "NEEDS_REVIEW");
      assert.equal(row.error_code, "RESTORED_NO_REPLAY");
      assert.equal(provider.calls.length, 0);
    } finally {
      restored.close();
    }
  } finally {
    f.close();
  }
});

test("Backup refuses live host, destination overlap and nonempty destination without stopping host", async () => {
  const f = fixture();
  try {
    const release = acquireHostLock(f.root);
    try {
      await assert.rejects(
        new BackupService(f.app).backup(f.backup),
        /HOST_IN_USE_OR_STALE_LOCK/,
      );
    } finally {
      release();
    }
    assert.equal(existsSync(f.backup), false);
    await assert.rejects(
      new BackupService(f.app).backup(join(f.root, "backups", "unsafe")),
      /BACKUP_DESTINATION_OVERLAP/,
    );
    writeFileSync(join(f.parent, "occupied"), "do not remove");
    await assert.rejects(restoreBackup(f.parent, f.root));
    assert.equal(
      readFileSync(join(f.parent, "occupied"), "utf8"),
      "do not remove",
    );
    assert.equal(
      f.app.db.prepare("SELECT maintenance FROM app_operational_state").get()!
        .maintenance,
      0,
    );
  } finally {
    f.close();
  }
});

test("Backup detects preexisting semantic corruption and releases maintenance without blessing a manifest", async () => {
  const f = fixture();
  try {
    const message = f.repo.appendMessage(f.actor, f.room.id, {
      role: "user",
      content: "valid",
    });
    f.app.db
      .prepare("UPDATE message_segments SET content=? WHERE message_id=?")
      .run("corrupted", message.id);
    await assert.rejects(
      new BackupService(f.app).backup(f.backup),
      /BACKUP_CONTENT_DIGEST_MISMATCH/,
    );
    assert.equal(existsSync(join(f.backup, "manifest.json")), false);
    assert.equal(
      f.app.db.prepare("SELECT maintenance FROM app_operational_state").get()!
        .maintenance,
      0,
    );
    assert.equal(existsSync(join(f.root, ".server.lock")), false);
  } finally {
    f.close();
  }
});

test("Restore rejects changed attachment bytes and symlinked originals before destination publication", async () => {
  const f = fixture();
  try {
    await f.attachments.upload(f.actor, f.room.id, {
      name: "bytes.txt",
      mimeType: "text/plain",
      data: Buffer.from("original bytes"),
    });
    const manifest = await new BackupService(f.app).backup(f.backup),
      file = join(f.backup, "attachments", manifest.attachments[0].blobKey);
    writeFileSync(file, "changed bytes");
    await assert.rejects(
      restoreBackup(f.backup, f.restored),
      /BACKUP_ATTACHMENT_MISMATCH/,
    );
    assert.equal(existsSync(f.restored), false);
    rmSync(file);
    symlinkSync(join(f.root, "app-data.sqlite"), file);
    await assert.rejects(restoreBackup(f.backup, f.restored), /UNSAFE_PATH/);
    assert.equal(existsSync(f.restored), false);
  } finally {
    f.close();
  }
});

test("Restore destination may not overwrite an existing store and resume rejects altered reports", async () => {
  const f = fixture();
  try {
    await new BackupService(f.app).backup(f.backup);
    await assert.rejects(
      restoreBackup(f.backup, f.root),
      /DESTINATION_NOT_EMPTY/,
    );
    await restoreBackup(f.backup, f.restored);
    const report = join(f.restored, "restore-report.json");
    rmSync(report);
    symlinkSync(join(f.backup, "manifest.json"), report);
    await assert.rejects(resumeRestore(f.restored), /UNSAFE_PATH/);
    assert.throws(
      () => assertOperationalRoot(f.restored),
      /RESTORE_RESUME_REQUIRED/,
    );
  } finally {
    f.close();
  }
});
