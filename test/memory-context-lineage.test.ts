import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { lineageFixture } from "./memory-lineage-fixture.ts";
import { advanceLineage, LINEAGE_AUTHORITIES_PER_NOTE_SLICE } from "../server/memory/lineage.ts";
import { readNote } from "../server/memory/notes.ts";
import { digest } from "../server/app-data/validation.ts";
import { AppDatabase } from "../server/app-data/db.ts";
import { permissions, finish, share, answerUsing } from "./memory-context-fixture.ts";
import { registerHandwrittenNote } from "../server/memory/importer.ts";

test("MEM-3A shared Note → answer → memory follows old/private provenance without granting it to a consumer", async (t) => {
  const f = lineageFixture(); t.after(f.close); permissions(f);
  const original = f.original(), first = await f.memory(); share(f, first.candidate.id);
  const consumer = { actorId: "public-note-reader", workspaceId: f.actor.workspaceId };
  f.app.db.prepare("INSERT INTO principals VALUES(?,?,1)").run(consumer.actorId, consumer.workspaceId);
  f.policy.grant(consumer.actorId, consumer.workspaceId, "READ_ROOM", { roomId: f.room.id });
  f.policy.grant(consumer.actorId, consumer.workspaceId, "READ_MEMORY", {
    roomId: f.room.id, personaId: f.persona.id, visibility: "room_shared" });
  const projection = readNote(f.app, f.policy, consumer, first.noteId);
  assert.equal(projection.body, "予定は月曜"); assert.deepEqual(projection.sourceRefs, []);
  assert.equal(f.policy.can(consumer, "READ_PRIVATE_SEGMENT", {
    roomId: f.room.id, personaId: f.persona.id, visibility: "self_only" }), false);
  await answerUsing(f, first.noteId);
  const second = await f.memory(); finish(f);
  assert.equal(f.candidates.get(f.actor, f.room.id, second.candidate.id).derivedFromMemory, true);
  f.publish(second.candidate.id);
  const notes = f.app.db.prepare("SELECT * FROM memory_dependencies WHERE candidate_id=? AND resource_type='NOTE'").all(second.candidate.id);
  assert.equal(notes.length, 1); assert.equal(notes[0].resource_id, first.noteId);
  const used = f.app.db.prepare("SELECT 1 FROM memory_authorities WHERE candidate_id=? AND operation='READ_MEMORY' AND visibility='room_shared'").get(second.candidate.id);
  assert.ok(used);
  f.correct(original);
  assert.equal(f.candidates.get(f.actor, f.room.id, second.candidate.id).state, "NEEDS_REVIEW");
  assert.throws(() => readNote(f.app, f.policy, f.actor, second.noteId), /MEMORY_UNAVAILABLE/);
});

test("MEM-3A multistage Note dependency checks ancestor files before watcher observes an edit or deletion", async (t) => {
  for (const action of ["edit", "delete"] as const) {
    await t.test(action, async (t) => {
      const f = lineageFixture(); t.after(f.close); permissions(f); f.original();
      const first = await f.memory(); share(f, first.candidate.id);
      await answerUsing(f, first.noteId);
      const second = await f.memory(); share(f, second.candidate.id);
      await answerUsing(f, second.noteId);
      const third = await f.memory(); finish(f); f.publish(third.candidate.id);
      const row = f.app.db.prepare("SELECT relative_path FROM memory_documents WHERE note_id=?").get(first.noteId)!;
      const path = join(f.vault, String(row.relative_path));
      if (action === "edit") writeFileSync(path, readFileSync(path, "utf8").replace("月曜", "火曜"));
      else unlinkSync(path);
      assert.throws(() => readNote(f.app, f.policy, f.actor, third.noteId), /MEMORY_UNAVAILABLE/);
    });
  }
});

test("MEM-3A NOTE authorities remain bounded, durable and resumable without changing CALL counters", async (t) => {
  const f = lineageFixture(); t.after(f.close); permissions(f); f.original();
  const first = await f.memory(); share(f, first.candidate.id);
  for (let n = 0; n < 160; n++) {
    const actorId = "note-proof-" + n;
    f.app.db.prepare("INSERT INTO principals VALUES(?,?,1)").run(actorId, f.actor.workspaceId);
    f.policy.grant(actorId, f.actor.workspaceId, "READ_ROOM", { roomId: f.room.id });
    f.app.db.prepare("INSERT INTO memory_authorities VALUES(?,?,'READ_ROOM',?,'','')").run(first.candidate.id, actorId, f.room.id);
  }
  await answerUsing(f, first.noteId);
  const second = await f.memory();
  assert.equal(f.candidates.get(f.actor, f.room.id, second.candidate.id).state, "LINEAGE_PENDING");
  const frontier = f.app.db.prepare("SELECT * FROM memory_lineage_notes WHERE candidate_id=?").get(second.candidate.id)!;
  assert.ok(frontier && frontier.checked === 0);
  const checked = f.app.db.prepare("SELECT calls_done,notes_done FROM memory_lineage_work WHERE candidate_id=?").get(second.candidate.id)!;
  assert.ok(Number(checked.calls_done) <= 4); assert.equal(checked.notes_done, 0);
  assert.equal(LINEAGE_AUTHORITIES_PER_NOTE_SLICE, 32);
  // VACUUM/restore is permitted to renumber implicit rowids. Persistent cursors and
  // causal bindings use business keys, so a physical rewrite cannot skip remaining work.
  f.app.db.exec("UPDATE app_generation_receipts SET rowid=rowid+100000; UPDATE memory_authorities SET rowid=rowid+100000;");
  f.app.close();
  const reopened = new AppDatabase({ root: f.root }); t.after(() => reopened.close());
  let slices = 0;
  while (advanceLineage(reopened)) assert.ok(++slices < 100);
  const job = reopened.db.prepare("SELECT * FROM memory_lineage_work WHERE candidate_id=?").get(second.candidate.id)!;
  assert.equal(job.status, "DONE"); assert.equal(job.notes_done, 1);
  assert.equal(reopened.db.prepare("SELECT checked FROM memory_lineage_notes WHERE candidate_id=?").get(second.candidate.id)?.checked, 1);
});

test("MEM-3A unknown source kinds and mismatched Note digests never become dependency-free approvals", async (t) => {
  for (const mutation of [(s: any) => s.citation.target = "summary", (s: any) => s.citation.bodyDigest = "0".repeat(64)]) {
    const f = lineageFixture(); t.after(f.close); permissions(f); f.original();
    const first = await f.memory(); share(f, first.candidate.id);
    await answerUsing(f, first.noteId, mutation);
    const second = await f.memory(); finish(f);
    assert.equal(f.candidates.get(f.actor, f.room.id, second.candidate.id).state, "NEEDS_REVIEW");
  }
});

test("MEM-3A exact READ_MEMORY withdrawal is sticky and an unused wildcard withdrawal is unrelated", async (t) => {
  const f = lineageFixture(); t.after(f.close); permissions(f); f.original();
  const first = await f.memory(); share(f, first.candidate.id);
  await answerUsing(f, first.noteId); const second = await f.memory(); finish(f);
  f.app.db.prepare(`INSERT INTO access_grants(grant_id,workspace_id,actor_id,operation,room_id,persona_id,provider,visibility)
    VALUES(?,?,?,'READ_MEMORY','*','*','*','*')`).run("unused-wildcard", f.actor.workspaceId, f.actor.actorId);
  f.app.db.prepare("UPDATE access_grants SET revoked_at=1 WHERE grant_id='unused-wildcard'").run();
  assert.equal(f.candidates.get(f.actor, f.room.id, second.candidate.id).state, "PENDING_REVIEW");
  f.policy.revoke(f.actor.actorId, f.actor.workspaceId, "READ_MEMORY");
  permissions(f);
  f.policy.grant(f.actor.actorId, f.actor.workspaceId, "READ_MEMORY", {
    roomId: f.room.id, personaId: f.persona.id, visibility: "persona_private" });
  assert.equal(f.candidates.get(f.actor, f.room.id, second.candidate.id).state, "NEEDS_REVIEW");
});

test("MEM-3A registered handwritten Note carries registrar/grant identity into descendants", async (t) => {
  for (const action of ["grant", "registrar"] as const) await t.test(action, async (t) => {
    const f = lineageFixture(); t.after(f.close); permissions(f);
    const registrar = { actorId: "handwritten-registrar", workspaceId: f.actor.workspaceId };
    f.app.db.prepare("INSERT INTO principals VALUES(?,?,1)").run(registrar.actorId, registrar.workspaceId);
    f.policy.grant(registrar.actorId, registrar.workspaceId, "MANAGE_VAULT");
    f.policy.grant(registrar.actorId, registrar.workspaceId, "READ_ROOM", { roomId: f.room.id });
    const scope = { roomId: f.room.id, personaId: f.persona.id, visibility: "room_shared" };
    for (const op of ["READ_MEMORY", "REVIEW_MEMORY", "PUBLISH_MEMORY", "CHANGE_MEMORY_SCOPE"])
      f.policy.grant(registrar.actorId, registrar.workspaceId, op, scope);
    const markdown = '---\nmap_id: "mem_handwritten_context"\nkind: "episodic"\nscope_hint: "room_shared"\n---\n予定は月曜';
    writeFileSync(join(f.vault, "handwritten.md"), markdown);
    await registerHandwrittenNote(f.app, f.policy, registrar, {
      roomId: f.room.id, personaId: f.persona.id, scope: scope.visibility,
      noteId: "mem_handwritten_context", relativePath: "handwritten.md", expectedDigest: digest(markdown),
      requestId: "register-context-note", trusted: true,
    });
    await answerUsing(f, "mem_handwritten_context");
    const next = await f.memory(); finish(f); f.publish(next.candidate.id);
    assert.equal(readNote(f.app, f.policy, f.actor, next.noteId).body, "独立した記録");
    if (action === "grant") f.policy.revoke(registrar.actorId, registrar.workspaceId, "PUBLISH_MEMORY");
    else f.app.db.prepare("UPDATE principals SET active=0 WHERE actor_id=?").run(registrar.actorId);
    assert.equal(f.candidates.get(f.actor, f.room.id, next.candidate.id).state, "NEEDS_REVIEW");
    assert.throws(() => readNote(f.app, f.policy, f.actor, next.noteId), /MEMORY_UNAVAILABLE/);
  });
});

test("MEM-3A a CALL/NOTE causal cycle and contradictory versions are rejected", async (t) => {
  for (const action of ["cycle", "versions"] as const) await t.test(action, async (t) => {
    const f = lineageFixture(); t.after(f.close); permissions(f); f.original();
    const first = await f.memory(); share(f, first.candidate.id);
    const answer = await answerUsing(f, first.noteId);
    if (action === "cycle") {
      // Corrupt synthetic provenance: the Note now claims the very answer consuming it.
      f.app.db.prepare("UPDATE memory_candidates SET call_id=? WHERE candidate_id=?").run(answer, first.candidate.id);
    } else {
      const saved = f.app.db.prepare("SELECT manifest_json FROM app_provider_calls WHERE call_id=?").get(answer)!;
      const manifest = JSON.parse(String(saved.manifest_json));
      const contradictory = structuredClone(manifest.retrieval.sources[0]);
      contradictory.alias = "S2"; contradictory.citation.version++;
      manifest.retrieval.sources.push(contradictory);
      const json = JSON.stringify(manifest);
      f.app.db.prepare("UPDATE app_provider_calls SET manifest_json=?,manifest_digest=? WHERE call_id=?").run(json, digest(json), answer);
    }
    const next = await f.memory(); finish(f);
    assert.equal(f.candidates.get(f.actor, f.room.id, next.candidate.id).state, "NEEDS_REVIEW");
  });
});
