import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { lineageFixture } from "./memory-lineage-fixture.ts";
import { permissions, share } from "./memory-context-fixture.ts";
import { registerHandwrittenNote } from "../server/memory/importer.ts";
import { saveVersion } from "../server/memory/vault.ts";
import { digest } from "../server/app-data/validation.ts";

/** Build a large synthetic *flattened* NOTE ancestry. The small mixed graph tests
 * exercise discovery; this load fixture isolates live original revalidation cost. */
export async function noteLoadFixture(count: number) {
  const f = lineageFixture(); permissions(f); f.original();
  f.repository.updatePersona(f.actor, f.room.id, f.persona.id, { expectedRevision: 2, contextMode: "none" });
  const root = await f.memory(); share(f, root.candidate.id);
  const scope = { roomId: f.room.id, personaId: f.persona.id, visibility: "room_shared" };
  f.policy.grant(f.actor.actorId, f.actor.workspaceId, "MANAGE_VAULT");
  f.policy.grant(f.actor.actorId, f.actor.workspaceId, "REVIEW_MEMORY", scope);
  const markdown = (id: string) => `---\nmap_id: "${id}"\nkind: "episodic"\nscope_hint: "room_shared"\n---\nload body`;
  const first = "mem_load_00000";
  writeFileSync(join(f.vault, first + ".md"), markdown(first));
  await registerHandwrittenNote(f.app, f.policy, f.actor, { roomId: f.room.id, personaId: f.persona.id,
    scope: "room_shared", noteId: first, relativePath: first + ".md", expectedDigest: digest(markdown(first)),
    requestId: first, trusted: true });
  f.app.transaction(() => {
    for (let i = 0; i < count; i++) {
      const id = "mem_load_" + i.toString().padStart(5, "0"), body = markdown(id), fileDigest = digest(body);
      if (i > 0) {
        writeFileSync(join(f.vault, id + ".md"), body); saveVersion(f.app, Buffer.from(body));
        f.app.db.prepare(`INSERT INTO memory_documents SELECT ?,workspace_id,room_id,owner_persona_id,scope,NULL,'PUBLISHED',?,1,?,body_digest,trusted
          FROM memory_documents WHERE note_id=?`).run(id, id + ".md", fileDigest, first);
        f.app.db.prepare(`INSERT INTO memory_versions SELECT ?,1,?,body_digest,?,created_at FROM memory_versions WHERE note_id=? AND version=1`)
          .run(id, fileDigest, id + ".md", first);
        f.app.db.prepare(`INSERT INTO memory_handwritten SELECT ?,workspace_id,registrar_id,?,?,?, ?,registered_at
          FROM memory_handwritten WHERE note_id=?`).run(id, id, digest("synthetic load " + id), id + ".md", fileDigest, first);
        f.app.db.prepare("INSERT INTO memory_handwritten_grants SELECT ?,grant_id FROM memory_handwritten_grants WHERE note_id=?").run(id, first);
      }
      f.app.db.prepare("INSERT INTO memory_dependencies VALUES(?,?,?,'NOTE',?,1,?)")
        .run(root.candidate.id, f.actor.workspaceId, f.room.id, id, fileDigest);
    }
  });
  return { ...f, rootNote: root.noteId, rootCandidate: root.candidate.id, firstPath: join(f.vault, first + ".md") };
}
