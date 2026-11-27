import test from "node:test";
import assert from "node:assert/strict";
import { renameSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { lineageFixture } from "./memory-lineage-fixture.ts";
import { permissions, share } from "./memory-context-fixture.ts";
import { scanVault } from "../server/memory/importer.ts";
import { requestIndexUpdate, shutdownIndexWorkers } from "../server/search/index.ts";
import { readNote } from "../server/memory/notes.ts";
import { digest } from "../server/app-data/validation.ts";
import { advanceLineage } from "../server/memory/lineage.ts";

const evidenceDir = process.env.PR41_REAUDIT_EVIDENCE_DIR ?? "/tmp/pr41-reaudit-evidence";
mkdirSync(evidenceDir, { recursive: true });

test("PR41 re-audit F01: a read before the watcher observes a whole-Vault outage stays recoverable", async t => {
  const f = lineageFixture();
  t.after(async () => { await f.generation.shutdown(); await shutdownIndexWorkers(f.app); f.close(); });
  permissions(f); f.original();
  const first = await f.memory(); share(f, first.candidate.id);
  const answer = f.generation.accept(f.actor, f.room.id, {
    requestId: randomUUID(), expectedRoomRevision: f.room.revision,
    content: "予定は月曜", recipient: { type: "all" }, context: { mode: "memory" },
  });
  await requestIndexUpdate(f.app, f.policy, f.actor, f.room.id, { force: true });
  await f.generation.execute(answer.runId);
  assert.equal(f.generation.get(f.actor, f.room.id, answer.runId).status, "COMPLETED");
  const manifest = JSON.parse(String(f.app.db.prepare("SELECT manifest_json FROM app_provider_calls WHERE run_id=? AND purpose='answer'").get(answer.runId)!.manifest_json));
  assert.deepEqual(manifest.retrieval.sources.map((s: any) => s.citation.noteId), [first.noteId]);
  const second = await f.memory(); share(f, second.candidate.id);
  assert.equal((await scanVault(f.app)).status, "COMPLETE");
  const rows = () => f.app.db.prepare("SELECT note_id,state,version,digest,relative_path FROM memory_documents ORDER BY note_id").all();
  const files = () => rows().map(row => ({ noteId: row.note_id, digest: digest(readFileSync(join(f.vault, String(row.relative_path)))) }));
  const before = rows(), beforeFiles = files();
  const scanStateBefore = f.app.db.prepare("SELECT incomplete FROM memory_scan_state").get();
  assert.equal(scanStateBefore!.incomplete, 0);
  let readError: string | undefined;
  const away = f.vault + "-before-watcher";
  renameSync(f.vault, away);
  try {
    try { readNote(f.app, f.policy, f.actor, second.noteId); }
    catch (error) { readError = String((error as any).code ?? error); }
  } finally { renameSync(away, f.vault); }
  const afterRead = rows();
  const recovery = await scanVault(f.app), afterRecovery = rows();
  const again = await scanVault(f.app), afterAgain = rows();
  const result = {
    auditedHead: "2beb8c4bcc5836a93348b7e2c5ff11857867a1f2", sourceNote: first.noteId, descendantNote: second.noteId,
    before, scanStateBefore, readError, afterRead, recovery, afterRecovery, again, afterAgain,
    beforeFiles, afterFiles: files(), realProviderCalls: 0, syntheticProviderCalls: f.provider.calls.length,
    liveRetrieval: true, noteReadBeforeOutageScan: true,
  };
  writeFileSync(join(evidenceDir, "f01-read-before-scan.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  assert.deepEqual(result.afterFiles, beforeFiles);
  assert.equal(recovery.status, "COMPLETE");
  assert.equal(afterRecovery.find(row => row.note_id === second.noteId)!.state, "PUBLISHED", "unchanged descendant must recover after the whole Vault returns");
});

test("PR41 re-audit F01: the real lineage worker must defer a whole-Vault outage before the first failed scan", async t => {
  const f = lineageFixture();
  t.after(async () => { await f.generation.shutdown(); await shutdownIndexWorkers(f.app); f.close(); });
  permissions(f); f.original();
  const first = await f.memory(); share(f, first.candidate.id);
  await requestIndexUpdate(f.app, f.policy, f.actor, f.room.id, { force: true });
  // Actual answer calls retain a causal history chain longer than the four-CALL initial slice.
  // No manifest, dependency, authority, or queue row is forged to create this frontier.
  for (let n = 0; n < 6; n++) await f.turn(`予定は月曜 ${n}`);
  const derived = await f.memory();
  const work = () => f.app.db.prepare("SELECT status,calls_done,notes_done,invalidated FROM memory_lineage_work WHERE candidate_id=?").get(derived.candidate.id)!;
  const candidateState = () => f.candidates.get(f.actor, f.room.id, derived.candidate.id).state;
  assert.equal(work().status, "PENDING");
  assert.equal(candidateState(), "LINEAGE_PENDING");
  const references = f.app.db.prepare("SELECT note_id,checked FROM memory_lineage_notes WHERE candidate_id=?").all(derived.candidate.id);
  assert.ok(references.some(row => row.note_id === first.noteId && row.checked === 0));
  const before = { work: work(), state: candidateState(), references };
  assert.equal(f.app.db.prepare("SELECT incomplete FROM memory_scan_state").get()!.incomplete, 0);
  const source = f.app.db.prepare("SELECT relative_path,digest FROM memory_documents WHERE note_id=?").get(first.noteId)!;
  const fileBefore = digest(readFileSync(join(f.vault, String(source.relative_path))));
  const away = f.vault + "-before-lineage-worker";
  let slices = 0;
  renameSync(f.vault, away);
  try {
    while (work().status === "PENDING" && slices++ < 10) advanceLineage(f.app);
  } finally { renameSync(away, f.vault); }
  const afterWorker = { work: work(), state: candidateState(), slices };
  assert.equal(afterWorker.work.status, "PENDING");
  assert.equal(afterWorker.state, "LINEAGE_PENDING");
  assert.equal(afterWorker.work.notes_done, 0);
  assert.equal(f.app.db.prepare("SELECT checked FROM memory_lineage_notes WHERE candidate_id=? AND note_id=?").get(derived.candidate.id, first.noteId)!.checked, 0);
  const recovery = await scanVault(f.app);
  for (let n = 0; n < 10 && work().status === "PENDING"; n++) advanceLineage(f.app);
  const afterRecovery = { work: work(), state: candidateState() };
  const result = { auditedHead: "2beb8c4bcc5836a93348b7e2c5ff11857867a1f2", sourceNote: first.noteId,
    candidateId: derived.candidate.id, before, afterWorker, recovery, afterRecovery,
    fileBefore, fileAfter: digest(readFileSync(join(f.vault, String(source.relative_path)))),
    realProviderCalls: 0, syntheticProviderCalls: f.provider.calls.length, liveRetrieval: true,
    forgedManifestOrDependencies: false, incompleteBeforeWorker: 0 };
  writeFileSync(join(evidenceDir, "f01-worker-before-scan.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  assert.equal(result.fileAfter, fileBefore);
  assert.equal(recovery.status, "COMPLETE");
  assert.equal(afterRecovery.work.status, "DONE", "the pending original NOTE proof must resume after whole-Vault recovery");
  assert.equal(afterRecovery.state, "PENDING_REVIEW");
});
