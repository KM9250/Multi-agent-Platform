import { checkNewLineage } from "./lineage.ts";
import { AppError, type Actor } from "../../shared/app-contracts/index.ts";
import type { AppDatabasePort, PolicyPort } from "../generation/types.ts";
import type { ContextManifest } from "../generation/context.ts";
import { canonical, digest, id } from "../app-data/validation.ts";

export type MemoryDB = AppDatabasePort;
export type MemoryPolicy = Pick<PolicyPort, "assert">;
export type Row = Record<string, any>;
export const unavailable = (): never => {
  throw new AppError("NOT_FOUND", 404);
};
export const stale = (): never => {
  throw new AppError("SOURCE_CHANGED", 409);
};

export function memoryScope(
  actor: Actor,
  roomId: string,
  personaId: string,
  visibility = "persona_private",
) {
  return { workspaceId: actor.workspaceId, roomId, personaId, visibility };
}

export function authority(
  app: MemoryDB,
  policy: MemoryPolicy,
  actor: Actor,
  candidateId: string,
  operation: string,
  roomId: string,
  personaId = "",
  visibility = "",
) {
  const scope = {
    workspaceId: actor.workspaceId,
    roomId,
    personaId,
    visibility,
  };
  policy.assert(actor, operation, scope);
  app.db
    .prepare(
      `INSERT OR IGNORE INTO memory_authorities
    (candidate_id,actor_id,operation,room_id,persona_id,visibility) VALUES(?,?,?,?,?,?)`,
    )
    .run(candidateId, actor.actorId, operation, roomId, personaId, visibility);
}

export function revision(
  app: MemoryDB,
  actor: Actor,
  candidateId: string,
  number: number,
  body: string,
  sourceRefs: string[],
  kind: string,
  assertion: string,
  scope: string,
  now: number,
) {
  const sources = canonical(sourceRefs);
  app.db
    .prepare(
      `INSERT INTO memory_candidate_revisions
    (candidate_id, revision, body, body_digest, sources_json, sources_digest, kind, assertion_type, scope, edited_by, created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      candidateId,
      number,
      body,
      digest(body),
      sources,
      digest(sources),
      kind,
      assertion,
      scope,
      actor.actorId,
      now,
    );
}

export function addDependency(
  app: MemoryDB,
  candidateId: string,
  workspaceId: string,
  roomId: string,
  type: string,
  resourceId: string,
  revision: number,
  sourceDigest: string,
) {
  app.db
    .prepare(
      `INSERT OR IGNORE INTO memory_dependencies
    (candidate_id,workspace_id,room_id,resource_type,resource_id,revision,digest) VALUES(?,?,?,?,?,?,?)`,
    )
    .run(
      candidateId,
      workspaceId,
      roomId,
      type,
      resourceId,
      revision,
      sourceDigest,
    );
}

/** Invoked only by the coordinator inside its completed receipt transaction. */
export function captureExports(
  app: MemoryDB,
  policy: MemoryPolicy,
  actor: Actor,
  callId: string,
  context: ContextManifest,
) {
  const roomId = context.roomId,
    personaId = context.personaId;
  try {
    policy.assert(
      actor,
      "PROPOSE_MEMORY",
      memoryScope(actor, roomId, personaId),
    );
  } catch (error) {
    // DATA-1 users retain their explicitly requested internal export. A Host grant enables proposals.
    if ((error as any)?.code === "FORBIDDEN") return;
    throw error;
  }
  const outputs = app.db
    .prepare(
      `SELECT s.*, r.revision_id, r.content_digest, t.created_at
    FROM app_generation_receipts t JOIN app_provider_calls p USING(workspace_id,room_id,run_id,call_id)
    JOIN message_revisions r USING(workspace_id,room_id,message_id,revision)
    JOIN message_segments s USING(workspace_id,room_id,message_id,revision)
    WHERE t.workspace_id=? AND t.room_id=? AND t.call_id=? AND t.status='COMPLETED'
      AND p.purpose='memory' AND p.state='COMPLETED' AND p.persona_id=?
      AND s.owner_persona_id=p.persona_id AND s.channel='memory_export' AND s.visibility='self_only'`,
    )
    .all(actor.workspaceId, roomId, callId, personaId) as Row[];
  const candidateIds: string[] = [];
  for (const output of outputs) {
    const candidateId = id();
    app.db
      .prepare(
        `INSERT INTO memory_candidates
      (candidate_id,workspace_id,room_id,owner_persona_id,current_revision,state,target_note_id,proposer_id,
       created_at,source_segment_id,call_id) VALUES(?,?,?,?,1,'PENDING_REVIEW',?,?,?,?,?)`,
      )
      .run(
        candidateId,
        actor.workspaceId,
        roomId,
        personaId,
        "mem_" + id(),
        actor.actorId,
        output.created_at,
        output.segment_id,
        callId,
      );
    const sourceRef = `message:${output.message_id}@${output.revision}/${output.revision_id}#${output.segment_id}:${output.digest}`;
    revision(
      app,
      actor,
      candidateId,
      1,
      output.content,
      [sourceRef],
      "unclassified",
      "unclassified",
      "persona_private",
      output.created_at,
    );
    addDependency(
      app,
      candidateId,
      actor.workspaceId,
      roomId,
      "MESSAGE",
      output.message_id,
      output.revision,
      output.content_digest,
    );
    authority(
      app,
      policy,
      actor,
      candidateId,
      "PROPOSE_MEMORY",
      roomId,
      personaId,
      "persona_private",
    );
    authority(app, policy, actor, candidateId, "READ_CONVERSATION", roomId);
    authority(app, policy, actor, candidateId, "READ_ROOM", roomId);
    candidateIds.push(candidateId);
  }
  checkNewLineage(app.db, candidateIds);
}

/** Current-source gate for the approver, outbox, and ordinary note read. No private source body crosses it. */
export function assertSourcesCurrent(
  app: MemoryDB,
  policy: MemoryPolicy,
  actor: Actor,
  candidateId: string,
) {
  const candidate = app.db
    .prepare(
      `SELECT c.* FROM memory_candidates c
    JOIN rooms r USING(workspace_id,room_id) JOIN personas p ON p.workspace_id=c.workspace_id AND p.persona_id=c.owner_persona_id
    WHERE c.workspace_id=? AND c.candidate_id=? AND r.deleted_at IS NULL AND p.deleted_at IS NULL`,
    )
    .get(actor.workspaceId, candidateId);
  if (
    !candidate ||
    ["RETRACTED", "SUPERSEDED", "NEEDS_REVIEW", "LINEAGE_PENDING"].includes(
      String(candidate.state),
    )
  )
    stale();
  const changed = app.db
    .prepare(
      `SELECT 1 FROM memory_dependencies d WHERE candidate_id=? AND
    ((resource_type='MESSAGE' AND NOT EXISTS (SELECT 1 FROM messages m JOIN message_revisions r
      ON r.workspace_id=m.workspace_id AND r.room_id=m.room_id AND r.message_id=m.message_id AND r.revision=m.current_revision
      WHERE m.workspace_id=d.workspace_id AND m.room_id=d.room_id AND m.message_id=d.resource_id AND m.deleted_at IS NULL
      AND r.revision=d.revision AND r.content_digest=d.digest AND (m.persona_id IS NULL OR EXISTS(SELECT 1 FROM personas p
      WHERE p.workspace_id=m.workspace_id AND p.persona_id=m.persona_id AND p.deleted_at IS NULL))))
    OR (resource_type='ATTACHMENT' AND NOT EXISTS(SELECT 1 FROM attachments a WHERE a.workspace_id=d.workspace_id
      AND a.room_id=d.room_id AND a.attachment_id=d.resource_id AND a.state='AVAILABLE' AND a.digest=d.digest AND a.deleted_at IS NULL))
    OR (resource_type='NOTE' AND NOT EXISTS(SELECT 1 FROM memory_documents n WHERE n.workspace_id=d.workspace_id
      AND n.room_id=d.room_id AND n.note_id=d.resource_id AND n.state='PUBLISHED' AND n.version=d.revision AND n.digest=d.digest))) LIMIT 1`,
    )
    .get(candidateId);
  if (changed) stale();
  for (const grant of app.db
    .prepare("SELECT * FROM memory_authorities WHERE candidate_id=?")
    .all(candidateId) as Row[]) {
    try {
      policy.assert(
        { workspaceId: actor.workspaceId, actorId: grant.actor_id },
        grant.operation,
        memoryScope(actor, grant.room_id, grant.persona_id, grant.visibility),
      );
    } catch {
      stale();
    }
  }
}

/** Reading a candidate does not confer permission to inspect the private originating export. */
export function assertSourceAccess(
  app: MemoryDB,
  policy: MemoryPolicy,
  actor: Actor,
  candidateId: string,
) {
  const row = app.db
    .prepare(
      `SELECT c.room_id,c.owner_persona_id,c.target_version,n.scope,s.visibility FROM memory_candidates c
    LEFT JOIN memory_documents n ON n.note_id=c.target_note_id
    LEFT JOIN message_segments s ON s.segment_id=c.source_segment_id WHERE c.workspace_id=? AND c.candidate_id=?`,
    )
    .get(actor.workspaceId, candidateId) as Row;
  if (!row || (row.target_version === null && !row.visibility)) unavailable();
  if (row.target_version !== null) {
    if (!row.scope) unavailable();
    policy.assert(
      actor,
      "READ_MEMORY",
      memoryScope(actor, row.room_id, row.owner_persona_id, row.scope),
    );
  }
  if (row.visibility) {
    policy.assert(actor, "READ_CONVERSATION", { roomId: row.room_id });
    policy.assert(
      actor,
      "READ_PRIVATE_SEGMENT",
      memoryScope(actor, row.room_id, row.owner_persona_id, row.visibility),
    );
  }
}
