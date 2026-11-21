import type { DatabaseSync } from "node:sqlite";
import { digest } from "../app-data/validation.ts";
import type { ContextManifest } from "../generation/context.ts";

interface Dependency {
  type: "MESSAGE" | "ATTACHMENT";
  id: string;
  revision: number;
  digest: string;
}
interface SourceGrant {
  actorId: string;
  operation: string;
  personaId: string;
  visibility: string;
}
interface Lineage {
  dependencies: Map<string, Dependency>;
  grants: Map<string, SourceGrant>;
}
// Limits are per candidate batch, including repeated references in overlapping manifests.
const maxCalls = 256,
  maxRefs = 16384;
class Unverifiable extends Error {}
function requireFact(proven: unknown): asserts proven {
  if (!proven) throw new Unverifiable();
}

/** Walk the persisted generation graph. Its inputs are invalidation dependencies, never claim citations. */
export function generationLineage(
  db: DatabaseSync,
  workspaceId: string,
  roomId: string,
  rootCallId: string,
): Lineage | null {
  const callStatement =
    db.prepare(`SELECT p.purpose,p.persona_id,p.manifest_digest,p.manifest_json,t.message_id,t.revision,run.actor_id,w.acl_revision
    FROM app_generation_receipts t JOIN app_provider_calls p USING(workspace_id,room_id,run_id,call_id)
    JOIN app_generation_runs run USING(workspace_id,room_id,run_id)
    JOIN workspaces w USING(workspace_id)
    JOIN messages output ON output.workspace_id=t.workspace_id AND output.room_id=t.room_id AND output.message_id=t.message_id
      AND output.role='model' AND output.persona_id=p.persona_id AND output.current_revision=t.revision AND output.deleted_at IS NULL
    JOIN message_revisions v ON v.workspace_id=output.workspace_id AND v.room_id=output.room_id AND v.message_id=output.message_id
      AND v.revision=t.revision AND (v.reason=p.purpose OR v.reason='regeneration')
    WHERE t.workspace_id=? AND t.room_id=? AND t.call_id=? AND t.status='COMPLETED' AND p.state='COMPLETED'
      AND t.message_id IS NOT NULL AND length(p.manifest_json)<=1048576`);
  const messageStatement =
    db.prepare(`SELECT r.content_digest,r.reason,m.role,m.deleted_at,m.current_revision,m.persona_id,p.deleted_at AS persona_deleted
    FROM message_revisions r JOIN messages m USING(workspace_id,room_id,message_id)
    LEFT JOIN personas p ON p.workspace_id=m.workspace_id AND p.persona_id=m.persona_id
    WHERE r.workspace_id=? AND r.room_id=? AND r.message_id=? AND r.revision=? AND r.revision_id=?`);
  const segmentStatement =
    db.prepare(`SELECT segment_id,digest,visibility,owner_persona_id FROM message_segments
    WHERE workspace_id=? AND room_id=? AND message_id=? AND revision=?`);
  const producerStatement =
    db.prepare(`SELECT call_id FROM app_generation_receipts
    WHERE workspace_id=? AND room_id=? AND message_id=? AND revision=? LIMIT 2`);
  const attachmentStatement =
    db.prepare(`SELECT a.digest,EXISTS(SELECT 1 FROM persona_attachment_links l WHERE l.workspace_id=a.workspace_id
      AND l.room_id=a.room_id AND l.persona_id=? AND l.persona_revision=? AND l.attachment_id=a.attachment_id AND l.purpose='CONTEXT') persona_link,
      EXISTS(SELECT 1 FROM json_each(?) ref JOIN attachment_links ml
        ON ml.workspace_id=a.workspace_id AND ml.room_id=a.room_id AND ml.message_id=json_extract(ref.value,'$.id')
        AND ml.revision=json_extract(ref.value,'$.revision') AND ml.attachment_id=a.attachment_id) message_link
    FROM attachments a WHERE a.workspace_id=? AND a.room_id=? AND a.attachment_id=? AND a.state='AVAILABLE' AND a.deleted_at IS NULL`);
  const grantStatement =
    db.prepare(`SELECT 1 FROM access_grants g JOIN principals p USING(workspace_id,actor_id)
    WHERE p.active=1 AND g.workspace_id=? AND g.actor_id=? AND g.operation=? AND g.revoked_at IS NULL AND g.provider='*'
    AND g.room_id IN ('*',?) AND g.persona_id IN ('*',?) AND g.visibility IN ('*',?)
    AND (g.operation<>'READ_PRIVATE_SEGMENT' OR (g.room_id=? AND g.persona_id=? AND g.visibility=?)) LIMIT 1`);
  // DATA-1's historical ACL change feed identifies the actor and revision but does not contain the revoked grant scope.
  const withdrawn =
    db.prepare(`SELECT 1 FROM app_changes WHERE workspace_id=? AND target_type='ACL'
    AND target_id=? AND action='REVOKE' AND revision>? LIMIT 1`);

  const seen = new Set<string>(),
    path = new Set<string>(),
    dependencies = new Map<string, Dependency>(),
    grants = new Map<string, SourceGrant>();
  let remaining = maxRefs;
  function remember(dep: Dependency) {
    const key = dep.type + ":" + dep.id,
      previous = dependencies.get(key);
    requireFact(
      !previous ||
        (previous.revision === dep.revision && previous.digest === dep.digest),
    );
    dependencies.set(key, dep);
  }
  function grant(
    actorId: string,
    operation: string,
    personaId = "",
    visibility = "",
  ) {
    const key = JSON.stringify([actorId, operation, personaId, visibility]);
    if (grants.has(key)) return;
    requireFact(
      grantStatement.get(
        workspaceId,
        actorId,
        operation,
        roomId,
        personaId,
        visibility,
        roomId,
        personaId,
        visibility,
      ),
    );
    grants.set(key, { actorId, operation, personaId, visibility });
  }
  function visit(callId: string) {
    requireFact(!path.has(callId));
    if (seen.has(callId)) return;
    requireFact(seen.size < maxCalls);
    seen.add(callId);
    path.add(callId);
    const row = callStatement.get(workspaceId, roomId, callId);
    requireFact(
      row &&
        typeof row.manifest_json === "string" &&
        digest(row.manifest_json) === row.manifest_digest,
    );
    let m: ContextManifest;
    try {
      m = JSON.parse(row.manifest_json);
    } catch {
      throw new Unverifiable();
    }
    requireFact(
      m &&
        m.contract === "MAP-DATA-1:SERVER_CONVERSATION:1" &&
        m.roomId === roomId &&
        m.personaId === row.persona_id &&
        Number.isSafeInteger(m.personaRevision) &&
        m.personaRevision > 0 &&
        m.purpose === row.purpose &&
        (callId !== rootCallId || m.purpose === "memory") &&
        Array.isArray(m.messages) &&
        m.messages.length > 0 &&
        Array.isArray(m.attachments) &&
        Number.isSafeInteger(m.aclRevision) &&
        m.aclRevision > 0 &&
        typeof row.acl_revision === "number" &&
        m.aclRevision <= row.acl_revision,
    );
    const actor = String(row.actor_id);
    if (callId !== rootCallId)
      requireFact(!withdrawn.get(workspaceId, actor, m.aclRevision));
    grant(actor, "READ_ROOM");
    grant(actor, "READ_CONVERSATION");
    remaining -= m.messages.length + m.attachments.length;
    requireFact(remaining >= 0);
    for (const ref of m.messages) {
      requireFact(
        ref &&
          typeof ref.id === "string" &&
          typeof ref.revisionId === "string" &&
          Number.isSafeInteger(ref.revision) &&
          ref.revision > 0 &&
          Array.isArray(ref.segments) &&
          ref.segments.length > 0 &&
          ref.segments.length <= 16,
      );
      remaining -= ref.segments.length;
      requireFact(remaining >= 0);
      const message = messageStatement.get(
        workspaceId,
        roomId,
        ref.id,
        ref.revision,
        ref.revisionId,
      );
      requireFact(
        message &&
          message.deleted_at === null &&
          message.persona_deleted === null &&
          message.current_revision === ref.revision,
      );
      remember({
        type: "MESSAGE",
        id: ref.id,
        revision: ref.revision,
        digest: String(message.content_digest),
      });
      const segments = new Map(
        segmentStatement
          .all(workspaceId, roomId, ref.id, ref.revision)
          .map((s) => [s.segment_id, s]),
      );
      for (const segment of ref.segments) {
        requireFact(
          segment &&
            typeof segment.id === "string" &&
            typeof segment.digest === "string",
        );
        const saved = segments.get(segment.id);
        requireFact(saved && saved.digest === segment.digest);
        if (saved.visibility !== "public") {
          // Fixed subagent reports are admitted by the run's internal generation capability.
          if (m.purpose === "subagent") grant(actor, "GENERATE", m.personaId);
          else
            grant(
              actor,
              "READ_PRIVATE_SEGMENT",
              String(saved.owner_persona_id),
              String(saved.visibility),
            );
        }
      }
      if (message.role === "model") {
        const producers = producerStatement.all(
          workspaceId,
          roomId,
          ref.id,
          ref.revision,
        );
        requireFact(producers.length <= 1);
        if (producers.length) visit(String(producers[0].call_id));
        // Host imports and explicit human corrections are standalone records. An unexplained model revision isn't.
        else
          requireFact(
            message.reason === "IMPORT" || message.reason === "correction",
          );
      }
    }
    const messageRefs = m.attachments.length
      ? JSON.stringify(m.messages.map(({ id, revision }) => ({ id, revision })))
      : "[]";
    for (const ref of m.attachments) {
      requireFact(
        ref && typeof ref.id === "string" && typeof ref.digest === "string",
      );
      const a = attachmentStatement.get(
        m.personaId,
        m.personaRevision,
        messageRefs,
        workspaceId,
        roomId,
        ref.id,
      );
      requireFact(
        a && a.digest === ref.digest && (a.persona_link || a.message_link),
      );
      remember({
        type: "ATTACHMENT",
        id: ref.id,
        revision: 1,
        digest: ref.digest,
      });
      if (a.persona_link) grant(actor, "GENERATE", m.personaId);
      if (a.message_link) grant(actor, "READ_ATTACHMENT");
    }
    path.delete(callId);
  }
  try {
    visit(rootCallId);
    return { dependencies, grants };
  } catch (error) {
    if (error instanceof Unverifiable) return null;
    throw error;
  }
}

export function storeLineage(
  db: DatabaseSync,
  workspaceId: string,
  roomId: string,
  candidateId: string,
  lineage: Lineage | null,
) {
  if (!lineage) {
    db.prepare(
      "UPDATE memory_candidates SET state='NEEDS_REVIEW' WHERE candidate_id=?",
    ).run(candidateId);
    return;
  }
  const dep = db.prepare(
    "INSERT OR IGNORE INTO memory_dependencies(candidate_id,workspace_id,room_id,resource_type,resource_id,revision,digest) VALUES(?,?,?,?,?,?,?)",
  );
  for (const d of lineage.dependencies.values())
    dep.run(
      candidateId,
      workspaceId,
      roomId,
      d.type,
      d.id,
      d.revision,
      d.digest,
    );
  const permission = db.prepare(
    "INSERT OR IGNORE INTO memory_authorities(candidate_id,actor_id,operation,room_id,persona_id,visibility) VALUES(?,?,?,?,?,?)",
  );
  for (const g of lineage.grants.values())
    permission.run(
      candidateId,
      g.actorId,
      g.operation,
      roomId,
      g.personaId,
      g.visibility,
    );
}

/** Runs inside migration 003. A missing or stale ancestry withholds the current version while preserving its bytes and receipt. */
export function backfillMemoryLineage(db: DatabaseSync) {
  const page =
    db.prepare(`SELECT c.candidate_id,c.workspace_id,c.room_id,c.call_id,EXISTS(
    SELECT 1 FROM app_generation_receipts t JOIN message_segments s USING(workspace_id,room_id,message_id,revision)
    JOIN messages m USING(workspace_id,room_id,message_id)
    WHERE t.workspace_id=c.workspace_id AND t.room_id=c.room_id AND t.call_id=c.call_id
    AND m.deleted_at IS NULL AND t.revision=m.current_revision AND s.segment_id=c.source_segment_id
    AND s.owner_persona_id=c.owner_persona_id AND s.channel='memory_export' AND s.visibility='self_only') bound
    FROM memory_candidates c WHERE c.candidate_id>? AND (c.call_id IS NOT NULL OR c.target_version IS NULL)
    AND c.state NOT IN ('RETRACTED','SUPERSEDED','REJECTED','NEEDS_REVIEW') ORDER BY c.candidate_id LIMIT 64`);
  let cursor = "";
  for (;;) {
    const batch = page.all(cursor);
    if (!batch.length) return;
    for (const row of batch) {
      cursor = String(row.candidate_id);
      const workspaceId = String(row.workspace_id),
        roomId = String(row.room_id);
      const lineage = row.bound
        ? generationLineage(db, workspaceId, roomId, String(row.call_id))
        : null;
      storeLineage(db, workspaceId, roomId, cursor, lineage);
    }
  }
}
