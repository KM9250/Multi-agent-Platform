import { AppError } from "../../shared/app-contracts/index.ts";
import type { AppDatabase } from "../app-data/db.ts";
import { digest, integer, object, string } from "../app-data/validation.ts";
import { AuthorizationPolicy, type Actor } from "../auth/authorization.ts";
import { assertSourcesCurrent, assertSourceAccess } from "./sources.ts";
import { parseMemoryMarkdown } from "./markdown.ts";
import { readVaultFile, readVersion } from "./vault.ts";

export interface NoteSummary {
  noteId: string;
  roomId: string;
  personaId: string;
  scope: string;
  relativePath: string;
  state: string;
  version: number;
  digest: string;
  trusted: boolean;
}
export interface NoteDetail extends NoteSummary {
  body: string;
  sourceRefs: unknown[];
  kind: string;
  assertionType: string;
  historical: boolean;
}
export interface DocumentRow {
  note_id: string;
  workspace_id: string;
  room_id: string;
  owner_persona_id: string;
  scope: string;
  relative_path: string;
  state: string;
  version: number;
  digest: string;
  trusted: number;
  candidate_id: string | null;
}
const missing = () => new AppError("NOT_FOUND", 404);
const summary = (r: DocumentRow): NoteSummary => ({
  noteId: r.note_id,
  roomId: r.room_id,
  personaId: r.owner_persona_id,
  scope: r.scope,
  relativePath: r.relative_path,
  state: r.state,
  version: r.version,
  digest: r.digest,
  trusted: r.trusted === 1,
});
const scope = (r: DocumentRow) => ({
  workspaceId: r.workspace_id,
  roomId: r.room_id,
  personaId: r.owner_persona_id,
  visibility: r.scope,
});

// Filter grants before LIMIT, so inaccessible notes cannot displace permitted rows on a page.
const visibleDocuments = `FROM memory_documents d JOIN rooms r ON r.room_id=d.room_id AND r.workspace_id=d.workspace_id
  JOIN personas p ON p.persona_id=d.owner_persona_id AND p.workspace_id=d.workspace_id
  WHERE r.deleted_at IS NULL AND p.deleted_at IS NULL AND d.workspace_id=?
  AND EXISTS (SELECT 1 FROM access_grants g WHERE g.workspace_id=d.workspace_id AND g.actor_id=?
    AND g.operation='READ_MEMORY' AND g.revoked_at IS NULL AND g.provider='*'
    AND g.room_id=d.room_id AND g.persona_id=d.owner_persona_id
    AND g.visibility=d.scope)`;

function lookup(
  app: AppDatabase,
  policy: AuthorizationPolicy,
  actor: Actor,
  noteId: string,
): DocumentRow {
  policy.revision(actor);
  const row = app.db
    .prepare("SELECT d.* " + visibleDocuments + " AND d.note_id=?")
    .get(
      actor.workspaceId,
      actor.actorId,
      string(noteId, 100),
    ) as unknown as DocumentRow;
  if (
    !row ||
    !policy.can(actor, "READ_ROOM", { roomId: row.room_id }) ||
    !policy.can(actor, "READ_MEMORY", scope(row))
  )
    throw missing();
  return row;
}
export function listNotes(
  app: AppDatabase,
  policy: AuthorizationPolicy,
  actor: Actor,
  roomId: string,
  options: { after?: string; onlyConflicts?: boolean } = {},
): NoteSummary[] {
  policy.assert(actor, "READ_ROOM", { roomId });
  const filter = options.onlyConflicts ? " AND d.state='CONFLICT'" : "";
  const rows = app.db
    .prepare(
      "SELECT d.* " +
        visibleDocuments +
        filter +
        " AND d.room_id=? AND d.note_id>? ORDER BY d.note_id LIMIT 200",
    )
    .all(
      actor.workspaceId,
      actor.actorId,
      roomId,
      options.after ? string(options.after, 100) : "",
    ) as unknown as DocumentRow[];
  return rows
    .filter((row) => policy.can(actor, "READ_MEMORY", scope(row)))
    .map(summary);
}

/** Only non-terminal file states can recover without another human decision. */
export function setDocumentState(
  app: AppDatabase,
  row: DocumentRow,
  state: string,
): void {
  app.db
    .prepare(
      `UPDATE memory_documents SET state=? WHERE note_id=? AND version=? AND digest=?
    AND state NOT IN ('NEEDS_REVIEW','RETRACTED') AND state<>?`,
    )
    .run(state, row.note_id, row.version, row.digest, state);
}

export function assertDocumentSources(
  app: AppDatabase,
  policy: AuthorizationPolicy,
  actor: Actor,
  row: DocumentRow,
) {
  if (row.candidate_id)
    return assertSourcesCurrent(app, policy, actor, row.candidate_id);
  const source = app.db
    .prepare(
      `SELECT 1 FROM memory_handwritten h JOIN principals p ON p.workspace_id=h.workspace_id AND p.actor_id=h.registrar_id
    WHERE h.note_id=? AND h.workspace_id=? AND p.active=1 AND NOT EXISTS (
      SELECT 1 FROM memory_handwritten_grants s JOIN access_grants g USING(grant_id)
      WHERE s.note_id=h.note_id AND g.revoked_at IS NOT NULL)`,
    )
    .get(row.note_id, actor.workspaceId);
  if (!source) throw new AppError("SOURCE_CHANGED", 409);
}

function authorizedSourceRefs(
  app: AppDatabase,
  policy: AuthorizationPolicy,
  actor: Actor,
  row: DocumentRow,
): unknown[] {
  if (!row.candidate_id) {
    const source = app.db
      .prepare(
        `SELECT original_path AS relativePath, original_digest AS digest,
      registrar_id AS registrar, registered_at AS registeredAt FROM memory_handwritten WHERE note_id=?`,
      )
      .get(row.note_id);
    return source
      ? [{ type: "handwritten", noteId: row.note_id, version: 1, ...source }]
      : [];
  }
  try {
    assertSourceAccess(app, policy, actor, row.candidate_id);
  } catch {
    return [];
  }
  const sources = app.db
    .prepare(
      `SELECT r.sources_json FROM memory_candidate_revisions r JOIN memory_jobs j
    ON j.candidate_id=r.candidate_id AND j.revision=r.revision WHERE j.note_id=?`,
    )
    .get(row.note_id);
  return sources ? JSON.parse(String(sources.sources_json)) : [];
}

export function readNote(
  app: AppDatabase,
  policy: AuthorizationPolicy,
  actor: Actor,
  noteId: string,
  version?: number,
): NoteDetail {
  // Commit any observed drift before returning the unavailable result to the caller.
  const result = app.transaction(() => {
    const row = lookup(app, policy, actor, noteId);
    let bytes: Buffer;
    if (version !== undefined) {
      const old = app.db
        .prepare("SELECT * FROM memory_versions WHERE note_id=? AND version=?")
        .get(noteId, integer(version));
      if (!old) throw missing();
      if (
        row.candidate_id &&
        ["RETRACTED", "NEEDS_REVIEW"].includes(row.state)
      ) {
        // A revoked dependency cannot be recovered as a shared current answer via a history URL.
        try {
          assertSourceAccess(app, policy, actor, row.candidate_id);
        } catch {
          throw missing();
        }
      }
      row.relative_path = String(old.relative_path);
      row.digest = String(old.digest);
      row.version = version;
      bytes = readVersion(app, row.digest);
    } else {
      if (
        row.state !== "PUBLISHED" ||
        app.db
          .prepare("SELECT incomplete FROM memory_scan_state WHERE singleton=1")
          .get()?.incomplete
      )
        return;
      try {
        assertDocumentSources(app, policy, actor, row);
      } catch {
        setDocumentState(app, row, "NEEDS_REVIEW");
        return;
      }
      try {
        bytes = readVaultFile(app, row.relative_path);
        if (digest(bytes) !== row.digest) {
          setDocumentState(app, row, "DIRTY");
          return;
        }
      } catch (error) {
        setDocumentState(
          app,
          row,
          (error as NodeJS.ErrnoException).code === "ENOENT"
            ? "DELETED"
            : "CONFLICT",
        );
        return;
      }
    }
    const doc = parseMemoryMarkdown(bytes);
    if (doc.noteId !== row.note_id) throw new AppError("MEMORY_INTEGRITY", 409);
    return {
      ...summary(row),
      body: doc.body,
      kind: doc.kind,
      assertionType: doc.assertionType,
      sourceRefs: authorizedSourceRefs(app, policy, actor, row),
      historical: version !== undefined,
    };
  });
  if (!result) throw new AppError("MEMORY_UNAVAILABLE", 409);
  return result;
}

export function listVersions(
  app: AppDatabase,
  policy: AuthorizationPolicy,
  actor: Actor,
  noteId: string,
  before?: number,
) {
  const row = lookup(app, policy, actor, noteId);
  if (row.candidate_id && ["RETRACTED", "NEEDS_REVIEW"].includes(row.state)) {
    try {
      assertSourceAccess(app, policy, actor, row.candidate_id);
    } catch {
      throw missing();
    }
  }
  return app.db
    .prepare(
      "SELECT version,digest,created_at AS recordedAt FROM memory_versions WHERE note_id=? AND version<? ORDER BY version DESC LIMIT 200",
    )
    .all(
      noteId,
      before === undefined ? Number.MAX_SAFE_INTEGER : integer(before),
    );
}
export function retractNote(
  app: AppDatabase,
  policy: AuthorizationPolicy,
  actor: Actor,
  noteId: string,
  input: unknown,
) {
  const values = object(input, [
    "expectedVersion",
    "expectedDigest",
    "requestId",
  ]);
  const version = integer(values.expectedVersion),
    expectedDigest = string(values.expectedDigest, 64),
    requestId = string(values.requestId, 128);
  return app.transaction(() => {
    const row = lookup(app, policy, actor, noteId);
    policy.assert(actor, "RETRACT_MEMORY", scope(row));
    const prior = app.db
      .prepare(
        "SELECT * FROM memory_retract_requests WHERE workspace_id=? AND actor_id=? AND request_id=?",
      )
      .get(actor.workspaceId, actor.actorId, requestId);
    if (prior) {
      if (
        prior.note_id !== noteId ||
        prior.version !== version ||
        prior.digest !== expectedDigest
      )
        throw new AppError("REQUEST_CONFLICT", 409);
    } else {
      if (
        row.version !== version ||
        row.digest !== expectedDigest ||
        row.state === "RETRACTED"
      )
        throw new AppError("REVISION_CONFLICT", 409);
      app.db
        .prepare("INSERT INTO memory_retract_requests VALUES(?,?,?,?,?,?)")
        .run(
          actor.workspaceId,
          actor.actorId,
          requestId,
          noteId,
          version,
          expectedDigest,
        );
      app.db
        .prepare(
          "UPDATE memory_documents SET state='RETRACTED' WHERE note_id=?",
        )
        .run(noteId);
      if (row.candidate_id)
        app.db
          .prepare(
            "UPDATE memory_candidates SET state='RETRACTED' WHERE candidate_id=?",
          )
          .run(row.candidate_id);
      app.audit(actor.actorId, actor.workspaceId, "RETRACT_MEMORY", noteId);
    }
    return { noteId, version, state: "RETRACTED" };
  });
}

export function setNoteTrust(
  app: AppDatabase,
  policy: AuthorizationPolicy,
  actor: Actor,
  noteId: string,
  trusted: boolean,
) {
  if (typeof trusted !== "boolean") throw new AppError("INVALID_INPUT");
  return app.transaction(() => {
    const row = lookup(app, policy, actor, noteId);
    policy.assert(actor, "MANAGE_VAULT", scope(row));
    app.db
      .prepare("UPDATE memory_documents SET trusted=? WHERE note_id=?")
      .run(Number(trusted), noteId);
    app.audit(
      actor.actorId,
      actor.workspaceId,
      "MEMORY_TRUST",
      noteId,
      trusted ? "ENABLED" : "DISABLED",
    );
  });
}
export function listNoteChanges(
  app: AppDatabase,
  policy: AuthorizationPolicy,
  actor: Actor,
  roomId: string,
  after?: string,
) {
  policy.assert(actor, "READ_ROOM", { roomId });
  const permitted = "SELECT d.note_id " + visibleDocuments + " AND d.room_id=?";
  const args = [actor.workspaceId, actor.actorId, roomId];
  let seq = 0;
  if (after) {
    const cursor = app.db
      .prepare(
        `SELECT seq FROM memory_changes WHERE change_id=? AND note_id IN (${permitted})`,
      )
      .get(string(after, 64), ...args);
    if (!cursor) throw new AppError("INVALID_CURSOR", 400);
    seq = Number(cursor.seq);
  }
  return app.db
    .prepare(
      `SELECT change_id AS changeId,note_id AS noteId,version,state,action FROM memory_changes
    WHERE seq>? AND note_id IN (${permitted}) ORDER BY seq LIMIT 200`,
    )
    .all(seq, ...args);
}

export { lookup as lookupNote };
