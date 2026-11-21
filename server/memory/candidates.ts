import { AppError, type Actor } from "../../shared/app-contracts/index.ts";
import {
  ASSERTION_TYPES,
  MEMORY_KINDS,
  MEMORY_SCOPES,
  type MemoryBinding,
  type MemoryCandidateDTO,
} from "../../shared/memory-contracts.ts";
import type { AppDatabase } from "../app-data/db.ts";
import type { AuthorizationPolicy } from "../auth/authorization.ts";
import {
  canonical,
  digest,
  id,
  integer,
  object,
  string,
} from "../app-data/validation.ts";
import {
  addDependency,
  assertSourceAccess,
  assertSourcesCurrent,
  authority,
  memoryScope,
  revision,
  stale,
  unavailable,
  type MemoryDB,
  type MemoryPolicy,
  type Row,
} from "./sources.ts";
import { freezePublication } from "./vault.ts";
import { readNote } from "./notes.ts";
export { assertSourceAccess, assertSourcesCurrent } from "./sources.ts";

const select = `SELECT c.*,v.revision,v.body,v.body_digest,v.sources_json,v.sources_digest,v.kind,v.assertion_type,v.scope,
  p.run_id,p.provider,p.model,p.completed_at,p.manifest_digest FROM memory_candidates c
  JOIN memory_candidate_revisions v ON c.candidate_id=v.candidate_id AND c.current_revision=v.revision
  JOIN rooms room ON room.room_id=c.room_id AND room.workspace_id=c.workspace_id AND room.deleted_at IS NULL
  JOIN personas owner ON owner.persona_id=c.owner_persona_id AND owner.workspace_id=c.workspace_id AND owner.deleted_at IS NULL
  LEFT JOIN app_provider_calls p ON c.call_id=p.call_id`;
function bind(row: Row): MemoryBinding {
  return {
    candidateId: row.candidate_id,
    revision: row.current_revision,
    bodyDigest: row.body_digest,
    sourcesDigest: row.sources_digest,
    ownerPersonaId: row.owner_persona_id,
    scope: row.scope,
    targetNoteId: row.target_note_id,
    targetVersion: row.target_version,
    targetDigest: row.target_digest,
  };
}
function dto(row: Row, sourceVisible: boolean): MemoryCandidateDTO {
  const current = row.state !== "NEEDS_REVIEW" && row.state !== "RETRACTED";
  return {
    id: row.candidate_id,
    revision: row.current_revision,
    roomId: row.room_id,
    ownerPersonaId: row.owner_persona_id,
    body: current ? row.body : "",
    scope: row.scope,
    kind: row.kind,
    assertionType: row.assertion_type,
    state: row.state,
    createdAt: row.created_at,
    sourceRefs: current && sourceVisible ? JSON.parse(row.sources_json) : [],
    binding: bind(row),
    provenance:
      current && sourceVisible && row.call_id
        ? {
            runId: row.run_id,
            callId: row.call_id,
            provider: row.provider,
            model: row.model,
            generatedAt: row.completed_at,
            manifestDigest: row.manifest_digest,
          }
        : null,
  };
}
function key(input: unknown): string {
  if (typeof input !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(input))
    throw new AppError("INVALID_INPUT");
  return input;
}
function oneOf<T extends string>(input: unknown, options: readonly T[]): T {
  if (!options.includes(input as T)) throw new AppError("INVALID_INPUT");
  return input as T;
}
function conflict(): never {
  throw new AppError("REVISION_CONFLICT", 409);
}
function pending(row: Row) {
  if (row.state !== "PENDING_REVIEW") conflict();
}
function matches(row: Row, item: unknown) {
  if (canonical(bind(row)) !== canonical(item)) conflict();
}
function checkRead(
  policy: MemoryPolicy,
  actor: Actor,
  roomId: string,
  owner: string,
) {
  try {
    policy.assert(actor, "READ_MEMORY", memoryScope(actor, roomId, owner));
  } catch {
    unavailable();
  }
}

export function assertPublishable(
  app: MemoryDB,
  policy: MemoryPolicy,
  job: Row,
) {
  const row = app.db
    .prepare(
      select + " WHERE c.candidate_id=? AND c.workspace_id=? AND c.room_id=?",
    )
    .get(job.candidate_id, job.workspace_id, job.room_id) as Row;
  const review = app.db
    .prepare("SELECT * FROM memory_reviews WHERE review_id=?")
    .get(job.operation_id) as Row;
  if (
    !row ||
    !review ||
    !["APPROVED", "PUBLISHING"].includes(row.state) ||
    row.target_version !== null ||
    review.workspace_id !== job.workspace_id ||
    review.candidate_id !== job.candidate_id ||
    review.candidate_revision !== job.revision ||
    review.actor_id !== job.reviewer_id ||
    review.decision !== "approve" ||
    row.current_revision !== job.revision ||
    row.target_note_id !== job.note_id ||
    row.scope !== job.scope ||
    row.owner_persona_id !== job.owner_persona_id ||
    canonical(bind(row)) !== review.binding_json
  )
    throw new AppError("PUBLICATION_BINDING_MISMATCH", 409);
  const frozen = freezePublication({
    operationId: review.review_id,
    noteId: row.target_note_id,
    body: row.body,
    kind: row.kind,
    assertionType: row.assertion_type,
    scope: row.scope,
    sourceRefs: JSON.parse(row.sources_json),
    recordedAt: review.created_at,
  });
  if (
    frozen.markdown !== job.markdown ||
    frozen.fileDigest !== job.file_digest ||
    frozen.relativePath !== job.relative_path
  )
    throw new AppError("PUBLICATION_BINDING_MISMATCH", 409);
  const actor = { workspaceId: job.workspace_id, actorId: job.reviewer_id };
  assertSourcesCurrent(app, policy, actor, row.candidate_id);
  assertSourceAccess(app, policy, actor, row.candidate_id);
  return bind(row);
}

export class MemoryCandidates {
  constructor(
    private app: AppDatabase,
    private policy: AuthorizationPolicy,
  ) {}

  private row(actor: Actor, roomId: string, candidateId: string): Row {
    if (!this.policy.can(actor, "READ_ROOM", { roomId })) unavailable();
    const row = this.app.db
      .prepare(
        select + " WHERE c.workspace_id=? AND c.room_id=? AND c.candidate_id=?",
      )
      .get(actor.workspaceId, roomId, key(candidateId)) as Row;
    if (!row) unavailable();
    checkRead(this.policy, actor, roomId, row.owner_persona_id);
    return row;
  }

  private project(actor: Actor, row: Row) {
    try {
      assertSourceAccess(this.app, this.policy, actor, row.candidate_id);
    } catch {
      return dto(row, false);
    }
    return dto(row, true);
  }

  list(actor: Actor, roomId: string, after?: string, onlyConflicts = false) {
    return this.app.transaction(() => {
      if (!this.policy.can(actor, "READ_ROOM", { roomId }))
        return { items: [] as MemoryCandidateDTO[], nextCursor: null };
      const owners = this.app.db
        .prepare(
          `SELECT rp.persona_id FROM room_personas rp JOIN rooms r USING(workspace_id,room_id)
      JOIN personas p USING(workspace_id,persona_id) WHERE rp.workspace_id=? AND rp.room_id=? AND r.deleted_at IS NULL AND p.deleted_at IS NULL`,
        )
        .all(actor.workspaceId, roomId)
        .map((r) => String(r.persona_id))
        .filter((owner) =>
          this.policy.can(
            actor,
            "READ_MEMORY",
            memoryScope(actor, roomId, owner),
          ),
        );
      if (!owners.length)
        return { items: [] as MemoryCandidateDTO[], nextCursor: null };
      const cursor = after ? key(after) : "";
      // A cursor names only a candidate already visible in this room.
      if (cursor) this.row(actor, roomId, cursor);
      const rows = this.app.db
        .prepare(
          select +
            ` WHERE c.workspace_id=? AND c.room_id=? AND c.candidate_id>?
      ${onlyConflicts ? "AND c.state='CONFLICT'" : ""} AND c.owner_persona_id IN (${owners.map(() => "?").join(",")}) ORDER BY c.candidate_id LIMIT 21`,
        )
        .all(actor.workspaceId, roomId, cursor, ...owners) as Row[];
      return {
        items: rows.slice(0, 20).map((row) => this.project(actor, row)),
        nextCursor: rows.length > 20 ? String(rows[19].candidate_id) : null,
      };
    }, "memory_list");
  }

  get(actor: Actor, roomId: string, candidateId: string): MemoryCandidateDTO {
    return this.app.transaction(
      () => this.project(actor, this.row(actor, roomId, candidateId)),
      "memory_detail",
    );
  }

  source(actor: Actor, roomId: string, candidateId: string) {
    return this.app.transaction(() => {
      const row = this.row(actor, roomId, candidateId);
      try {
        assertSourceAccess(this.app, this.policy, actor, candidateId);
        assertSourcesCurrent(this.app, this.policy, actor, candidateId);
      } catch {
        unavailable();
      }
      const body = row.source_segment_id
        ? this.app.db
            .prepare("SELECT content FROM message_segments WHERE segment_id=?")
            .get(row.source_segment_id)?.content
        : readNote(
            this.app,
            this.policy,
            actor,
            row.target_note_id,
            row.target_version,
          ).body;
      if (typeof body !== "string") unavailable();
      const { sourceRefs, provenance } = dto(row, true);
      return { body, sourceRefs, provenance };
    }, "memory_source");
  }

  private request(
    actor: Actor,
    roomId: string,
    requestId: string,
    payload: unknown,
    apply: () => string[],
  ): MemoryCandidateDTO[] {
    const hash = digest(canonical({ roomId, payload }));
    return this.app.transaction(() => {
      const old = this.app.db
        .prepare(
          "SELECT * FROM memory_requests WHERE workspace_id=? AND actor_id=? AND request_id=?",
        )
        .get(actor.workspaceId, actor.actorId, key(requestId));
      if (old) {
        if (old.room_id !== roomId) unavailable();
        const previous = (
          JSON.parse(String(old.result_ids_json)) as string[]
        ).map((candidate) => this.get(actor, roomId, candidate));
        if (old.request_digest !== hash)
          throw new AppError("REQUEST_CONFLICT", 409);
        return previous;
      }
      const ids = apply();
      this.app.db
        .prepare("INSERT INTO memory_requests VALUES(?,?,?,?,?,?,?)")
        .run(
          actor.workspaceId,
          actor.actorId,
          roomId,
          requestId,
          hash,
          JSON.stringify(ids),
          Date.now(),
        );
      return ids.map((candidate) => this.get(actor, roomId, candidate));
    }, "memory_request");
  }

  edit(actor: Actor, roomId: string, candidateId: string, input: unknown) {
    const x = object(input, [
      "requestId",
      "expectedRevision",
      "body",
      "kind",
      "assertionType",
      "scope",
    ]);
    const body = string(x.body),
      expected = integer(x.expectedRevision);
    const kind = oneOf(x.kind, MEMORY_KINDS),
      assertion = oneOf(x.assertionType, ASSERTION_TYPES),
      scope = oneOf(x.scope, MEMORY_SCOPES);
    return this.request(
      actor,
      roomId,
      x.requestId,
      { action: "edit", candidateId, ...x },
      () => {
        const row = this.row(actor, roomId, candidateId);
        this.policy.assert(
          actor,
          "EDIT_MEMORY",
          memoryScope(actor, roomId, row.owner_persona_id),
        );
        if (scope !== row.scope)
          this.policy.assert(
            actor,
            "CHANGE_MEMORY_SCOPE",
            memoryScope(actor, roomId, row.owner_persona_id, scope),
          );
        if (
          row.current_revision !== expected ||
          (row.target_version !== null && row.scope !== scope)
        )
          conflict();
        pending(row);
        assertSourcesCurrent(this.app, this.policy, actor, candidateId);
        revision(
          this.app,
          actor,
          candidateId,
          expected + 1,
          body,
          JSON.parse(row.sources_json),
          kind,
          assertion,
          scope,
          Date.now(),
        );
        this.app.db
          .prepare(
            "UPDATE memory_candidates SET current_revision=? WHERE candidate_id=?",
          )
          .run(expected + 1, candidateId);
        return [candidateId];
      },
    )[0];
  }

  review(actor: Actor, roomId: string, input: unknown) {
    const x = object(input, ["requestId", "decision", "items"]),
      decision = oneOf(x.decision, ["approve", "reject"] as const);
    if (!Array.isArray(x.items) || !x.items.length || x.items.length > 32)
      throw new AppError("INVALID_INPUT");
    const ids = x.items.map((item) => key(item?.candidateId));
    if (new Set(ids).size !== ids.length) throw new AppError("INVALID_INPUT");
    const items = this.request(
      actor,
      roomId,
      x.requestId,
      { action: "review", ...x },
      () => {
        const rows = ids.map((candidate) => this.row(actor, roomId, candidate));
        for (const [i, row] of rows.entries()) {
          this.policy.assert(
            actor,
            "REVIEW_MEMORY",
            memoryScope(actor, roomId, row.owner_persona_id),
          );
          matches(row, x.items[i]);
          pending(row);
          if (decision === "reject") continue;
          assertSourcesCurrent(this.app, this.policy, actor, row.candidate_id);
          assertSourceAccess(this.app, this.policy, actor, row.candidate_id);
          if (row.target_version !== null)
            this.checkNote(
              actor,
              roomId,
              row.target_note_id,
              row.target_version,
              row.target_digest,
            );
          this.policy.assert(
            actor,
            "PUBLISH_MEMORY",
            memoryScope(actor, roomId, row.owner_persona_id, row.scope),
          );
          if (row.scope === "room_shared" && row.target_version === null)
            this.policy.assert(
              actor,
              "CHANGE_MEMORY_SCOPE",
              memoryScope(actor, roomId, row.owner_persona_id, row.scope),
            );
        }
        const now = Date.now();
        for (const row of rows) {
          const reviewId = id(),
            binding = bind(row);
          this.app.db
            .prepare(
              `INSERT INTO memory_reviews(review_id,candidate_id,candidate_revision,decision,binding_json,workspace_id,actor_id,request_id,created_at)
          VALUES(?,?,?,?,?,?,?,?,?)`,
            )
            .run(
              reviewId,
              row.candidate_id,
              row.current_revision,
              decision,
              canonical(binding),
              actor.workspaceId,
              actor.actorId,
              x.requestId,
              now,
            );
          let state = "REJECTED";
          if (decision === "approve") {
            authority(
              this.app,
              this.policy,
              actor,
              row.candidate_id,
              "READ_MEMORY",
              roomId,
              row.owner_persona_id,
              "persona_private",
            );
            authority(
              this.app,
              this.policy,
              actor,
              row.candidate_id,
              "READ_ROOM",
              roomId,
            );
            authority(
              this.app,
              this.policy,
              actor,
              row.candidate_id,
              "REVIEW_MEMORY",
              roomId,
              row.owner_persona_id,
              "persona_private",
            );
            authority(
              this.app,
              this.policy,
              actor,
              row.candidate_id,
              "PUBLISH_MEMORY",
              roomId,
              row.owner_persona_id,
              row.scope,
            );
            if (row.source_segment_id) {
              authority(
                this.app,
                this.policy,
                actor,
                row.candidate_id,
                "READ_CONVERSATION",
                roomId,
              );
              authority(
                this.app,
                this.policy,
                actor,
                row.candidate_id,
                "READ_PRIVATE_SEGMENT",
                roomId,
                row.owner_persona_id,
                "self_only",
              );
            }
            if (row.scope === "room_shared" && row.target_version === null)
              authority(
                this.app,
                this.policy,
                actor,
                row.candidate_id,
                "CHANGE_MEMORY_SCOPE",
                roomId,
                row.owner_persona_id,
                row.scope,
              );
            state =
              row.target_version === null ? "APPROVED" : "MANUAL_PROPOSAL";
            if (row.target_version === null) {
              const frozen = freezePublication({
                operationId: reviewId,
                noteId: row.target_note_id,
                body: row.body,
                kind: row.kind,
                assertionType: row.assertion_type,
                scope: row.scope,
                sourceRefs: JSON.parse(row.sources_json),
                recordedAt: now,
              });
              this.app.db
                .prepare(
                  `INSERT INTO memory_jobs(operation_id,candidate_id,revision,workspace_id,room_id,owner_persona_id,scope,reviewer_id,
              note_id,relative_path,markdown,file_digest,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                )
                .run(
                  reviewId,
                  row.candidate_id,
                  row.current_revision,
                  actor.workspaceId,
                  roomId,
                  row.owner_persona_id,
                  row.scope,
                  actor.actorId,
                  row.target_note_id,
                  frozen.relativePath,
                  frozen.markdown,
                  frozen.fileDigest,
                  now,
                );
            }
          }
          this.app.db
            .prepare(
              "UPDATE memory_candidates SET state=? WHERE candidate_id=?",
            )
            .run(state, row.candidate_id);
        }
        return ids;
      },
    );
    return { items };
  }

  retract(actor: Actor, roomId: string, candidateId: string, input: unknown) {
    const x = object(input, ["requestId", "binding"]);
    return this.request(
      actor,
      roomId,
      x.requestId,
      { action: "retract", candidateId, ...x },
      () => {
        const row = this.row(actor, roomId, candidateId);
        this.policy.assert(
          actor,
          "RETRACT_MEMORY",
          memoryScope(actor, roomId, row.owner_persona_id, row.scope),
        );
        matches(row, x.binding);
        // Published notes have their own current-version/digest boundary. In particular, a stale
        // proposal binding can never withdraw a later Obsidian revision of the original note.
        if (
          ![
            "PENDING_REVIEW",
            "APPROVED",
            "PUBLISHING",
            "MANUAL_PROPOSAL",
            "FAILED",
            "CONFLICT",
            "NEEDS_REVIEW",
          ].includes(row.state) ||
          this.app.db
            .prepare("SELECT 1 FROM memory_documents WHERE candidate_id=?")
            .get(candidateId)
        )
          conflict();
        this.app.db
          .prepare(
            "UPDATE memory_candidates SET state='RETRACTED' WHERE candidate_id=?",
          )
          .run(candidateId);
        this.app.db
          .prepare(
            "UPDATE memory_jobs SET status='RETRACTED', error_code=NULL WHERE candidate_id=? AND status<>'PUBLISHED'",
          )
          .run(candidateId);
        this.app.audit(
          actor.actorId,
          actor.workspaceId,
          "MEMORY_CANDIDATE_RETRACTED",
          candidateId,
        );
        return [candidateId];
      },
    )[0];
  }

  private checkNote(
    actor: Actor,
    roomId: string,
    noteId: string,
    version: number,
    hash: string,
  ) {
    const note = this.app.db
      .prepare(
        "SELECT * FROM memory_documents WHERE workspace_id=? AND room_id=? AND note_id=?",
      )
      .get(actor.workspaceId, roomId, noteId) as Row;
    if (
      !note ||
      !this.policy.can(
        actor,
        "READ_MEMORY",
        memoryScope(actor, roomId, note.owner_persona_id, note.scope),
      )
    )
      unavailable();
    readNote(this.app, this.policy, actor, noteId); // Verify the named file has the currently available digest at this boundary.
    if (
      note.version !== version ||
      note.digest !== hash ||
      note.state !== "PUBLISHED"
    )
      stale();
    return note;
  }

  propose(actor: Actor, roomId: string, noteId: string, input: unknown) {
    const x = object(input, [
      "requestId",
      "expectedVersion",
      "expectedDigest",
      "body",
    ]);
    const body = string(x.body),
      expected = integer(x.expectedVersion),
      hash = string(x.expectedDigest, 64);
    return this.request(
      actor,
      roomId,
      x.requestId,
      { action: "propose", noteId, ...x },
      () => {
        const note = this.checkNote(actor, roomId, noteId, expected, hash);
        const candidate = id(),
          now = Date.now();
        this.policy.assert(
          actor,
          "PROPOSE_MEMORY",
          memoryScope(actor, roomId, note.owner_persona_id),
        );
        this.app.db
          .prepare(
            `INSERT INTO memory_candidates(candidate_id,workspace_id,room_id,owner_persona_id,current_revision,state,target_note_id,
        target_version,target_digest,proposer_id,created_at) VALUES(?,?,?,?,1,'PENDING_REVIEW',?,?,?,?,?)`,
          )
          .run(
            candidate,
            actor.workspaceId,
            roomId,
            note.owner_persona_id,
            noteId,
            expected,
            hash,
            actor.actorId,
            now,
          );
        revision(
          this.app,
          actor,
          candidate,
          1,
          body,
          [`note:${noteId}@${expected}:${hash}`],
          "unclassified",
          "unclassified",
          note.scope,
          now,
        );
        authority(
          this.app,
          this.policy,
          actor,
          candidate,
          "PROPOSE_MEMORY",
          roomId,
          note.owner_persona_id,
          "persona_private",
        );
        authority(
          this.app,
          this.policy,
          actor,
          candidate,
          "READ_MEMORY",
          roomId,
          note.owner_persona_id,
          note.scope,
        );
        addDependency(
          this.app,
          candidate,
          actor.workspaceId,
          roomId,
          "NOTE",
          noteId,
          expected,
          hash,
        );
        return [candidate];
      },
    )[0];
  }
}
