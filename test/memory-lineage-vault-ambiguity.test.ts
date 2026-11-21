import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { lineageFixture } from "./memory-lineage-fixture.ts";
import { advanceLineage } from "../server/memory/lineage.ts";
import { enqueueLegacyLineage } from "../server/memory/lineage-recovery.ts";
import { scanVault } from "../server/memory/importer.ts";
import { BackupService } from "../server/operations/backup.ts";
import { readNote } from "../server/memory/notes.ts";

async function heldPublication(t: TestContext, schema: 2 | 3) {
  const f = lineageFixture();
  t.after(() => f.close());
  f.original();
  const memory = await f.memory();
  f.publish(memory.candidate.id);
  const id = memory.candidate.id;
  f.app.transaction(() => {
    // Retain a real reviewed job, receipt, version and editable file. Released DBs
    // lacked only the v4 verification frontier, which the migration now seeds.
    f.app.db
      .prepare("DELETE FROM memory_lineage_queue WHERE candidate_id=?")
      .run(id);
    f.app.db
      .prepare("DELETE FROM memory_lineage_work WHERE candidate_id=?")
      .run(id);
    if (schema === 3)
      f.app.db
        .prepare(
          "UPDATE memory_candidates SET state='NEEDS_REVIEW' WHERE candidate_id=?",
        )
        .run(id);
    enqueueLegacyLineage(f.app.db, schema);
  });
  const current = f.app.db
    .prepare("SELECT relative_path FROM memory_documents WHERE note_id=?")
    .get(memory.noteId)!;
  const duplicate = join(f.vault, "human-copy.md");
  copyFileSync(join(f.vault, String(current.relative_path)), duplicate);
  const invalid = () =>
    f.app.db
      .prepare(
        "SELECT invalidated FROM memory_lineage_work WHERE candidate_id=?",
      )
      .get(id)?.invalidated;
  assert.equal(invalid(), 0);
  return { ...f, memory, duplicate, invalid };
}
for (const [observer, schema] of [
  ["scan", 2],
  ["scan", 3],
  ["backup", 2],
] as const)
  test(`F-06 ${observer} retains duplicate ID evidence during schema-${schema} lineage verification`, async (t) => {
    const f = await heldPublication(t, schema);
    if (observer === "scan") {
      assert.equal((await scanVault(f.app)).status, "COMPLETE");
    } else {
      const root = mkdtempSync(join(tmpdir(), "map-lineage-duplicate-"));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const target = join(root, "backup");
      await new BackupService(f.app).backup(target);
      const snapshot = new DatabaseSync(join(target, "app-data.sqlite"), {
        readOnly: true,
      });
      try {
        assert.equal(
          snapshot
            .prepare(
              "SELECT invalidated FROM memory_lineage_work WHERE candidate_id=?",
            )
            .get(f.memory.candidate.id)?.invalidated,
          1,
        );
        assert.equal(
          snapshot
            .prepare(
              "SELECT 1 FROM memory_backup_observed_files WHERE note_id=?",
            )
            .get(f.memory.noteId),
          undefined,
        );
      } finally {
        snapshot.close();
      }
    }
    assert.equal(f.invalid(), 1);
    unlinkSync(f.duplicate);
    assert.equal((await scanVault(f.app)).status, "COMPLETE");
    assert.equal(f.invalid(), 1);
    assert.equal(advanceLineage(f.app), true);
    assert.equal(
      f.app.db
        .prepare("SELECT status FROM memory_lineage_work WHERE candidate_id=?")
        .get(f.memory.candidate.id)?.status,
      "INVALID",
    );
    assert.throws(
      () => readNote(f.app, f.policy, f.actor, f.memory.noteId),
      /MEMORY_UNAVAILABLE/,
    );
    assert.equal(
      f.app.db.prepare("SELECT count(*) AS n FROM memory_receipts").get()?.n,
      1,
    );
  });
