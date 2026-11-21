// Run inside the archived b982414 checkout to exercise its actual writer and restorer.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { appFixture } from "./app-data-fixture.ts";
import { SessionService } from "../server/auth/sessions.ts";
import { AppDatabase } from "../server/app-data/db.ts";
import { digest } from "../server/app-data/validation.ts";
import { MemoryCandidates } from "../server/memory/candidates.ts";
import { registerVault, setVaultPaused } from "../server/memory/vault.ts";
import { registerHandwrittenNote } from "../server/memory/importer.ts";
import {
  BackupService,
  restoreBackup,
  resumeRestore,
} from "../server/operations/backup.ts";
const dir = process.argv[2],
  vault = join(dir, "original-vault"),
  stopped = join(dir, "old-stopped"),
  running = join(dir, "old-running");
const f = appFixture(),
  a = f.actor,
  room = f.room.id,
  persona = f.persona.id;
f.app.db
  .prepare("INSERT INTO auth_accounts VALUES(?,?,?,1,1)")
  .run(a.actorId, "old-host", "synthetic");
f.policy.grant(a.actorId, a.workspaceId, "MANAGE_VAULT");
for (const op of [
  "READ_MEMORY",
  "PROPOSE_MEMORY",
  "REVIEW_MEMORY",
  "PUBLISH_MEMORY",
])
  f.policy.grant(a.actorId, a.workspaceId, op, {
    roomId: room,
    personaId: persona,
    visibility: "persona_private",
  });
f.policy.grant(a.actorId, a.workspaceId, "READ_PRIVATE_SEGMENT", {
  roomId: room,
  personaId: persona,
  visibility: "self_only",
});
registerVault(f.app, vault, { trustNew: true });
setVaultPaused(f.app, false);
const markdown =
  "---\nmap_id: legacy_note\n---\nSynthetic preserved handwriting.";
writeFileSync(join(vault, "original.md"), markdown);
await registerHandwrittenNote(f.app, f.policy, a, {
  roomId: room,
  personaId: persona,
  scope: "persona_private",
  noteId: "legacy_note",
  relativePath: "original.md",
  expectedDigest: digest(markdown),
  requestId: "hand",
  trusted: true,
});
f.repository.updateRoom(a, room, {
  expectedRevision: 1,
  internalStateSettings: { enabled: true },
});
const candidates = new MemoryCandidates(f.app, f.policy);
for (const requestId of ["old-publishing", "old-failed"]) {
  const run = f.generation.accept(a, room, {
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
  const dto = candidates.get(a, room, row.candidate_id);
  candidates.review(a, room, {
    requestId: requestId + "-approve",
    decision: "approve",
    items: [dto.binding],
  });
  if (requestId === "old-publishing") {
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
            "beforeReceipt",
          ],
          { stdio: "pipe" },
        ),
      (err) => err.signal === "SIGKILL",
    );
  } else {
    f.app.db
      .prepare(
        "UPDATE memory_jobs SET status='FAILED',prepared=1 WHERE candidate_id=?",
      )
      .run(row.candidate_id);
    f.app.db
      .prepare(
        "UPDATE memory_candidates SET state='FAILED' WHERE candidate_id=?",
      )
      .run(row.candidate_id);
  }
}
const manifest = await new BackupService(f.app).backup(
  join(dir, "original-backup"),
);
assert.equal(manifest.schema, "MAP-MEM-1:BACKUP:2");
assert.equal(manifest.memory.versions.length, 1);
await restoreBackup(join(dir, "original-backup"), stopped);
await restoreBackup(join(dir, "original-backup"), running);
const rebased = new AppDatabase({ root: running });
assert.deepEqual(
  rebased.db
    .prepare("SELECT status,prepared FROM memory_jobs ORDER BY status")
    .all()
    .map((row) => [row.status, row.prepared]),
  [
    ["FAILED", 0],
    ["PENDING", 0],
  ],
);
await new SessionService(rebased).resetPassword(
  a.actorId,
  "synthetic-old-reset-password",
);
rebased.close();
await resumeRestore(running);
const resumed = new AppDatabase({ root: running });
await new BackupService(resumed).backup(join(dir, "old-second-backup"));
resumed.close();
f.app.close();
console.log(JSON.stringify({ actor: a.actorId, markdown }));
