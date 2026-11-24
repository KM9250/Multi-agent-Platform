import { createHmac, timingSafeEqual } from "node:crypto";
import type { StatementSync } from "node:sqlite";
import { AppError } from "../../shared/app-contracts/index.ts";
import type {
  ArchiveRef,
  ArchiveSourceReader,
  CitationResolver,
  MemoryRef,
  MemorySourceReader,
  ResolvedExcerpt,
  SearchCitation,
  SearchSource,
  SearchTarget,
  SourcePage,
  SourceRef,
} from "../../shared/search-sources.ts";
import type { AppDatabase } from "../app-data/db.ts";
import { digest, integer, object, string } from "../app-data/validation.ts";
import type { Actor, AuthorizationPolicy } from "../auth/authorization.ts";
import {
  listNoteChanges,
  readNote,
  visibleMemoryDocuments,
} from "../memory/notes.ts";

const PAGE = 32;
// Rowid windows bound a page's original-store work even in a sparse actor/room partition.
// Force the rowid range scan only for this path. Other paths use the point/message indexes.
const BASELINE_WINDOW = 2048;
const missing = () => new AppError("NOT_FOUND", 404);
const changed = () => new AppError("SOURCE_CHANGED", 409);
const resync = () => new AppError("SEARCH_RESYNC_REQUIRED", 409);

interface SegmentRow {
  rid: number;
  seq: number;
  message_id: string;
  revision: number;
  revision_id: string;
  current_revision: number;
  segment_id: string;
  owner_persona_id: string | null;
  persona_id: string | null;
  role: string;
  channel: string;
  visibility: string;
  digest: string;
  occurred_at: number;
  content?: string;
}

const segmentColumns = `s.rowid AS rid,s.message_id,s.segment_id,s.revision,s.owner_persona_id,
  s.visibility,s.channel,s.digest,v.revision_id,m.seq,m.current_revision,m.role,m.persona_id,m.occurred_at`;
const liveSegments = (
  rowidWindow: boolean,
) => `FROM message_segments s ${rowidWindow ? "NOT INDEXED CROSS JOIN" : "JOIN"} messages m USING(workspace_id,room_id,message_id)
  JOIN message_revisions v USING(workspace_id,room_id,message_id,revision)
  WHERE s.workspace_id=? AND s.room_id=? AND m.deleted_at IS NULL
  AND (m.persona_id IS NULL OR EXISTS(SELECT 1 FROM personas p WHERE p.workspace_id=m.workspace_id
    AND p.persona_id=m.persona_id AND p.deleted_at IS NULL))
  AND (s.owner_persona_id IS NULL OR EXISTS(SELECT 1 FROM personas p WHERE p.workspace_id=s.workspace_id
    AND p.persona_id=s.owner_persona_id AND p.deleted_at IS NULL))`;
// READ_ROOM and room-wide READ_CONVERSATION are asserted independently. Private grants are
// exact (including their owner and visibility). Apply this predicate before page and context LIMITs.
const permittedSegments = (rowidWindow = false) => `${liveSegments(rowidWindow)}
  AND ((s.visibility='public' AND s.channel IN ('public_message','shared_summary')) OR
  EXISTS(SELECT 1 FROM access_grants g WHERE g.workspace_id=s.workspace_id AND g.actor_id=?
    AND g.operation='READ_PRIVATE_SEGMENT' AND g.revoked_at IS NULL AND g.room_id=s.room_id
    AND g.persona_id=s.owner_persona_id AND g.visibility=s.visibility AND g.provider IN ('*','')))
  AND EXISTS(SELECT 1 FROM access_grants g WHERE g.workspace_id=s.workspace_id AND g.actor_id=?3
    AND g.operation='READ_CONVERSATION' AND g.revoked_at IS NULL AND g.provider IN ('*','')
    AND g.room_id IN ('*',s.room_id) AND g.persona_id IN ('*',COALESCE(s.owner_persona_id,m.persona_id,''))
    AND g.visibility IN ('*',s.visibility))`;

interface ArchivePosition {
  mode: "baseline" | "delta";
  change: number; // last fully applied event; never returned to the browser
  cutoff: number; // fixed until the delta window completes
  highRow: number; // upper segment rowid pinned with each window's event cutoff
  row: number; // baseline rowid continuation
  afterRevision?: number;
  afterSegment?: string; // keyset continuation inside a single message replacement
}
const initialDelta = (change: number): ArchivePosition => ({
  mode: "delta",
  change,
  cutoff: change,
  highRow: 0,
  row: 0,
});

export function isSourceBoundary(text: string, offset: number) {
  return !(
    offset > 0 &&
    offset < text.length &&
    text.charCodeAt(offset) >= 0xdc00 &&
    text.charCodeAt(offset) <= 0xdfff &&
    text.charCodeAt(offset - 1) >= 0xd800 &&
    text.charCodeAt(offset - 1) <= 0xdbff
  );
}

function excerpt(
  source: SearchSource,
  start: number,
  end: number,
): ResolvedExcerpt {
  if (
    start < 0 ||
    end <= start ||
    end > source.text.length ||
    !isSourceBoundary(source.text, start) ||
    !isSourceBoundary(source.text, end)
  )
    throw new AppError("INVALID_CITATION_RANGE", 400);
  const {
    recordedAt,
    current,
    role,
    channel,
    visibility,
    personaId,
    speakerId,
  } = source;
  return {
    citation: { ...source.ref, start, end },
    text: source.text.slice(start, end),
    recordedAt,
    current,
    role,
    channel,
    visibility,
    personaId,
    speakerId,
  };
}

/** Validate the closed external DTO before treating any identifier as a database key. */
export function parseCitation(value: unknown): SearchCitation {
  const common = ["workspaceId", "roomId", "target", "version", "start", "end"];
  const type = (value as Partial<SearchCitation> | null)?.target;
  const extra =
    type === "memory"
      ? ["noteId", "fileDigest", "bodyDigest"]
      : type === "archive"
        ? ["messageId", "revisionId", "segmentId", "segmentDigest"]
        : [];
  const x = object(value, [...common, ...extra]);
  if (!extra.length) throw new AppError("INVALID_INPUT");
  for (const key of ["workspaceId", "roomId", ...extra]) {
    const v = string(x[key], 128);
    if (key.endsWith("Digest") && !/^[a-f0-9]{64}$/.test(v))
      throw new AppError("INVALID_INPUT");
  }
  integer(x.version);
  integer(x.start, 0);
  integer(x.end, x.start + 1);
  if (x.end - x.start > 4096) throw new AppError("INVALID_CITATION_RANGE", 400);
  return x as SearchCitation;
}

/** Bound exclusively by the server/worker's authenticated actor and single room. */
export class SearchSources
  implements MemorySourceReader, ArchiveSourceReader, CitationResolver
{
  private statements = new Map<string, StatementSync>();
  private candidateSnapshot?: {
    target: SearchTarget;
    scopes: Map<string, boolean>;
  };

  constructor(
    readonly app: AppDatabase,
    readonly policy: AuthorizationPolicy,
    readonly actor: Actor,
    readonly roomId: string,
  ) {}

  private statement(sql: string) {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.app.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  assertRoom(target: SearchTarget) {
    this.policy.assert(this.actor, "READ_ROOM", { roomId: this.roomId });
    if (
      !this.statement(
        `SELECT 1 FROM rooms r WHERE workspace_id=? AND room_id=? AND deleted_at IS NULL
      AND (import_batch_id IS NULL OR EXISTS(SELECT 1 FROM import_batches b WHERE b.workspace_id=r.workspace_id
      AND b.batch_id=r.import_batch_id AND b.status='COMPLETE'))`,
      ).get(this.actor.workspaceId, this.roomId)
    )
      throw missing();
    if (target === "archive")
      this.policy.assert(this.actor, "READ_CONVERSATION", {
        roomId: this.roomId,
      });
  }

  /**
   * Pin the authorized originals for one synchronous candidate scan. Grants may be memoized
   * only within this read transaction. Dispatch, result delivery and citation opening use
   * independent checks against the live database.
   */
  withCandidateSnapshot<T>(target: SearchTarget, select: () => T): T {
    if (this.candidateSnapshot) throw new AppError("SEARCH_SNAPSHOT_NESTED");
    return this.withReadSnapshot(() => {
      this.assertRoom(target);
      this.candidateSnapshot = { target, scopes: new Map() };
      try {
        return select();
      } finally {
        this.candidateSnapshot = undefined;
      }
    });
  }

  private withReadSnapshot<T>(read: () => T): T {
    const ownsTransaction = !this.app.db.isTransaction;
    if (ownsTransaction) this.app.db.exec("BEGIN DEFERRED");
    try {
      const operational = this.statement(
        "SELECT maintenance,restored FROM app_operational_state WHERE singleton=1",
      ).get();
      if (operational?.maintenance !== 0 || operational.restored !== 0)
        throw new AppError("MAINTENANCE", 503);
      const result = read();
      if (result && typeof (result as { then?: unknown }).then === "function")
        throw new AppError("ASYNC_TRANSACTION");
      return result;
    } finally {
      if (ownsTransaction) this.app.db.exec("ROLLBACK");
    }
  }

  allowsScope(
    target: SearchTarget,
    personaId: string | null,
    visibility: string,
    channel: string,
  ) {
    const cache =
      this.candidateSnapshot?.target === target
        ? this.candidateSnapshot.scopes
        : undefined;
    const key = JSON.stringify([personaId, visibility, channel]);
    if (cache?.has(key)) return cache.get(key)!;
    const scope = {
      workspaceId: this.actor.workspaceId,
      roomId: this.roomId,
      personaId: personaId ?? "",
      visibility,
    };
    const allowed =
      target === "memory"
        ? this.policy.can(this.actor, "READ_MEMORY", scope)
        : this.policy.canReadSegment(this.actor, { ...scope, channel });
    if (cache && cache.size < 1024) cache.set(key, allowed);
    return allowed;
  }

  private noteMeta(noteId: string) {
    return this.statement(
      `WITH visible AS (SELECT d.* ${visibleMemoryDocuments}
        AND d.room_id=? AND d.note_id=? AND d.state='PUBLISHED')
       SELECT d.owner_persona_id,d.scope,d.version,d.digest,v.body_digest,v.created_at
       FROM visible d JOIN memory_versions v ON v.note_id=d.note_id AND v.version=d.version
       WHERE v.digest=d.digest AND v.body_digest=d.body_digest
       AND NOT EXISTS(SELECT 1 FROM memory_scan_state WHERE incomplete=1)`,
    ).get(this.actor.workspaceId, this.actor.actorId, this.roomId, noteId);
  }

  private readMemory(noteId: string): SearchSource {
    const meta = this.noteMeta(noteId);
    if (!meta) throw missing();
    // Only readNote may accept a live file. The historical readNote overload bypasses the live-file check.
    const note = readNote(this.app, this.policy, this.actor, noteId);
    if (
      note.roomId !== this.roomId ||
      meta.version !== note.version ||
      meta.digest !== note.digest ||
      meta.body_digest !== digest(note.body)
    )
      throw changed();
    const ref: MemoryRef = {
      target: "memory",
      workspaceId: this.actor.workspaceId,
      roomId: this.roomId,
      version: note.version,
      noteId,
      fileDigest: note.digest,
      bodyDigest: String(meta.body_digest),
    };
    return {
      ...ref,
      ref,
      sourceId: noteId,
      groupId: noteId,
      text: note.body,
      personaId: note.personaId,
      speakerId: null,
      visibility: note.scope,
      channel: "note",
      role: "note",
      recordedAt: Number(meta.created_at),
      current: true,
    };
  }

  private segmentRef(row: SegmentRow): ArchiveRef {
    return {
      target: "archive",
      workspaceId: this.actor.workspaceId,
      roomId: this.roomId,
      messageId: row.message_id,
      revisionId: row.revision_id,
      version: row.revision,
      segmentId: row.segment_id,
      segmentDigest: row.digest,
    };
  }

  private archiveSource(row: SegmentRow): SearchSource {
    const ref = this.segmentRef(row);
    if (
      typeof row.content !== "string" ||
      digest(row.content) !== ref.segmentDigest
    )
      throw new AppError("SEARCH_SOURCE_INTEGRITY", 409);
    return {
      ...ref,
      ref,
      sourceId: row.segment_id,
      groupId: row.message_id,
      text: row.content,
      personaId: row.owner_persona_id ?? row.persona_id,
      speakerId: row.persona_id,
      visibility: row.visibility,
      channel: row.channel,
      role: row.role,
      recordedAt: row.occurred_at,
      current: row.current_revision === row.revision,
    };
  }

  private segment(segmentId: string, body: boolean) {
    return this.statement(
      `SELECT ${segmentColumns}${body ? ",s.content" : ""} ${permittedSegments()}
      AND s.segment_id=?`,
    ).get(
      this.actor.workspaceId,
      this.roomId,
      this.actor.actorId,
      segmentId,
    ) as unknown as SegmentRow | undefined;
  }

  private validSegment(
    row: SegmentRow,
    ref: ArchiveRef,
    includeHistory: boolean,
  ) {
    return (
      row.message_id === ref.messageId &&
      row.revision === ref.version &&
      row.revision_id === ref.revisionId &&
      row.digest === ref.segmentDigest &&
      (includeHistory || row.revision === row.current_revision)
    );
  }

  /** Live authorization & metadata filter for candidate selection, before either backend's top K. */
  eligible(ref: SourceRef, includeHistory = false): boolean {
    if (
      !ref ||
      ref.workspaceId !== this.actor.workspaceId ||
      ref.roomId !== this.roomId
    )
      return false;
    if (this.candidateSnapshot?.target !== ref.target)
      this.assertRoom(ref.target);
    if (ref.target === "memory") {
      const row = this.noteMeta(ref.noteId);
      return (
        !!row &&
        row.version === ref.version &&
        row.digest === ref.fileDigest &&
        row.body_digest === ref.bodyDigest &&
        this.allowsScope(
          "memory",
          String(row.owner_persona_id),
          String(row.scope),
          "note",
        )
      );
    }
    if (ref.target !== "archive") return false;
    const row = this.segment(ref.segmentId, false);
    return !!row && this.validSegment(row, ref, includeHistory);
  }

  read(ref: SourceRef, includeHistory = false): SearchSource {
    this.assertRoom(ref.target);
    if (
      ref.workspaceId !== this.actor.workspaceId ||
      ref.roomId !== this.roomId
    )
      throw missing();
    if (ref.target === "memory") {
      const source = this.readMemory(ref.noteId);
      const live = source.ref as MemoryRef;
      if (
        live.version !== ref.version ||
        live.fileDigest !== ref.fileDigest ||
        live.bodyDigest !== ref.bodyDigest
      )
        throw changed();
      return source;
    }
    const row = this.segment(ref.segmentId, true);
    if (!row) throw missing();
    if (!this.validSegment(row, ref, includeHistory)) throw changed();
    return this.archiveSource(row);
  }

  resolve(
    citation: SearchCitation,
    options: { includeHistory?: boolean; surrounding?: number } = {},
  ) {
    const ref = parseCitation(citation);
    const acl = this.policy.revision(this.actor);
    const read = () => this.resolveOriginal(ref, options);
    // One canonical snapshot covers the selected segment and every neighbor. A Memory
    // read uses readNote's own write transaction to record any observed live-file drift.
    const result =
      ref.target === "archive" ? this.withReadSnapshot(read) : read();
    if (this.policy.revision(this.actor) !== acl) throw resync();
    this.assertRoom(ref.target);
    return result;
  }

  private resolveOriginal(
    ref: SearchCitation,
    options: { includeHistory?: boolean; surrounding?: number },
  ) {
    const source = this.read(ref, options.includeHistory === true);
    const surrounding: ResolvedExcerpt[] = [];
    const count = integer(options.surrounding ?? 0, 0, 4);
    if (count && ref.target === "archive") {
      // Current neighboring statements only. Filter in SQL, then authorize each returned segment again.
      const seq = this.segment(ref.segmentId, false)?.seq;
      if (seq === undefined) throw missing();
      for (const before of [true, false]) {
        const order = before ? "DESC" : "ASC";
        const rows = this.statement(
          `SELECT ${segmentColumns} ${permittedSegments()}
          AND s.message_id IN (SELECT message_id FROM messages WHERE workspace_id=?1
            AND room_id=?2 AND seq BETWEEN ? AND ?)
          AND s.revision=m.current_revision AND length(s.content)>0
          ORDER BY m.seq ${order},s.rowid ${order} LIMIT ?`,
        ).all(
          this.actor.workspaceId,
          this.roomId,
          this.actor.actorId,
          before ? Math.max(seq - count, 0) : seq + 1,
          before ? seq - 1 : seq + count,
          count,
        ) as unknown as SegmentRow[];
        if (before) rows.reverse();
        for (const row of rows) {
          const neighbor = this.read(this.segmentRef(row));
          let end = Math.min(neighbor.text.length, 1024);
          if (!isSourceBoundary(neighbor.text, end)) end--;
          if (end > 0) surrounding.push(excerpt(neighbor, 0, end));
        }
      }
    }
    return { ...excerpt(source, ref.start, ref.end), surrounding };
  }

  memoryPage(after?: string): SourcePage {
    this.assertRoom("memory");
    const { mode, cursor, hasMore, items } = listNoteChanges(
      this.app,
      this.policy,
      this.actor,
      this.roomId,
      after,
      PAGE,
    );
    const notes = new Map(items.map((item) => [item.noteId, item]));
    const upserts: SearchSource[] = [];
    for (const item of notes.values()) {
      if (item.state !== "PUBLISHED") continue;
      try {
        const source = this.readMemory(item.noteId);
        if (
          source.version === item.version &&
          (source.ref as MemoryRef).fileDigest === item.digest
        )
          upserts.push(source);
      } catch (error) {
        // Stale/removed after the feed's cutoff. Commit the tombstone; future changes arrive through delta.
        if (
          !(
            error instanceof AppError &&
            ["NOT_FOUND", "SOURCE_CHANGED", "MEMORY_UNAVAILABLE"].includes(
              error.code,
            )
          )
        )
          throw error;
      }
    }
    return { mode, cursor, hasMore, deletes: [...notes.keys()], upserts };
  }

  private cursorMac(data: string, acl: number) {
    return createHmac("sha256", this.app.cursorKey)
      .update(
        JSON.stringify([
          "MAP:ARCHIVE:1",
          this.actor.workspaceId,
          this.actor.actorId,
          this.roomId,
          acl,
          data,
        ]),
      )
      .digest("hex");
  }

  private unpack(cursor: string, acl: number): ArchivePosition {
    if (typeof cursor !== "string" || cursor.length > 512) throw resync();
    const [mac, data] = cursor.split(".");
    if (
      !/^[a-f0-9]{64}$/.test(mac) ||
      !data ||
      !timingSafeEqual(Buffer.from(mac), Buffer.from(this.cursorMac(data, acl)))
    )
      throw resync();
    const pos = JSON.parse(
      Buffer.from(data, "base64url").toString(),
    ) as ArchivePosition;
    return pos;
  }

  /** An internal bounded read on one SQLite snapshot. Cursors never cross the browser/API boundary. */
  archivePage(after?: string): SourcePage {
    return this.withReadSnapshot(() => {
      this.assertRoom("memory");
      const acl = this.policy.revision(this.actor);
      const latest = Number(
        this.statement(
          "SELECT COALESCE(MAX(change_id),0) AS n FROM app_changes",
        ).get()!.n,
      );
      const pos: ArchivePosition =
        after === undefined
          ? {
              mode: "baseline",
              change: latest,
              cutoff: latest,
              row: 0,
              highRow: Number(
                this.statement(
                  "SELECT COALESCE(MAX(rowid),0) AS n FROM message_segments",
                ).get()!.n,
              ),
            }
          : this.unpack(after, acl);
      if (pos.cutoff > latest) throw resync();
      const mode = pos.mode;
      let next = pos;
      const upserts: SearchSource[] = [];
      const deletes: string[] = [];
      let hasMore = false;
      if (
        !this.policy.can(this.actor, "READ_CONVERSATION", {
          roomId: this.roomId,
        })
      ) {
        next = initialDelta(latest);
      } else if (mode === "baseline") {
        const windowEnd = Math.min(pos.highRow, pos.row + BASELINE_WINDOW);
        const rows = this.statement(
          `SELECT ${segmentColumns},s.content ${permittedSegments(true)}
          AND s.rowid>? AND s.rowid<=? ORDER BY s.rowid LIMIT ?`,
        ).all(
          this.actor.workspaceId,
          this.roomId,
          this.actor.actorId,
          pos.row,
          windowEnd,
          PAGE + 1,
        ) as unknown as SegmentRow[];
        upserts.push(
          ...rows.slice(0, PAGE).map((row) => this.archiveSource(row)),
        );
        const row = rows.length > PAGE ? rows[PAGE - 1].rid : windowEnd;
        hasMore = row < pos.highRow;
        next = hasMore ? { ...pos, row } : initialDelta(pos.cutoff);
      } else {
        if (pos.change === pos.cutoff) {
          pos.cutoff = latest;
          pos.highRow = Number(
            this.statement(
              "SELECT COALESCE(MAX(rowid),0) AS n FROM message_segments",
            ).get()!.n,
          );
        }
        const eventEnd = Math.min(pos.cutoff, pos.change + BASELINE_WINDOW);
        const events = this.statement(
          `SELECT change_id,target_id,target_type,action FROM app_changes
          WHERE change_id>? AND change_id<=? AND workspace_id=? AND
          ((room_id=? AND target_type='MESSAGE') OR (target_type='PERSONA' AND action='DELETE'))
          ORDER BY change_id LIMIT ?`,
        ).all(
          pos.change,
          eventEnd,
          this.actor.workspaceId,
          this.roomId,
          PAGE + 1,
        );
        for (const event of events) {
          if (upserts.length >= PAGE || deletes.length >= PAGE) {
            hasMore = true;
            break;
          }
          // Persona soft deletion is workspace-wide. Existing sources may be owned/spoken by it.
          if (event.target_type === "PERSONA") throw resync();
          const messageId = String(event.target_id);
          const remaining = PAGE - upserts.length;
          if (next.afterSegment === undefined) deletes.push(messageId); // Independent of source readability.
          const rows =
            event.action === "DELETE"
              ? []
              : (this.statement(
                  `SELECT ${segmentColumns},s.content ${permittedSegments()}
              AND s.message_id=? AND (s.revision,s.segment_id)>(?,?) AND s.rowid<=?
              ORDER BY s.revision,s.segment_id LIMIT ?`,
                ).all(
                  this.actor.workspaceId,
                  this.roomId,
                  this.actor.actorId,
                  messageId,
                  next.afterRevision ?? 0,
                  next.afterSegment ?? "",
                  pos.highRow,
                  remaining + 1,
                ) as unknown as SegmentRow[]);
          upserts.push(
            ...rows.slice(0, remaining).map((row) => this.archiveSource(row)),
          );
          if (rows.length > remaining) {
            const last = rows[remaining - 1];
            next = {
              ...next,
              afterRevision: last.revision,
              afterSegment: last.segment_id,
            };
            hasMore = true;
            break;
          }
          next = {
            ...pos,
            change: Number(event.change_id),
            afterRevision: undefined,
            afterSegment: undefined,
          };
        }
        if (!hasMore && eventEnd < pos.cutoff) {
          hasMore = true;
          next = {
            ...pos,
            change: eventEnd,
            afterRevision: undefined,
            afterSegment: undefined,
          };
        } else if (!hasMore) next = initialDelta(pos.cutoff);
      }
      const data = Buffer.from(JSON.stringify(next)).toString("base64url");
      return {
        mode,
        cursor: this.cursorMac(data, acl) + "." + data,
        hasMore,
        deletes,
        upserts,
      };
    });
  }
}
