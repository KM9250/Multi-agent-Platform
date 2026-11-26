import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { lineageFixture } from "./memory-lineage-fixture.ts";
import { advanceLineage } from "../server/memory/lineage.ts";
import { readNote } from "../server/memory/notes.ts";
import { digest } from "../server/app-data/validation.ts";

type Fixture = ReturnType<typeof lineageFixture>;
export function permissions(f: Fixture) {
  const scope = { roomId: f.room.id, personaId: f.persona.id, visibility: "room_shared" };
  for (const op of ["READ_MEMORY", "PUBLISH_MEMORY", "CHANGE_MEMORY_SCOPE"])
    f.policy.grant(f.actor.actorId, f.actor.workspaceId, op, scope);
  f.policy.grant(f.actor.actorId, f.actor.workspaceId, "EDIT_MEMORY", { ...scope, visibility: "persona_private" });
}
export function finish(f: Fixture) {
  let slices = 0;
  while (advanceLineage(f.app)) assert.ok(++slices < 3000);
}
export function share(f: Fixture, id: string) {
  finish(f);
  const old = f.candidates.get(f.actor, f.room.id, id);
  f.candidates.edit(f.actor, f.room.id, id, { requestId: randomUUID(), expectedRevision: old.revision,
    body: old.body, kind: old.kind, assertionType: old.assertionType, scope: "room_shared" });
  f.publish(id);
}
/** Synthetic receipt fixture: bind a completed ordinary answer to an exact shared Note.
 * Search/packing/dispatch integration is tested separately; no real Provider is used. */
export async function answerUsing(f: Fixture, noteId: string, override?: (source: any) => void) {
  const run = await f.turn("参照した公開回答");
  const call = f.app.db.prepare("SELECT call_id,manifest_json FROM app_provider_calls WHERE run_id=? AND purpose='answer'").get(run)!;
  const note = f.app.db.prepare("SELECT * FROM memory_documents WHERE note_id=?").get(noteId)!;
  const manifest = JSON.parse(String(call.manifest_json));
  const source = { alias: "S1", ownerPersonaId: note.owner_persona_id, scope: "room_shared", recordedAt: 1,
    channel: "note", citation: { target: "memory", workspaceId: f.actor.workspaceId, roomId: f.room.id,
      noteId, version: note.version, fileDigest: note.digest, bodyDigest: note.body_digest,
      start: 0, end: readNote(f.app, f.policy, f.actor, noteId).body.length } };
  override?.(source);
  manifest.contract = "MAP-MEM-3:CONTEXT:1";
  const accepted = f.app.db.prepare("SELECT request_json FROM app_generation_runs WHERE run_id=?").get(run)!;
  manifest.payloadDigest = digest("synthetic-answer-payload");
  manifest.retrieval = {
    id: randomUUID(), actorId: f.actor.actorId, workspaceId: f.actor.workspaceId, roomId: f.room.id,
    runId: run, consumerPersonaId: f.persona.id, purpose: "answer", audience: "room", provider: manifest.provider,
    model: manifest.model, inputBinding: JSON.parse(String(accepted.request_json)).inputBinding,
    roomRevision: manifest.roomRevision, personaRevision: manifest.personaRevision, aclRevision: manifest.aclRevision,
    route: { version: "map-context-router-v1", requestedMode: "memory", mode: "memory", reason: "explicit_mode",
      query: { version: "map-context-query-v1", text: "予定", truncated: false },
      dateInterpretation: { version: "map-context-date-v1", status: "none", source: "none", timeZone: "UTC" }, requiresEvidence: false, requiresExactExcerpt: false },
    searches: [{ target: "memory", requestId: randomUUID(), status: "ready", methods: ["lexical"], reasons: [],
      scope: { roomId: f.room.id, target: "memory", revisionMode: "current" },
      coverage: { indexState: "ACTIVE", revisionMode: "current", planned: ["published_notes"] },
      external: { status: "none", calls: 0 }, searchOperationIds: [] }],
    sources: [source], permissions: [{ operation: "READ_MEMORY", roomId: f.room.id, personaId: f.persona.id,
      visibility: "room_shared", provider: "" }], packingVersion: "map-context-pack-v1",
    estimatorVersion: "utf8-bytes-div3-v1", estimatedTokens: 1, payloadDigest: digest("synthetic-reference-envelope"),
  };
  const json = JSON.stringify(manifest);
  f.app.db.prepare("UPDATE app_provider_calls SET manifest_json=?,manifest_digest=? WHERE call_id=?")
    .run(json, digest(json), call.call_id);
  return String(call.call_id);
}
