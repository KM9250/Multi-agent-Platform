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
  memoryChangeContext,
  readNote,
  visibleMemoryDocuments,
} from "../memory/notes.ts";

import { openChangeCursor } from "../memory/change-cursor.ts";
import { withVerifiedNoteAncestors } from "../memory/source-validation.ts";
import { parseCitation } from "./citation.ts";
export { parseCitation } from "./citation.ts";
import { assertAiSearchBinding, type AiSearchBinding } from "./ai-binding.ts";

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
  reason: string;
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
  s.visibility,s.channel,s.digest,v.revision_id,v.reason,m.seq,m.current_revision,m.role,m.persona_id,m.occurred_at`;
const liveSegments = (
  rowidWindow: boolean,
  includeDeletedMessage: boolean,
) => `FROM message_segments s ${rowidWindow ? "NOT INDEXED CROSS JOIN" : "JOIN"} messages m USING(workspace_id,room_id,message_id)
  JOIN message_revisions v USING(workspace_id,room_id,message_id,revision)
  WHERE s.workspace_id=?1 AND s.room_id=?2 ${includeDeletedMessage ? "" : "AND m.deleted_at IS NULL"}
  AND (m.persona_id IS NULL OR EXISTS(SELECT 1 FROM personas p WHERE p.workspace_id=m.workspace_id
    AND p.persona_id=m.persona_id AND p.deleted_at IS NULL))
  AND (s.owner_persona_id IS NULL OR EXISTS(SELECT 1 FROM personas p WHERE p.workspace_id=s.workspace_id
    AND p.persona_id=s.owner_persona_id AND p.deleted_at IS NULL))`;
// READ_ROOM and room-wide READ_CONVERSATION are asserted independently. Private grants are
// exact (including their owner and visibility). Apply this predicate before page and context LIMITs.
const permittedSegments = (
  rowidWindow = false,
  includeDeletedMessage = false,
) => `${liveSegments(rowidWindow, includeDeletedMessage)}
  AND ((s.visibility='public' AND s.channel IN ('public_message','shared_summary')) OR
  EXISTS(SELECT 1 FROM access_grants g WHERE g.workspace_id=s.workspace_id AND g.actor_id=?3
    AND g.operation='READ_PRIVATE_SEGMENT' AND g.revoked_at IS NULL AND g.room_id=s.room_id
    AND g.persona_id=s.owner_persona_id AND g.visibility=s.visibility AND g.provider IN ('*','')))
  AND EXISTS(SELECT 1 FROM access_grants g WHERE g.workspace_id=s.workspace_id AND g.actor_id=?3
    AND g.operation='READ_CONVERSATION' AND g.revoked_at IS NULL AND g.provider IN ('*','')
    AND g.room_id IN ('*',s.room_id) AND g.persona_id IN ('*',COALESCE(s.owner_persona_id,m.persona_id,''))
    AND g.visibility IN ('*',s.visibility))`;

// These read the actor's current permissions on the same App DB snapshot as the cursor.
export const MEMORY_FRESHNESS_SQL = `SELECT 1 ${visibleMemoryDocuments} AND d.room_id=?
  AND EXISTS (SELECT 1 FROM memory_changes h WHERE h.note_id=d.note_id AND h.seq>?)
  LIMIT 1`;
// A correction can remove a previously visible segment. A deletion removes every revision.
// Separate lookups preserve the revision index for the ordinary creation/correction case.
const affectedSegment = `SELECT 1 ${permittedSegments(false, true)} AND s.message_id=e.target_id`;
export const ARCHIVE_FRESHNESS_SQL = `SELECT 1 FROM app_changes e INDEXED BY search_message_changes
  WHERE e.workspace_id=?1 AND e.room_id=?2 AND e.target_type='MESSAGE' AND e.change_id>?4
  AND CASE WHEN e.action='DELETE' THEN EXISTS (${affectedSegment})
    ELSE EXISTS (${affectedSegment} AND s.revision IN (e.revision,e.revision-1)) END
  UNION ALL
  SELECT 1 FROM room_personas rp WHERE rp.workspace_id=?1 AND rp.room_id=?2
  AND EXISTS (SELECT 1 FROM app_changes e INDEXED BY search_persona_deletions
    WHERE e.workspace_id=rp.workspace_id AND e.target_id=rp.persona_id
    AND e.target_type='PERSONA' AND e.action='DELETE' AND e.change_id>?4)
  LIMIT 1`;

// Bound to the accepted user seq, with public-only predicates before event/neighbor limits.
// The previous revision is examined only to notice a public source removed by a correction.
const aiAffectedSegment = `SELECT 1 ${permittedSegments(false, true)}
  AND s.message_id=e.target_id AND s.visibility='public'
  AND s.channel IN ('public_message','shared_summary') AND m.seq<=?5 AND m.message_id<>?6`;
export const AI_ARCHIVE_FRESHNESS_SQL = `SELECT 1 FROM app_changes e INDEXED BY search_message_changes
  WHERE e.workspace_id=?1 AND e.room_id=?2 AND e.target_type='MESSAGE' AND e.change_id>?4
  AND CASE WHEN e.action='DELETE' THEN EXISTS (${aiAffectedSegment})
    ELSE EXISTS (${aiAffectedSegment} AND s.revision IN (e.revision,e.revision-1)) END
  UNION ALL SELECT 1 FROM room_personas rp WHERE rp.workspace_id=?1 AND rp.room_id=?2
  AND EXISTS (SELECT 1 FROM app_changes e INDEXED BY search_persona_deletions
    WHERE e.workspace_id=rp.workspace_id AND e.target_id=rp.persona_id
    AND e.target_type='PERSONA' AND e.action='DELETE' AND e.change_id>?4)
  AND EXISTS (SELECT 1 FROM messages m JOIN message_segments s USING(workspace_id,room_id,message_id)
    WHERE m.workspace_id=rp.workspace_id AND m.room_id=rp.room_id AND m.persona_id=rp.persona_id
    AND m.seq<=?5 AND m.message_id<>?6 AND s.revision=m.current_revision
    AND s.visibility='public' AND s.channel IN ('public_message','shared_summary')) LIMIT 1`;

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
    ...(source.revisionKind ? { revisionKind: source.revisionKind } : {}),
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
    readonly aiBinding?: AiSearchBinding,
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
    if (this.aiBinding)
      assertAiSearchBinding(this.app, this.policy, this.actor, this.roomId, this.aiBinding);
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
    if (this.aiBinding) {
      const publicSource = target === "memory"
        ? visibility === "room_shared" && channel === "note"
        : visibility === "public" && ["public_message", "shared_summary"].includes(channel);
      if (!publicSource || !this.policy.can(this.actor, "SEND_TO_PROVIDER", {
        ...scope, provider: this.aiBinding.provider,
      })) {
        cache?.set(key, false);
        return false;
      }
      if (personaId) {
        const owner = this.statement(`SELECT r.config_json FROM room_personas rp
          JOIN personas p USING(workspace_id,persona_id) JOIN persona_revisions r ON r.workspace_id=rp.workspace_id
          AND r.persona_id=rp.persona_id AND r.revision=rp.persona_revision
          WHERE rp.workspace_id=? AND rp.room_id=? AND rp.persona_id=? AND p.deleted_at IS NULL`)
          .get(this.actor.workspaceId, this.roomId, personaId);
        const config = owner && JSON.parse(String(owner.config_json));
        if (!config || config.isEnabled === false || config.historicalIdentity) {
          cache?.set(key, false);
          return false;
        }
      }
    }
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
        AND d.room_id=? AND d.note_id=? AND d.state='PUBLISHED' ${this.aiBinding ? "AND d.scope='room_shared'" : ""})
       SELECT d.owner_persona_id,d.scope,d.version,d.digest,v.body_digest,v.created_at
       FROM visible d JOIN memory_versions v ON v.note_id=d.note_id AND v.version=d.version
       WHERE v.digest=d.digest AND v.body_digest=d.body_digest
       AND NOT EXISTS(SELECT 1 FROM memory_scan_state WHERE incomplete=1)`,
    ).get(this.actor.workspaceId, this.actor.actorId, this.roomId, noteId);
  }

  private readMemory(noteId: string): SearchSource {
    const meta = this.noteMeta(noteId);
    if (!meta) throw missing();
    if (!this.allowsScope("memory", String(meta.owner_persona_id), String(meta.scope), "note"))
      throw missing();
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
      revisionKind:
        row.revision === 1
          ? "original"
          : row.reason === "correction" || row.reason === "regeneration"
            ? row.reason
            : "revision",
    };
  }

  private segment(segmentId: string, body: boolean) {
    return this.statement(
      `SELECT ${segmentColumns}${body ? ",s.content" : ""} ${permittedSegments()}
      AND s.segment_id=? ${this.aiSegmentClause()}`,
    ).get(
      this.actor.workspaceId,
      this.roomId,
      this.actor.actorId,
      segmentId,
      ...this.aiSegmentParams(),
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
      ((!this.aiBinding && includeHistory) || row.revision === row.current_revision) &&
      (!this.aiBinding || this.allowsScope("archive", row.owner_persona_id ?? row.persona_id, row.visibility, row.channel))
    );
  }

  private aiSegmentClause() {
    return this.aiBinding ? `AND s.visibility='public' AND s.channel IN ('public_message','shared_summary')
      AND s.revision=m.current_revision AND m.seq<=? AND m.message_id<>?` : "";
  }

  private aiSegmentParams(): (string | number)[] {
    return this.aiBinding ? [this.aiBinding.maxArchiveMessageSeq, this.aiBinding.excludeMessageId ?? ""] : [];
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
          ${this.aiSegmentClause()}
          ORDER BY m.seq ${order},s.rowid ${order} LIMIT ?`,
        ).all(
          this.actor.workspaceId,
          this.roomId,
          this.actor.actorId,
          before ? Math.max(seq - count, 0) : seq + 1,
          before ? seq - 1 : seq + count,
          ...this.aiSegmentParams(),
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

  private memorySelection(after?: string) {
    if (this.aiBinding) throw new AppError("AI_INDEX_SCOPE_FORBIDDEN", 403);
    this.assertRoom("memory");
    return listNoteChanges(
      this.app,
      this.policy,
      this.actor,
      this.roomId,
      after,
      PAGE,
    );
  }

  private memoryUpsert(item: ReturnType<typeof listNoteChanges>["items"][number]) {
    const source = this.readMemory(item.noteId);
    return source.version === item.version && (source.ref as MemoryRef).fileDigest === item.digest
      ? source : undefined;
  }

  private memoryUnavailable(error: unknown) {
    // Stale/removed after the feed's cutoff. Commit the tombstone; future changes arrive through delta.
    return error instanceof AppError && ["NOT_FOUND", "SOURCE_CHANGED", "MEMORY_UNAVAILABLE"].includes(error.code);
  }

  memoryPage(after?: string): SourcePage {
    const { mode, cursor, hasMore, items } = this.memorySelection(after);
    const notes = new Map(items.map((item) => [item.noteId, item]));
    const upserts: SearchSource[] = [];
    for (const item of notes.values()) {
      if (item.state !== "PUBLISHED") continue;
      try {
        const source = this.memoryUpsert(item);
        if (source) upserts.push(source);
      } catch (error) {
        if (!this.memoryUnavailable(error)) throw error;
      }
    }
    return { mode, cursor, hasMore, deletes: [...notes.keys()], upserts };
  }

  /** The index worker shares the exact page/cursor selection, but reads long Note ancestry before a writer. */
  async memoryPageAsync(after?: string, signal?: AbortSignal): Promise<SourcePage> {
    signal?.throwIfAborted();
    const { mode, cursor, hasMore, items } = this.memorySelection(after);
    const notes = new Map(items.map(item => [item.noteId, item]));
    const upserts: SearchSource[] = [];
    for (const item of notes.values()) {
      if (item.state !== "PUBLISHED") continue;
      try {
        const source = await withVerifiedNoteAncestors(this.app, [item.noteId], () => this.memoryUpsert(item), signal);
        if (source) upserts.push(source);
      } catch (error) {
        signal?.throwIfAborted();
        if (!this.memoryUnavailable(error)) throw error;
      }
    }
    signal?.throwIfAborted();
    this.assertRoom("memory");
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

  /** An exact room/actor metadata probe. No bodies, change IDs or unrelated activity leave the reader. */
  hasUnindexedChanges(target: SearchTarget, cursor: string): boolean {
    return this.withReadSnapshot(() => {
      this.assertRoom(target);
      if (target === "memory") {
        const context = memoryChangeContext(
          this.app,
          this.policy,
          this.actor,
          this.roomId,
        );
        const page = openChangeCursor(this.app.cursorKey, context, cursor);
        if (page.mode === "baseline") return true;
        const latest = Number(
          this.statement(
            "SELECT COALESCE(MAX(seq),0) AS n FROM memory_changes",
          ).get()!.n,
        );
        if (page.position > latest) throw resync();
        if (page.position === latest) return false;
        return !!this.statement(this.aiBinding
          ? MEMORY_FRESHNESS_SQL.replace("LIMIT 1", "AND d.scope='room_shared' LIMIT 1")
          : MEMORY_FRESHNESS_SQL).get(
          this.actor.workspaceId,
          this.actor.actorId,
          this.roomId,
          page.position,
        );
      }
      const page = this.unpack(cursor, this.policy.revision(this.actor));
      if (page.mode === "baseline" || page.afterSegment !== undefined)
        return true;
      const latest = Number(
        this.statement(
          "SELECT COALESCE(MAX(change_id),0) AS n FROM app_changes",
        ).get()!.n,
      );
      if (page.change > latest) throw resync();
      if (page.change === latest) return false;
      return !!this.statement(this.aiBinding ? AI_ARCHIVE_FRESHNESS_SQL : ARCHIVE_FRESHNESS_SQL).get(
        this.actor.workspaceId,
        this.roomId,
        this.actor.actorId,
        page.change,
        ...this.aiSegmentParams(),
      );
    });
  }

  /** An internal bounded read on one SQLite snapshot. Cursors never cross the browser/API boundary. */
  archivePage(after?: string): SourcePage {
    if (this.aiBinding) throw new AppError("AI_INDEX_SCOPE_FORBIDDEN", 403);
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
          ((room_id=? AND target_type='MESSAGE') OR (target_type='PERSONA' AND action='DELETE'
            AND EXISTS (SELECT 1 FROM room_personas rp WHERE rp.workspace_id=app_changes.workspace_id
              AND rp.room_id=? AND rp.persona_id=app_changes.target_id)))
          ORDER BY change_id LIMIT ?`,
        ).all(
          pos.change,
          eventEnd,
          this.actor.workspaceId,
          this.roomId,
          this.roomId,
          PAGE + 1,
        );
        for (const event of events) {
          if (upserts.length >= PAGE || deletes.length >= PAGE) {
            hasMore = true;
            break;
          }
          // A persona is soft-deleted workspace-wide. Its retained room membership
          // is visible to READ_ROOM, even when none of its private segments were readable.
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
