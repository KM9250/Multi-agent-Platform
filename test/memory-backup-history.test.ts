import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppDatabase } from "../server/app-data/db.ts";
import { digest } from "../server/app-data/validation.ts";
import { SessionService } from "../server/auth/sessions.ts";
import { AuthorizationPolicy } from "../server/auth/authorization.ts";
import { registerHandwrittenNote } from "../server/memory/importer.ts";
import { readNote } from "../server/memory/notes.ts";
import {
  registerVault,
  saveVersion,
  setVaultPaused,
} from "../server/memory/vault.ts";
import {
  BackupService,
  restoreBackup,
  resumeRestore,
} from "../server/operations/backup.ts";
import { assertOperationalRoot } from "../server/operations/locks.ts";
import { appFixture } from "./app-data-fixture.ts";

test("F-04: 85,001 committed revisions round-trip in a bounded header with every identity preserved", async (t) => {
  const f = appFixture();
  t.after(() => f.dispose());
  const dir = mkdtempSync(join(tmpdir(), "map-history-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const vault = join(dir, "vault"),
    backup = join(dir, "backup"),
    destination = join(dir, "restored");
  const noteId = "mem_large_62c377e1d6b642ac85c9918520eba57e",
    path = "history.md",
    total = 85001;
  registerVault(f.app, vault);
  setVaultPaused(f.app, false);
  f.app.db
    .prepare("INSERT INTO auth_accounts VALUES(?,?,?,1,1)")
    .run(f.actor.actorId, "history", "synthetic");
  f.policy.grant(f.actor.actorId, f.actor.workspaceId, "MANAGE_VAULT");
  const scope = {
    roomId: f.room.id,
    personaId: f.persona.id,
    visibility: "persona_private",
  };
  for (const op of ["READ_MEMORY", "REVIEW_MEMORY", "PUBLISH_MEMORY"])
    f.policy.grant(f.actor.actorId, f.actor.workspaceId, op, scope);

  // Valid content-addressed repeats model a note whose text is repeatedly restored
  // to previous versions. Every logical revision is checked independently.
  const records = [0, 1, 2].map((i) => {
    const body = "Synthetic history version " + i,
      markdown = "---\nmap_id: " + noteId + "\n---\n" + body;
    return {
      body,
      markdown,
      digest: saveVersion(f.app, Buffer.from(markdown)),
      bodyDigest: digest(body),
    };
  });
  const revision = (v: number) => records[(v - 1) % records.length];
  writeFileSync(join(vault, path), revision(1).markdown);
  await registerHandwrittenNote(f.app, f.policy, f.actor, {
    roomId: f.room.id,
    personaId: f.persona.id,
    scope: "persona_private",
    noteId,
    relativePath: path,
    expectedDigest: revision(1).digest,
    requestId: "history-note",
    trusted: true,
  });
  let legacyBytes = 1;
  f.app.transaction(() => {
    const insert = f.app.db.prepare(
      "INSERT INTO memory_versions VALUES(?,?,?,?,?,?)",
    );
    for (let v = 1; v <= total; v++) {
      const { digest, bodyDigest } = revision(v);
      legacyBytes +=
        Buffer.byteLength(
          JSON.stringify({ noteId, revision: v, digest, bodyDigest }),
        ) + 1;
      if (v > 1) insert.run(noteId, v, digest, bodyDigest, path, v);
    }
    const last = revision(total);
    f.app.db
      .prepare(
        "UPDATE memory_documents SET version=?,digest=?,body_digest=? WHERE note_id=?",
      )
      .run(total, last.digest, last.bodyDigest, noteId);
  });
  writeFileSync(join(vault, path), revision(total).markdown);
  assert.ok(legacyBytes > 16 * 1024 * 1024);
  const manifest = await new BackupService(f.app).backup(backup);
  assert.equal(manifest.memory.versions.count, total);
  assert.equal(
    readdirSync(join(backup, "memory-versions")).length,
    records.length,
  );
  const headerBytes = statSync(join(backup, "manifest.json")).size;
  assert.ok(headerBytes < 4096);
  await restoreBackup(backup, destination);
  const restored = new AppDatabase({ root: destination });
  t.after(() => restored.close());
  assert.throws(
    () => assertOperationalRoot(destination),
    /RESTORE_RESUME_REQUIRED/,
  );
  assert.equal(
    restored.db.prepare("SELECT maintenance FROM app_operational_state").get()!
      .maintenance,
    1,
  );
  assert.equal(
    restored.db.prepare("SELECT paused FROM memory_vault").get()!.paused,
    1,
  );
  assert.equal(
    restored.db.prepare("SELECT count(*) AS n FROM app_provider_calls").get()!
      .n,
    0,
  );
  const policy = new AuthorizationPolicy(restored);
  assert.throws(
    () => readNote(restored, policy, f.actor, noteId, 1),
    /MAINTENANCE/,
  );
  await new SessionService(restored).resetPassword(
    f.actor.actorId,
    "synthetic-history-password",
  );
  await resumeRestore(destination);
  assert.equal(
    restored.db.prepare("SELECT paused FROM memory_vault").get()!.paused,
    1,
  );
  let v = 0;
  for (const row of restored.db
    .prepare(
      "SELECT note_id,version,digest,body_digest,relative_path FROM memory_versions ORDER BY note_id,version",
    )
    .iterate()) {
    const expected = revision(++v);
    assert.equal(row.note_id, noteId);
    assert.equal(row.version, v);
    assert.equal(row.digest, expected.digest);
    assert.equal(row.body_digest, expected.bodyDigest);
    assert.equal(row.relative_path, path);
  }
  assert.equal(v, total);
  for (const index of [1, Math.ceil(total / 2), total])
    assert.equal(
      readNote(restored, policy, f.actor, noteId, index).body,
      revision(index).body,
    );
  assert.equal(
    readFileSync(join(destination, "restored-vault", path), "utf8"),
    revision(total).markdown,
  );

  const file = join(backup, "memory-versions", revision(2).digest + ".md");
  unlinkSync(file);
  const refused = join(dir, "refused");
  await assert.rejects(restoreBackup(backup, refused), /ENOENT/);
  assert.equal(existsSync(refused), false);
  writeFileSync(file, "Synthetic tampered version");
  await assert.rejects(
    restoreBackup(backup, refused),
    /BACKUP_MEMORY_DIGEST_MISMATCH/,
  );
  assert.equal(existsSync(refused), false);
  t.diagnostic(
    `legacy inline version bytes=${legacyBytes}, v3 header bytes=${headerBytes}, checked rows=${v}, distinct blobs=${records.length}`,
  );
});
