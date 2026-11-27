import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { lineageFixture } from "./memory-lineage-fixture.ts";
import { readVaultFile } from "../server/memory/vault.ts";
import { NoteVerificationPending, VaultRootUnavailable } from "../server/memory/verification-state.ts";
import { verifyCurrentNoteFile } from "../server/memory/lineage.ts";
import { readNote } from "../server/memory/notes.ts";
import { publishNext } from "../server/memory/worker.ts";
import { withVerifiedNoteAncestors } from "../server/memory/source-validation.ts";
import { permissions, share, answerUsing, finish } from "./memory-context-fixture.ts";
import { shutdownIndexWorkers } from "../server/search/index.ts";
import { SearchSources } from "../server/search/sources.ts";

test("F-01 root disappearance at the post-read reopen is pending without a preflight race", async t => {
  const f = lineageFixture(); t.after(f.close); f.original();
  const memory = await f.memory(); f.publish(memory.candidate.id);
  const row = f.app.db.prepare("SELECT * FROM memory_documents WHERE note_id=?").get(memory.noteId)!;
  const away = f.vault + "-during-read", originalRead = fs.readSync;
  let moved = false;
  const read = t.mock.method(fs, "readSync", (...args: any[]) => {
    const n = Reflect.apply(originalRead, fs, args);
    if (!moved) { fs.renameSync(f.vault, away); moved = true; }
    return n;
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => readVaultFile(f.app, String(row.relative_path)), VaultRootUnavailable);
    assert.equal(moved, true);
    assert.throws(() => verifyCurrentNoteFile(f.app, row), NoteVerificationPending);
    assert.throws(() => readNote(f.app, f.policy, f.actor, memory.noteId), /MEMORY_UNAVAILABLE/);
    const sources = new SearchSources(f.app, f.policy, f.actor, f.room.id);
    assert.throws(() => sources.memoryPage(), NoteVerificationPending, "a pending read must not commit a removal page or advance its cursor");
    await assert.rejects(() => sources.memoryPageAsync(), NoteVerificationPending);
    assert.equal(f.app.db.prepare("SELECT state FROM memory_documents WHERE note_id=?").get(memory.noteId)!.state, "PUBLISHED");
  } finally {
    read.mock.restore(); syncBuiltinESMExports();
    if (moved) fs.renameSync(away, f.vault);
  }
  assert.equal(readNote(f.app, f.policy, f.actor, memory.noteId).state, "PUBLISHED");
});

for (const change of ["deleted", "edited", "root-replaced", "root-symlink"] as const)
  test(`F-01 confirmed unsafe original stays distinct from root unavailability: ${change}`, async t => {
    const f = lineageFixture(); t.after(f.close); f.original();
    const memory = await f.memory(); f.publish(memory.candidate.id);
    const row = f.app.db.prepare("SELECT * FROM memory_documents WHERE note_id=?").get(memory.noteId)!;
    const path = join(f.vault, String(row.relative_path)), away = f.vault + "-original";
    const registered = f.app.db.prepare("SELECT root,dev,ino FROM memory_vault").get();
    if (change === "deleted") fs.unlinkSync(path);
    if (change === "edited") fs.appendFileSync(path, "改変");
    if (change.startsWith("root-")) {
      fs.renameSync(f.vault, away);
      if (change === "root-replaced") fs.mkdirSync(f.vault, { mode: 0o700 });
      else fs.symlinkSync(away, f.vault);
    }
    try {
      assert.throws(() => verifyCurrentNoteFile(f.app, row), error => !(error instanceof NoteVerificationPending));
      assert.throws(() => readNote(f.app, f.policy, f.actor, memory.noteId), /MEMORY_UNAVAILABLE/);
      const state = f.app.db.prepare("SELECT state FROM memory_documents WHERE note_id=?").get(memory.noteId)!.state;
      assert.equal(state, change === "deleted" ? "DELETED" : change === "edited" ? "DIRTY" : "CONFLICT");
      assert.deepEqual(f.app.db.prepare("SELECT root,dev,ino FROM memory_vault").get(), registered);
    } finally {
      if (change.startsWith("root-")) {
        fs.rmSync(f.vault, { recursive: true, force: true }); fs.renameSync(away, f.vault);
      }
    }
  });

test("F-01 ancestor stamps and publication preserve pending root outages before any scan", async t => {
  const f = lineageFixture();
  t.after(async () => { await f.generation.shutdown(); await shutdownIndexWorkers(f.app); f.close(); });
  permissions(f); f.original();
  const first = await f.memory(); share(f, first.candidate.id);
  await answerUsing(f, first.noteId);
  const second = await f.memory(); finish(f); share(f, second.candidate.id);
  await answerUsing(f, second.noteId);
  const third = await f.memory(); finish(f);
  const candidate = f.candidates.get(f.actor, f.room.id, third.candidate.id);
  f.candidates.review(f.actor, f.room.id, { requestId: randomUUID(), decision: "approve", items: [candidate.binding] });
  const away = f.vault + "-publication";
  assert.equal(f.app.db.prepare("SELECT incomplete FROM memory_scan_state").get()!.incomplete, 0);
  fs.renameSync(f.vault, away);
  try {
    let entered = false;
    await assert.rejects(() => withVerifiedNoteAncestors(f.app, [second.noteId], () => { entered = true; }), NoteVerificationPending);
    assert.equal(entered, false);
    assert.equal(publishNext(f.app, f.policy), true);
    assert.equal(f.app.db.prepare("SELECT status FROM memory_jobs WHERE candidate_id=?").get(third.candidate.id)!.status, "PENDING");
    assert.equal(f.candidates.get(f.actor, f.room.id, third.candidate.id).state, "APPROVED");
  } finally { fs.renameSync(away, f.vault); }
  assert.equal(publishNext(f.app, f.policy), true);
  assert.equal(readNote(f.app, f.policy, f.actor, third.noteId).state, "PUBLISHED");
});
