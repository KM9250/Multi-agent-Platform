import type { AppDatabase } from "../app-data/db.ts";
import { type Actor, AuthorizationPolicy } from "../auth/authorization.ts";
import { MemoryCandidates } from "./candidates.ts";
import { listNotes } from "./notes.ts";

/** The Host can inspect only conflicts whose affected note or candidate it may read. */
export function listVaultConflicts(
  app: AppDatabase,
  policy: AuthorizationPolicy,
  actor: Actor,
  roomId: string,
  afterNote?: string,
  afterCandidate?: string,
) {
  policy.assert(actor, "MANAGE_VAULT");
  const notes = listNotes(app, policy, actor, roomId, {
    after: afterNote,
    onlyConflicts: true,
  });
  const page = new MemoryCandidates(app, policy).list(
    actor,
    roomId,
    afterCandidate,
    true,
  );
  return {
    notes,
    publications: page.items.map(({ id, ownerPersonaId, state, binding }) => ({
      candidateId: id,
      ownerPersonaId,
      state,
      noteId: binding.targetNoteId,
    })),
    nextCandidate: page.nextCursor,
    nextNote: notes.length === 200 ? notes.at(-1)!.noteId : null,
  };
}
