import type { DatabaseSync } from "node:sqlite";
import type { AppDatabase } from "../app-data/db.ts";
import { createHistoricalGrantCheck } from "../auth/revocations.ts";
import { recoverHeldCandidate } from "./lineage-recovery.ts";
import { APP_LIMITS } from "../../shared/app-contracts/index.ts";
import { DEFAULT_GENERATION_LIMITS } from "../generation/types.ts";
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
  parents: Set<string>;
  refs: number;
}
// These released thresholds identify legacy holds after a complete proof; they no longer bound the graph.
const oldCalls = 256,
  oldRefs = 16384;
export const LINEAGE_CALLS_PER_SLICE = 4;
const maxManifestMessages =
  DEFAULT_GENERATION_LIMITS.maxHistory + DEFAULT_GENERATION_LIMITS.maxSubAgents;
const maxPersonaContextAttachments = 16; // DATA-1 persona configuration limit.
class Unverifiable extends Error {}
function requireFact(proven: unknown): asserts proven {
  if (!proven) throw new Unverifiable();
}

/** Validate one receipt and its bounded manifest. Causal parents are separate durable work items. */
function inspector(
  db: DatabaseSync,
  workspaceId: string,
  roomId: string,
  rootCallId: string,
) {
  const callStatement =
    db.prepare(`SELECT p.purpose,p.persona_id,p.manifest_digest,p.manifest_json,t.rowid AS receipt_order,t.message_id,t.revision,run.actor_id,w.acl_revision
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
    db.prepare(`SELECT call_id,rowid AS receipt_order FROM app_generation_receipts
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
    WHERE p.active=1 AND g.workspace_id=? AND g.actor_id=? AND g.operation=? AND g.revoked_at IS NULL AND g.provider IN ('*','')
    AND g.room_id IN ('*',?) AND g.persona_id IN ('*',?) AND g.visibility IN ('*',?)
    AND (g.operation<>'READ_PRIVATE_SEGMENT' OR (g.room_id=? AND g.persona_id=? AND g.visibility=?)) LIMIT 1`);
  const historicalGrantsCurrent = createHistoricalGrantCheck(db);
  return (callId: string): Lineage => {
    const parents = new Set<string>(),
      dependencies = new Map<string, Dependency>(),
      grants = new Map<string, SourceGrant>();
    let refs = 0;
    function remember(dep: Dependency) {
      const key = dep.type + ":" + dep.id,
        previous = dependencies.get(key);
      requireFact(
        !previous ||
          (previous.revision === dep.revision &&
            previous.digest === dep.digest),
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
    grant(actor, "READ_ROOM");
    grant(actor, "READ_CONVERSATION");
    // The DATA-1 compiler captures at most 100 history messages (+3 fixed workers),
    // eight attachments per message and separately configured persona context files.
    requireFact(
      m.messages.length <= maxManifestMessages &&
        m.attachments.length <=
          m.messages.length * APP_LIMITS.attachmentsPerMessage +
            maxPersonaContextAttachments,
    );
    refs += m.messages.length + m.attachments.length;
    for (const ref of m.messages) {
      requireFact(
        ref &&
          typeof ref.id === "string" &&
          typeof ref.revisionId === "string" &&
          Number.isSafeInteger(ref.revision) &&
          ref.revision > 0 &&
          Array.isArray(ref.segments) &&
          ref.segments.length > 0 &&
          ref.segments.length <= APP_LIMITS.segmentsPerRevision,
      );
      refs += ref.segments.length;
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
        if (producers.length) {
          // The coordinator commits an input receipt before compiling its consumer. A strict
          // order on these append-only SQLite rows rejects cycles across verification slices.
          requireFact(
            Number(producers[0].receipt_order) < Number(row.receipt_order),
          );
          parents.add(String(producers[0].call_id));
        }
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
    const used = Array.from(grants.values(), (g) => ({ ...g, roomId }));
    requireFact(
      historicalGrantsCurrent(workspaceId, actor, m.aclRevision, used),
    );
    return { parents, dependencies, grants, refs };
  };
}

/** Caller owns the receipt/migration transaction. Duplicate submission never restarts an existing proof. */
export function queueLineage(
  db: DatabaseSync,
  candidateId: string,
  mode: "NEW" | "LEGACY",
) {
  const added = db
    .prepare(
      `INSERT INTO memory_lineage_work(candidate_id,mode,prior_state,status,last_step)
    SELECT candidate_id,?,state,'PENDING',(SELECT coalesce(max(last_step),0)+1 FROM memory_lineage_work WHERE status='PENDING') FROM memory_candidates WHERE candidate_id=?
    ON CONFLICT(candidate_id) DO NOTHING`,
    )
    .run(mode, candidateId);
  if (!added.changes) return;
  db.prepare(
    `INSERT INTO memory_lineage_queue(candidate_id,call_id)
    SELECT candidate_id,call_id FROM memory_candidates WHERE candidate_id=? AND call_id IS NOT NULL`,
  ).run(candidateId);
  if (mode === "NEW")
    db.prepare(
      "UPDATE memory_candidates SET state='LINEAGE_PENDING' WHERE candidate_id=?",
    ).run(candidateId);
}

function recordManifest(
  db: DatabaseSync,
  workspaceId: string,
  roomId: string,
  candidateId: string,
  callId: string,
  proof: Lineage,
) {
  const deps = JSON.stringify([...proof.dependencies.values()]);
  // A resource cannot acquire a different expected revision/digest under an existing proof.
  requireFact(
    !db
      .prepare(
        `SELECT 1 FROM json_each(?) p JOIN memory_dependencies d
    ON d.candidate_id=? AND d.resource_type=p.value->>'$.type' AND d.resource_id=p.value->>'$.id'
    WHERE d.revision<>p.value->>'$.revision' OR d.digest<>p.value->>'$.digest' LIMIT 1`,
      )
      .get(deps, candidateId),
  );
  db.prepare(
    `INSERT OR IGNORE INTO memory_dependencies(candidate_id,workspace_id,room_id,resource_type,resource_id,revision,digest)
    SELECT ?,?,?,value->>'$.type',value->>'$.id',value->>'$.revision',value->>'$.digest' FROM json_each(?)`,
  ).run(candidateId, workspaceId, roomId, deps);
  db.prepare(
    `INSERT OR IGNORE INTO memory_authorities(candidate_id,actor_id,operation,room_id,persona_id,visibility)
    SELECT ?,value->>'$.actorId',value->>'$.operation',?,value->>'$.personaId',value->>'$.visibility' FROM json_each(?)`,
  ).run(candidateId, roomId, JSON.stringify([...proof.grants.values()]));
  db.prepare(
    "INSERT OR IGNORE INTO memory_lineage_queue(candidate_id,call_id) SELECT ?,value FROM json_each(?)",
  ).run(candidateId, JSON.stringify([...proof.parents]));
  db.prepare(
    "UPDATE memory_lineage_queue SET checked=1 WHERE candidate_id=? AND call_id=?",
  ).run(candidateId, callId);
  db.prepare(
    `UPDATE memory_lineage_work SET calls_done=calls_done+1,refs_done=refs_done+?,
      last_step=(SELECT coalesce(max(last_step),0)+1 FROM memory_lineage_work WHERE status='PENDING') WHERE candidate_id=?`,
  ).run(proof.refs, candidateId);
}

type LegacyFinish = (
  id: string,
  exceeded: boolean,
  priorState: string,
) => boolean;
function workSlice(
  db: DatabaseSync,
  candidateId: string,
  limit: number,
  recover?: LegacyFinish,
): number {
  const job = db
    .prepare(
      `SELECT w.*,c.workspace_id,c.room_id,c.call_id,c.state FROM memory_lineage_work w
    JOIN memory_candidates c USING(candidate_id) WHERE w.candidate_id=? AND w.status='PENDING'`,
    )
    .get(candidateId);
  if (!job) return 0;
  const workspaceId = String(job.workspace_id),
    roomId = String(job.room_id),
    rootCallId = String(job.call_id);
  const next = db.prepare(
    "SELECT call_id FROM memory_lineage_queue WHERE candidate_id=? AND checked=0 ORDER BY call_id LIMIT 1",
  );
  let processed = 0;
  try {
    requireFact(
      !job.invalidated &&
        job.call_id &&
        (job.state === "LINEAGE_PENDING" ||
          (job.mode === "LEGACY" && job.state === "NEEDS_REVIEW")),
    );
    const inspect = inspector(db, workspaceId, roomId, rootCallId);
    for (; processed < limit; processed++) {
      const item = next.get(candidateId);
      if (!item) break;
      const callId = String(item.call_id);
      recordManifest(
        db,
        workspaceId,
        roomId,
        candidateId,
        callId,
        inspect(callId),
      );
    }
    if (next.get(candidateId)) return processed;
    // Source/ACL mutations invalidate checked rows in the source transaction. The last
    // slice holds the same SQLite writer lock as final promotion and any legacy receipt checks.
    const complete = db
      .prepare(
        "SELECT calls_done,refs_done,invalidated FROM memory_lineage_work WHERE candidate_id=?",
      )
      .get(candidateId)!;
    requireFact(!complete.invalidated && Number(complete.calls_done) > 0);
    if (job.mode === "LEGACY") {
      if (!recover) throw new Error("LEGACY_RECOVERY_CALLBACK_REQUIRED");
      requireFact(
        recover(
          candidateId,
          Number(complete.calls_done) > oldCalls ||
            Number(complete.refs_done) > oldRefs,
          String(job.prior_state),
        ),
      );
    } else
      db.prepare(
        "UPDATE memory_candidates SET state='PENDING_REVIEW' WHERE candidate_id=? AND state='LINEAGE_PENDING'",
      ).run(candidateId);
    db.prepare(
      "UPDATE memory_lineage_work SET status='DONE' WHERE candidate_id=?",
    ).run(candidateId);
  } catch (error) {
    if (!(error instanceof Unverifiable)) throw error;
    db.prepare(
      "UPDATE memory_lineage_work SET status='INVALID' WHERE candidate_id=?",
    ).run(candidateId);
    db.prepare(
      "UPDATE memory_candidates SET state='NEEDS_REVIEW' WHERE candidate_id=? AND state='LINEAGE_PENDING'",
    ).run(candidateId);
    return processed + 1;
  }
  return processed;
}

/** Short healthy exports are immediately reviewable. The same persistent frontier continues after ACK loss or restart. */
export function checkNewLineage(db: DatabaseSync, candidateIds: string[]) {
  let remaining = LINEAGE_CALLS_PER_SLICE;
  for (const candidateId of candidateIds) {
    queueLineage(db, candidateId, "NEW");
    if (remaining > 0) remaining -= workSlice(db, candidateId, remaining);
  }
}

/** At most one candidate and four previously unvisited receipts in a single writer transaction. No external side effects. */
export function advanceLineage(app: AppDatabase): boolean {
  const next = app.db.prepare(
    `SELECT candidate_id FROM memory_lineage_work WHERE status='PENDING'
      AND EXISTS (SELECT 1 FROM app_operational_state WHERE singleton=1 AND maintenance=0 AND restored=0)
      ORDER BY last_step,candidate_id LIMIT 1`,
  );
  if (!next.get()) return false;
  return app.transaction(() => {
    const item = next.get();
    if (!item) return false;
    workSlice(
      app.db,
      String(item.candidate_id),
      LINEAGE_CALLS_PER_SLICE,
      (id, exceeded, prior) => recoverHeldCandidate(app, id, exceeded, prior),
    );
    return true;
  }, "memory_lineage_slice");
}
