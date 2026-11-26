import test from "node:test";
import assert from "node:assert/strict";
import { renameSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { lineageFixture } from "./memory-lineage-fixture.ts";
import { permissions, share, finish, answerUsing } from "./memory-context-fixture.ts";
import { scanVault } from "../server/memory/importer.ts";
import { requestIndexUpdate, shutdownIndexWorkers } from "../server/search/index.ts";
import { AppDatabase } from "../server/app-data/db.ts";
import { advanceLineage } from "../server/memory/lineage.ts";
import { readNote } from "../server/memory/notes.ts";
import { SearchSources } from "../server/search/sources.ts";
import { digest } from "../server/app-data/validation.ts";

test("PR41 audit: a temporary Vault outage must not permanently invalidate healthy NOTE descendants", async t => {
  const f = lineageFixture();
  t.after(async () => { await f.generation.shutdown(); await shutdownIndexWorkers(f.app); f.close(); });
  permissions(f);
  f.original();
  const first = await f.memory();
  share(f, first.candidate.id);
  const answer = f.generation.accept(f.actor, f.room.id, {
    requestId: randomUUID(), expectedRoomRevision: f.room.revision,
    content: "予定は月曜", recipient: { type: "all" }, context: { mode: "memory" },
  });
  await requestIndexUpdate(f.app, f.policy, f.actor, f.room.id, { force: true });
  await f.generation.execute(answer.runId);
  assert.equal(f.generation.get(f.actor, f.room.id, answer.runId).status, "COMPLETED");
  const manifest = JSON.parse(String(f.app.db.prepare("SELECT manifest_json FROM app_provider_calls WHERE run_id=? AND purpose='answer'").get(answer.runId)!.manifest_json));
  assert.deepEqual(manifest.retrieval.sources.map((s: any) => s.citation.noteId), [first.noteId]);
  const second = await f.memory();
  finish(f);
  share(f, second.candidate.id);
  const states = () => f.app.db.prepare("SELECT note_id,state FROM memory_documents ORDER BY note_id").all();
  const files = () => f.app.db.prepare("SELECT note_id,relative_path,digest FROM memory_documents ORDER BY note_id").all()
    .map(r => ({ noteId: r.note_id, expectedDigest: r.digest, actualDigest: digest(readFileSync(join(f.vault, String(r.relative_path)))) }));
  const immutable = () => ({ versions: f.app.db.prepare("SELECT * FROM memory_versions ORDER BY note_id,version").all(),
    receipts: f.app.db.prepare("SELECT * FROM memory_receipts ORDER BY operation_id").all() });
  const proofBefore = immutable();
  const before = states();
  const filesBefore = files();
  assert.ok(before.every(r => r.state === "PUBLISHED"));
  const away = f.vault + "-temporary-away";
  let failed;
  renameSync(f.vault, away);
  try { failed = await scanVault(f.app); }
  finally { renameSync(away, f.vault); }
  assert.equal(failed.status, "SCAN_FAILED");
  assert.equal(f.app.db.prepare("SELECT incomplete FROM memory_scan_state").get()!.incomplete, 1);
  const incompleteAfterFailure = 1;
  const recovered = await scanVault(f.app);
  const after = states();
  const again = await scanVault(f.app);
  const evidence = { probe: "vault_outage_note_descendant", auditHead: "99d124ae9ecd4d38282926ac531ae17733ff4c7f",
    before, failed, incompleteAfterFailure, recovered,
    incompleteAfter: f.app.db.prepare("SELECT incomplete FROM memory_scan_state").get()!.incomplete,
    after, again, afterSecondHealthyScan: states(), firstNote: first.noteId, descendantNote: second.noteId,
    filesBefore, filesAfter: files(), realProviderCalls: 0, syntheticProviderCalls: f.provider.calls.length,
    searchOperationCount: f.app.db.prepare("SELECT count(*) n FROM search_operations").get()!.n,
    providerKind: "FakeProvider", liveRetrieval: true,
  };
  assert.deepEqual(immutable(), proofBefore);
  assert.deepEqual(evidence.filesAfter, filesBefore, "all Note bytes and expected digests remain unchanged");
  if (process.env.MAP_PR41_AUDIT_EVIDENCE) writeFileSync(process.env.MAP_PR41_AUDIT_EVIDENCE, JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify(evidence));
  assert.equal(recovered.status, "COMPLETE");
  assert.equal(readNote(f.app, f.policy, f.actor, first.noteId).state, "PUBLISHED");
  assert.equal(readNote(f.app, f.policy, f.actor, second.noteId).state, "PUBLISHED");
  assert.equal(f.app.db.prepare("SELECT state FROM memory_documents WHERE note_id=?").get(second.noteId)!.state,
    "PUBLISHED", "unmodified descendant must become available after a complete healthy scan");
});

async function descendants(t: any) {
  const f = lineageFixture(); t.after(f.close); permissions(f); f.original();
  const first = await f.memory(); share(f, first.candidate.id);
  await answerUsing(f, first.noteId);
  const second = await f.memory(); share(f, second.candidate.id);
  return { f, first, second };
}
async function outage(f: ReturnType<typeof lineageFixture>) {
  const away = f.vault + "-away"; renameSync(f.vault, away);
  try { assert.equal((await scanVault(f.app)).status, "SCAN_FAILED"); }
  finally { renameSync(away, f.vault); }
}

test("F-01 recovery interrupted again keeps healthy descendants retryable and readers closed", async t => {
  const { f, first, second } = await descendants(t); await outage(f);
  const transaction = f.app.transaction.bind(f.app);
  let interrupted = false;
  f.app.transaction = ((fn: any, boundary?: string) => {
    if (boundary === "memory_import" && !interrupted) {
      interrupted = true;
      assert.equal(f.app.db.prepare("SELECT incomplete FROM memory_scan_state").get()!.incomplete, 1);
      assert.throws(() => readNote(f.app, f.policy, f.actor, second.noteId), /MEMORY_UNAVAILABLE/);
      assert.throws(() => new SearchSources(f.app, f.policy, f.actor, f.room.id).memoryPage(), /NOTE_VERIFICATION_PENDING/);
      throw new Error("synthetic recovery interruption");
    }
    return transaction(fn, boundary);
  }) as typeof f.app.transaction;
  assert.equal((await scanVault(f.app)).status, "SCAN_FAILED");
  f.app.transaction = transaction;
  assert.equal(f.app.db.prepare("SELECT state FROM memory_documents WHERE note_id=?").get(second.noteId)!.state, "PUBLISHED");
  assert.equal((await scanVault(f.app)).status, "COMPLETE");
  assert.equal(readNote(f.app, f.policy, f.actor, first.noteId).state, "PUBLISHED");
  assert.equal(readNote(f.app, f.policy, f.actor, second.noteId).state, "PUBLISHED");
});

test("F-01 a live change during complete-inventory reconciliation cannot clear incomplete", async t => {
  const { f, first } = await descendants(t); await outage(f);
  const transaction = f.app.transaction.bind(f.app);
  let changed = false;
  f.app.transaction = ((fn: any, boundary?: string) => {
    const result = transaction(fn, boundary);
    if (boundary === "memory_import" && !changed) {
      changed = true;
      writeFileSync(join(f.vault, "late-duplicate.md"), readFileSync(join(f.vault, String(f.app.db.prepare(
        "SELECT relative_path FROM memory_documents WHERE note_id=?").get(first.noteId)!.relative_path))));
    }
    return result;
  }) as typeof f.app.transaction;
  assert.equal((await scanVault(f.app)).status, "SCAN_FAILED");
  assert.equal(f.app.db.prepare("SELECT incomplete FROM memory_scan_state").get()!.incomplete, 1);
  f.app.transaction = transaction;
  assert.equal((await scanVault(f.app)).status, "COMPLETE");
  assert.throws(() => readNote(f.app, f.policy, f.actor, first.noteId), /MEMORY_UNAVAILABLE/);
});

test("F-01 real edits, deletion, duplicate IDs and revoked/regranted authority stay invalid after recovery", async t => {
  for (const action of ["edit", "delete", "duplicate", "regrant"] as const) await t.test(action, async t => {
    const { f, first, second } = await descendants(t); await outage(f);
    const path = join(f.vault, String(f.app.db.prepare("SELECT relative_path FROM memory_documents WHERE note_id=?").get(first.noteId)!.relative_path));
    if (action === "edit") writeFileSync(path, readFileSync(path, "utf8").replace("月曜", "火曜"));
    if (action === "delete") unlinkSync(path);
    if (action === "duplicate") writeFileSync(join(f.vault, "duplicate.md"), readFileSync(path));
    if (action === "regrant") { f.policy.revoke(f.actor.actorId, f.actor.workspaceId, "READ_MEMORY"); permissions(f); }
    assert.equal((await scanVault(f.app)).status, "COMPLETE");
    assert.throws(() => readNote(f.app, f.policy, f.actor, second.noteId), /MEMORY_UNAVAILABLE/);
    assert.equal((await scanVault(f.app)).status, "COMPLETE");
    assert.throws(() => readNote(f.app, f.policy, f.actor, second.noteId), /MEMORY_UNAVAILABLE/);
  });
});

test("F-01 pending NOTE frontier survives outage/restart, yields to another candidate and revalidates before resuming", async t => {
  for (const action of ["healthy", "changed", "revoked"] as const) await t.test(action, async t => {
    const f = lineageFixture(); t.after(f.close); permissions(f); f.original();
    const first = await f.memory(); share(f, first.candidate.id);
    for (let n = 0; n < 160; n++) {
      const actorId = "pending-proof-" + n;
      f.app.db.prepare("INSERT INTO principals VALUES(?,?,1)").run(actorId, f.actor.workspaceId);
      f.policy.grant(actorId, f.actor.workspaceId, "READ_ROOM", { roomId: f.room.id });
      f.app.db.prepare("INSERT INTO memory_authorities VALUES(?,?,'READ_ROOM',?,'','')").run(first.candidate.id, actorId, f.room.id);
    }
    await answerUsing(f, first.noteId);
    const pending = await f.memory();
    const frontier = () => f.app.db.prepare("SELECT * FROM memory_lineage_notes WHERE candidate_id=?").all(pending.candidate.id);
    const before = frontier(); assert.equal(before[0].checked, 0);
    await outage(f);
    for (let n = 0; n < 3; n++) advanceLineage(f.app);
    assert.deepEqual(frontier(), before);
    assert.equal(f.app.db.prepare("SELECT status,notes_done FROM memory_lineage_work WHERE candidate_id=?").get(pending.candidate.id)!.status, "PENDING");
    // Another real export, whose ordinary history consists only of standalone user messages.
    f.original(); f.original(); const independent = await f.memory();
    for (let n = 0; n < 10; n++) advanceLineage(f.app);
    assert.equal(f.app.db.prepare("SELECT status FROM memory_lineage_work WHERE candidate_id=?").get(independent.candidate.id)!.status, "DONE");
    assert.deepEqual(frontier(), before);
    await f.generation.shutdown(); f.app.close();
    const reopened = new AppDatabase({ root: f.root }); t.after(() => reopened.close());
    assert.equal(advanceLineage(reopened), true);
    assert.deepEqual(reopened.db.prepare("SELECT * FROM memory_lineage_notes WHERE candidate_id=?").all(pending.candidate.id), before);
    if (action === "changed") {
      const path = join(f.vault, String(reopened.db.prepare("SELECT relative_path FROM memory_documents WHERE note_id=?").get(first.noteId)!.relative_path));
      writeFileSync(path, readFileSync(path, "utf8").replace("月曜", "火曜"));
    }
    if (action === "revoked") {
      const { AuthorizationPolicy } = await import("../server/auth/authorization.ts");
      new AuthorizationPolicy(reopened).revoke("pending-proof-159", f.actor.workspaceId, "READ_ROOM");
    }
    assert.equal((await scanVault(reopened)).status, "COMPLETE");
    let slices = 0; while (advanceLineage(reopened)) assert.ok(++slices < 30);
    const result = reopened.db.prepare("SELECT status,notes_done FROM memory_lineage_work WHERE candidate_id=?").get(pending.candidate.id)!;
    assert.equal(result.status, action === "healthy" ? "DONE" : "INVALID");
    assert.equal(result.notes_done, action === "healthy" ? 1 : 0);
  });
});

test("F-01 a second physical Vault outage during reconciliation leaves descendants retryable", async t => {
  const { f, first, second } = await descendants(t); await outage(f);
  const transaction = f.app.transaction.bind(f.app), away = f.vault + "-again";
  let moved = false;
  f.app.transaction = ((fn: any, boundary?: string) => {
    if (boundary === "memory_import" && !moved) { renameSync(f.vault, away); moved = true; }
    return transaction(fn, boundary);
  }) as typeof f.app.transaction;
  try { assert.equal((await scanVault(f.app)).status, "SCAN_FAILED"); }
  finally { f.app.transaction = transaction; if (moved) renameSync(away, f.vault); }
  assert.equal(f.app.db.prepare("SELECT state FROM memory_documents WHERE note_id=?").get(second.noteId)!.state, "PUBLISHED");
  assert.equal((await scanVault(f.app)).status, "COMPLETE");
  assert.equal(readNote(f.app, f.policy, f.actor, first.noteId).state, "PUBLISHED");
  assert.equal(readNote(f.app, f.policy, f.actor, second.noteId).state, "PUBLISHED");
});
