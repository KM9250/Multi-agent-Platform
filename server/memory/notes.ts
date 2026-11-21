import { AppError } from "../../shared/app-contracts/index.ts";
import type {
  MemoryChangeItem,
  MemoryChangePage,
} from "../../shared/memory-contracts.ts";
import type { AppDatabase } from "../app-data/db.ts";
import {
  canonical,
  digest,
  integer,
  object,
  string,
} from "../app-data/validation.ts";
import { AuthorizationPolicy, type Actor } from "../auth/authorization.ts";
import { assertSourcesCurrent, assertSourceAccess } from "./sources.ts";
import {
  openChangeCursor,
  sealChangeCursor,
  resyncRequired,
} from "./change-cursor.ts";
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

/** Check the editable file from the same DB writer that records its state. External writes are never performed here. */
function currentDocument(
  app: AppDatabase,
  policy: AuthorizationPolicy,
  actor: Actor,
  row: DocumentRow,
) {
  if (
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
    const bytes = readVaultFile(app, row.relative_path);
    const doc = parseMemoryMarkdown(bytes);
    if (doc.noteId !== row.note_id) {
      setDocumentState(app, row, "CONFLICT");
      return;
    }
    if (digest(bytes) !== row.digest) {
      setDocumentState(app, row, "DIRTY");
      return;
    }
    return doc;
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
    let doc: ReturnType<typeof parseMemoryMarkdown>;
    if (version !== undefined) {
      const old = app.db
        .prepare("SELECT * FROM memory_versions WHERE note_id=? AND version=?")
        .get(noteId, integer(version));
      if (!old) throw missing();
      if (
        row.candidate_id &&
        ["RETRACTED", "NEEDS_REVIEW", "LINEAGE_PENDING"].includes(row.state)
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
      doc = parseMemoryMarkdown(readVersion(app, row.digest));
    } else {
      if (row.state !== "PUBLISHED") return;
      doc = currentDocument(app, policy, actor, row);
      if (!doc) return;
    }
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
  if (
    row.candidate_id &&
    ["RETRACTED", "NEEDS_REVIEW", "LINEAGE_PENDING"].includes(row.state)
  ) {
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
    "expectedState",
    "requestId",
  ]);
  const version = integer(values.expectedVersion),
    expectedDigest = string(values.expectedDigest, 64),
    expectedState =
      values.expectedState === undefined
        ? "PUBLISHED"
        : string(values.expectedState, 32),
    requestId = string(values.requestId, 128);
  if (
    ![
      "PUBLISHED",
      "DELETED",
      "DIRTY",
      "CONFLICT",
      "LINEAGE_PENDING",
      "NEEDS_REVIEW",
    ].includes(expectedState)
  )
    throw new AppError("INVALID_INPUT");
  const requestDigest = digest(
    canonical({ noteId, version, expectedDigest, expectedState }),
  );
  const result = app.transaction(() => {
    const row = lookup(app, policy, actor, noteId);
    policy.assert(actor, "RETRACT_MEMORY", scope(row));
    const actorKey = [actor.workspaceId, actor.actorId];
    const prior = app.db
      .prepare(
        "SELECT * FROM memory_retract_requests WHERE workspace_id=? AND actor_id=? AND request_id=?",
      )
      .get(...actorKey, requestId);
    // Older successful receipts did not capture the displayed state. New receipts keep that
    // binding in the existing request ledger without changing the schema or its backup catalogue.
    const ledgerId = "note-retract/" + requestId;
    if (prior) {
      const binding = app.db
        .prepare(
          "SELECT request_digest FROM memory_requests WHERE workspace_id=? AND actor_id=? AND request_id=?",
        )
        .get(...actorKey, ledgerId);
      if (
        prior.note_id !== noteId ||
        prior.version !== version ||
        prior.digest !== expectedDigest ||
        (binding
          ? binding.request_digest !== requestDigest
          : expectedState !== "PUBLISHED")
      )
        throw new AppError("REQUEST_CONFLICT", 409);
    } else {
      if (
        row.version !== version ||
        row.digest !== expectedDigest ||
        row.state !== expectedState
      )
        throw new AppError("REVISION_CONFLICT", 409);
      // Explicit withdrawal of an already unavailable registration leaves the editable file intact.
      // A view of published bytes can only withdraw those same bytes at the live path.
      if (
        expectedState === "PUBLISHED" &&
        !currentDocument(app, policy, actor, row)
      )
        return;
      app.db
        .prepare("INSERT INTO memory_retract_requests VALUES(?,?,?,?,?,?)")
        .run(...actorKey, requestId, noteId, version, expectedDigest);
      app.db
        .prepare(
          "INSERT INTO memory_requests(workspace_id,actor_id,room_id,request_id,request_digest,result_ids_json,created_at) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          ...actorKey,
          row.room_id,
          ledgerId,
          requestDigest,
          JSON.stringify([noteId]),
          Date.now(),
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
  // Commit the observed DIRTY/DELETED/CONFLICT before surfacing a stale-view conflict.
  if (!result) throw new AppError("REVISION_CONFLICT", 409);
  return result;
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
): MemoryChangePage {
  return app.transaction(() => {
    policy.assert(actor, "READ_ROOM", { roomId });
    // Persona/Room deletion can remove visible notes without changing the workspace ACL revision.
    const grants = app.db
      .prepare(
        `
      SELECT DISTINCT g.persona_id, g.visibility FROM access_grants g
      JOIN rooms r USING(workspace_id,room_id) JOIN personas p USING(workspace_id,persona_id)
      WHERE g.workspace_id=? AND g.actor_id=? AND g.room_id=? AND g.operation='READ_MEMORY'
      AND g.revoked_at IS NULL AND g.provider='*' AND p.deleted_at IS NULL AND r.deleted_at IS NULL
      ORDER BY g.persona_id,g.visibility`,
      )
      .all(actor.workspaceId, actor.actorId, roomId);
    const context = Buffer.from(
      JSON.stringify([
        "MAP:MEMORY:CHANGES:1",
        actor.workspaceId,
        actor.actorId,
        roomId,
        policy.revision(actor),
        grants,
      ]),
    );
    const latest = Number(
      app.db
        .prepare("SELECT COALESCE(MAX(seq),0) AS n FROM memory_changes")
        .get()!.n,
    );
    const page =
      after === undefined
        ? { mode: "baseline" as const, position: 0, cutoff: latest }
        : openChangeCursor(app.cursorKey, context, after);
    if (page.cutoff > latest) resyncRequired();
    // A completed page's checkpoint starts the next finite delta window. An in-progress page
    // retains its original cutoff even as new files are published between HTTP requests.
    const cutoff =
      page.mode === "delta" && page.position === page.cutoff
        ? latest
        : page.cutoff;
    const baseline = page.mode === "baseline";
    const permitted =
      "SELECT d.note_id " + visibleDocuments + " AND d.room_id=?";
    // Reconstruct each visible note's last event *at* the cutoff. Reading the live table in
    // pages would lose updates across the handoff between baseline and deltas.
    const fields =
      "c.seq,c.change_id AS changeId,c.note_id AS noteId,c.version,v.digest,c.state";
    const versionJoin =
      "LEFT JOIN memory_versions v ON v.note_id=c.note_id AND v.version=c.version";
    const args = [actor.workspaceId, actor.actorId, roomId];
    const rows = (baseline
      ? app.db
          .prepare(
            `
        WITH allowed AS (${permitted} AND d.note_id>COALESCE((SELECT note_id FROM memory_changes WHERE seq=?),''))
        SELECT ${fields},'BASELINE' AS action FROM allowed a
        JOIN memory_changes c ON c.seq=(SELECT MAX(h.seq) FROM memory_changes h WHERE h.note_id=a.note_id AND h.seq<=?)
        ${versionJoin} ORDER BY a.note_id LIMIT 201`,
          )
          .all(...args, page.position, cutoff)
      : app.db
          .prepare(
            `
        SELECT ${fields},c.action FROM memory_changes c ${versionJoin}
        WHERE c.seq>? AND c.seq<=? AND c.note_id IN (${permitted}) ORDER BY c.seq LIMIT 201`,
          )
          .all(page.position, cutoff, ...args)) as unknown as Array<
      MemoryChangeItem & { seq: number }
    >;
    const hasMore = rows.length > 200;
    const items = rows.slice(0, 200).map(({ seq, ...item }) => {
      if (typeof item.digest !== "string")
        throw new AppError("MEMORY_INTEGRITY", 409);
      return item;
    });
    const next = {
      mode: hasMore ? page.mode : ("delta" as const),
      position: hasMore ? Number(rows[199].seq) : cutoff,
      cutoff,
    };
    return {
      mode: page.mode,
      items,
      hasMore,
      cursor: sealChangeCursor(app.cursorKey, context, next),
    };
  }, "memory_change_feed");
}

export { lookup as lookupNote };
