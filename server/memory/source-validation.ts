import { lstatSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { AppError } from "../../shared/app-contracts/index.ts";
import type { AppDatabase } from "../app-data/db.ts";
import { verifyCurrentNoteFile } from "./lineage.ts";
import { NoteVerificationPending } from "./verification-state.ts";
import { validVaultPath, withVaultDirectory } from "./vault.ts";

export const NOTE_VALIDATION_PAGE = 32;
const active = new WeakMap<object, Map<string, string>>();
const changed = (): never => { throw new AppError("SOURCE_CHANGED", 409); };
function identity(row: Record<string, any>) {
  return JSON.stringify([row.state, row.current_revision, row.call_id, row.target_note_id]);
}
function candidate(app: AppDatabase, id: string) {
  const row = app.db.prepare("SELECT state,current_revision,call_id,target_note_id FROM memory_candidates WHERE candidate_id=?").get(id);
  if (!row || ["RETRACTED", "SUPERSEDED", "NEEDS_REVIEW", "LINEAGE_PENDING"].includes(String(row.state))) changed();
  return row;
}
function stamp(app: AppDatabase, path: string): string {
  try {
    if (!validVaultPath(path) || !path.toLowerCase().endsWith(".md")) changed();
    const parent = dirname(path);
    return withVaultDirectory(app, parent === "." ? "" : parent, directory => {
      const stat = lstatSync(join(directory, basename(path)), { bigint: true });
      if (!stat.isFile() || stat.nlink !== 1n) changed();
      return [stat.dev, stat.ino, stat.size, stat.ctimeNs, stat.mtimeNs].join(":");
    });
  } catch (error) {
    if (error instanceof NoteVerificationPending) throw error;
    if (error instanceof Error && "code" in error && String(error.code).startsWith("ERR_SQLITE")) throw error;
    return changed();
  }
}

/** Internal, single synchronous boundary capability. It is never persisted or returned as a DTO. */
export function hasVerifiedNoteAncestors(app: object & { db: AppDatabase["db"] }, candidateId: string): boolean {
  const expected = active.get(app)?.get(candidateId);
  if (!expected) return false;
  const row = app.db.prepare("SELECT state,current_revision,call_id,target_note_id FROM memory_candidates WHERE candidate_id=?").get(candidateId);
  return !!row && identity(row) === expected;
}

/** Read every ancestor's bytes afresh outside the writer, yielding after bounded pages.
 * Final secure metadata checks catch edits made during an earlier yielded page. The
 * callback then runs synchronously, retaining DB/ACL checks and the selected Note's own
 * live read. There is deliberately no reusable or cross-boundary validation cache. */
export async function withVerifiedNoteAncestors<T>(
  app: AppDatabase,
  noteIds: readonly string[],
  callback: () => T,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  if (noteIds.length && app.db.prepare("SELECT incomplete FROM memory_scan_state WHERE singleton=1").get()?.incomplete)
    throw new NoteVerificationPending();
  if (app.db.isTransaction && noteIds.length) throw new AppError("ASYNC_SOURCE_TRANSACTION", 409);
  const candidates = new Map<string, string>(), observed = new Map<string, string>();
  for (const noteId of new Set(noteIds)) {
    const note = app.db.prepare("SELECT candidate_id,state FROM memory_documents WHERE note_id=?").get(noteId);
    if (!note || note.state !== "PUBLISHED") changed();
    if (!note.candidate_id) continue;
    const id = String(note.candidate_id);
    if (candidates.has(id)) continue;
    candidates.set(id, identity(candidate(app, id)));
    const page = app.db.prepare(`SELECT n.*,d.revision AS required_version,d.digest AS required_digest
      FROM memory_dependencies d JOIN memory_documents n ON n.workspace_id=d.workspace_id AND n.room_id=d.room_id
      AND n.note_id=d.resource_id WHERE d.candidate_id=? AND d.resource_type='NOTE' AND d.resource_id>?
      ORDER BY d.resource_id LIMIT ?`);
    let after = "";
    for (;;) {
      signal?.throwIfAborted();
      const rows = page.all(id, after, NOTE_VALIDATION_PAGE);
      for (const row of rows) {
        if (row.state !== "PUBLISHED" || row.version !== row.required_version || row.digest !== row.required_digest) changed();
        const path = String(row.relative_path), before = stamp(app, path);
        try { verifyCurrentNoteFile(app, row); } catch (error) {
          if (error instanceof NoteVerificationPending) throw error;
          if (error instanceof Error && "code" in error && String(error.code).startsWith("ERR_SQLITE")) throw error;
          changed();
        }
        const current = stamp(app, path);
        if (current !== before || (observed.has(path) && observed.get(path) !== current)) changed();
        observed.set(path, current);
        after = String(row.note_id);
      }
      if (rows.length < NOTE_VALIDATION_PAGE) break;
      await yieldTurn(undefined, { signal });
    }
  }
  signal?.throwIfAborted();
  // No writer lock is held here. Detect same-size edits, unlink/replacement, moved parents
  // and unsafe references after the yielded byte-validation pass.
  for (const [path, expected] of observed) if (stamp(app, path) !== expected) changed();
  for (const [id, expected] of candidates) if (identity(candidate(app, id)) !== expected) changed();
  const previous = active.get(app);
  active.set(app, candidates);
  try {
    const result = callback();
    if (result && typeof (result as { then?: unknown }).then === "function")
      throw new AppError("ASYNC_SOURCE_CALLBACK", 409);
    return result;
  } finally {
    if (previous) active.set(app, previous); else active.delete(app);
  }
}
