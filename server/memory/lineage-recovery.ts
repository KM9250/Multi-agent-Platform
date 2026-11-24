import type { DatabaseSync } from "node:sqlite";
import type { AppDatabase } from "../app-data/db.ts";
import { canonical, digest } from "../app-data/validation.ts";
import { AuthorizationPolicy } from "../auth/authorization.ts";
import {
  createHistoricalGrantCheck,
  type CallSourceGrant,
} from "../auth/revocations.ts";
import { assertPublicationBinding } from "./candidates.ts";
import { queueLineage } from "./lineage.ts";
import { assertPublicationCapacity } from "./limits.ts";
import { parseMemoryMarkdown } from "./markdown.ts";
import { memoryScope, type Row } from "./sources.ts";
import { readVaultFile, readVersion } from "./vault.ts";

/** Migration only schedules verification. Neither a source Vault nor a restored directory is opened here. */
export function enqueueLegacyLineage(
  db: DatabaseSync,
  sourceSchema: 2 | 3,
): void {
  const filter =
    sourceSchema === 2
      ? "state IN ('PUBLISHED','APPROVED','PUBLISHING','PENDING_REVIEW','FAILED','CONFLICT','NEEDS_REVIEW')"
      : "state='NEEDS_REVIEW'";
  const page =
    db.prepare(`SELECT candidate_id,call_id,state FROM memory_candidates
    WHERE ${filter} AND target_version IS NULL AND candidate_id>? ORDER BY candidate_id LIMIT 128`);
  const gate = db.prepare(
    "UPDATE memory_candidates SET state=? WHERE candidate_id=?",
  );
  const gateDoc = db.prepare(
    "UPDATE memory_documents SET state='LINEAGE_PENDING' WHERE candidate_id=? AND state='PUBLISHED'",
  );
  let cursor = "";
  for (;;) {
    const rows = page.all(cursor);
    if (!rows.length) return;
    for (const row of rows) {
      cursor = String(row.candidate_id);
      if (!row.call_id) {
        gate.run("NEEDS_REVIEW", cursor);
        continue;
      }
      queueLineage(db, cursor, "LEGACY");
      if (row.state !== "NEEDS_REVIEW") {
        gate.run("LINEAGE_PENDING", cursor);
        gateDoc.run(cursor);
      }
    }
  }
}

class Unproven extends Error {}
function proven(value: unknown): asserts value {
  if (!value) throw new Unproven();
}

/** Bind the first candidate revision to the exact exported segment, and the reviewed/current
 * revision to its retained source set. Manifest membership supplies dependencies, not citations. */
function exportBinding(db: DatabaseSync, id: string): Row {
  const row = db
    .prepare(
      `SELECT c.*,v.body,v.body_digest,v.sources_json,v.sources_digest,v.scope,
    first.body AS original_body,first.body_digest AS original_digest,first.edited_by AS original_actor,
    first.sources_json AS original_sources,first.sources_digest AS original_sources_digest,
    m.current_revision AS source_revision,r.revision_id,s.content,s.digest AS segment_digest,r.message_id,
    json_extract(p.manifest_json,'$.aclRevision') AS acl_epoch
    FROM memory_candidates c JOIN memory_candidate_revisions v ON v.candidate_id=c.candidate_id AND v.revision=c.current_revision
    JOIN rooms room ON room.workspace_id=c.workspace_id AND room.room_id=c.room_id AND room.deleted_at IS NULL
    JOIN personas owner ON owner.workspace_id=c.workspace_id AND owner.persona_id=c.owner_persona_id AND owner.deleted_at IS NULL
    JOIN memory_candidate_revisions first ON first.candidate_id=c.candidate_id AND first.revision=1
    JOIN app_generation_receipts t ON t.workspace_id=c.workspace_id AND t.room_id=c.room_id AND t.call_id=c.call_id
    JOIN app_provider_calls p USING(workspace_id,room_id,call_id,run_id)
    JOIN app_generation_runs run ON run.workspace_id=c.workspace_id AND run.room_id=c.room_id AND run.run_id=t.run_id
      AND run.actor_id=c.proposer_id
    JOIN message_revisions r ON r.workspace_id=c.workspace_id AND r.room_id=c.room_id AND r.message_id=t.message_id AND r.revision=t.revision
    JOIN messages m ON m.workspace_id=c.workspace_id AND m.room_id=c.room_id AND m.message_id=r.message_id
      AND m.deleted_at IS NULL AND m.current_revision=t.revision AND m.role='model' AND m.persona_id=c.owner_persona_id
    JOIN message_segments s ON s.workspace_id=c.workspace_id AND s.room_id=c.room_id AND s.message_id=r.message_id
      AND s.revision=t.revision AND s.segment_id=c.source_segment_id AND s.owner_persona_id=c.owner_persona_id
      AND s.channel='memory_export' AND s.visibility='self_only'
    WHERE c.candidate_id=? AND c.target_version IS NULL AND c.target_digest IS NULL AND t.status='COMPLETED' AND p.state='COMPLETED'
    AND p.purpose='memory' AND p.persona_id=c.owner_persona_id AND c.created_at=t.created_at`,
    )
    .get(id) as Row;
  proven(row && ["NEEDS_REVIEW", "LINEAGE_PENDING"].includes(row.state));
  const sources = canonical([
    `message:${row.message_id}@${row.source_revision}/${row.revision_id}#${row.source_segment_id}:${row.segment_digest}`,
  ]);
  proven(
    row.original_actor === row.proposer_id &&
      row.content === row.original_body &&
      row.segment_digest === digest(row.content) &&
      row.original_digest === row.segment_digest &&
      row.original_sources === sources &&
      row.original_sources_digest === digest(sources) &&
      row.sources_json === sources &&
      row.sources_digest === digest(sources) &&
      row.body_digest === digest(row.body),
  );
  return row;
}

function checkAuthority(
  app: AppDatabase,
  policy: AuthorizationPolicy,
  c: Row,
  reviewer?: string,
): void {
  const continuity = createHistoricalGrantCheck(app.db);
  const ownerScope = memoryScope(
    { workspaceId: c.workspace_id, actorId: c.proposer_id },
    c.room_id,
    c.owner_persona_id,
  );
  const roomScope = { roomId: c.room_id };
  const verify = (actorId: string, grants: CallSourceGrant[]) => {
    const actor = { workspaceId: c.workspace_id, actorId };
    for (const { operation, ...scope } of grants)
      policy.assert(actor, operation, scope);
    proven(continuity(c.workspace_id, actorId, c.acl_epoch, grants));
  };
  verify(c.proposer_id, [
    { operation: "READ_ROOM", ...roomScope },
    { operation: "READ_CONVERSATION", ...roomScope },
    { operation: "PROPOSE_MEMORY", ...ownerScope },
  ]);
  if (reviewer) {
    const destination = { ...ownerScope, visibility: String(c.scope) };
    const grants = [
      { operation: "READ_ROOM", ...roomScope },
      { operation: "READ_CONVERSATION", ...roomScope },
      { operation: "READ_MEMORY", ...ownerScope },
      { operation: "REVIEW_MEMORY", ...ownerScope },
      {
        operation: "READ_PRIVATE_SEGMENT",
        ...ownerScope,
        visibility: "self_only",
      },
      { operation: "PUBLISH_MEMORY", ...destination },
    ];
    if (c.scope === "room_shared")
      grants.push({ operation: "CHANGE_MEMORY_SCOPE", ...destination });
    verify(reviewer, grants);
  }
}

/** Recreate the review request digest from its original, ordered revision bindings.
 * Batch approval is capped at 32; no sibling's current revision participates in this historical check. */
function checkReviewRequest(db: DatabaseSync, job: Row): void {
  const request = db
    .prepare(
      `SELECT q.* FROM memory_reviews r JOIN memory_requests q
    USING(workspace_id,actor_id,request_id) WHERE r.review_id=?`,
    )
    .get(job.operation_id);
  proven(
    request &&
      request.room_id === job.room_id &&
      request.actor_id === job.reviewer_id &&
      request.workspace_id === job.workspace_id,
  );
  const ids: unknown = JSON.parse(String(request.result_ids_json));
  proven(
    Array.isArray(ids) &&
      ids.length >= 1 &&
      ids.length <= 32 &&
      ids.includes(job.candidate_id) &&
      new Set(ids).size === ids.length,
  );
  const records = db
    .prepare(
      `SELECT candidate_id,binding_json,decision FROM memory_reviews
    WHERE workspace_id=? AND actor_id=? AND request_id=? LIMIT 33`,
    )
    .all(job.workspace_id, job.reviewer_id, request.request_id);
  proven(
    records.length === ids.length &&
      records.every((r) => r.decision === "approve"),
  );
  const bindings = new Map(
    records.map((r) => [r.candidate_id, r.binding_json]),
  );
  const items = ids.map((id) => {
    proven(typeof id === "string" && bindings.has(id));
    return JSON.parse(String(bindings.get(id)));
  });
  const payload = {
    action: "review",
    requestId: request.request_id,
    decision: "approve",
    items,
  };
  proven(
    request.request_digest ===
      digest(canonical({ roomId: job.room_id, payload })),
  );
}

function checkPublished(app: AppDatabase, c: Row, job: Row): void {
  const doc = app.db
    .prepare(
      `SELECT d.*,r.file_digest AS receipt_digest,r.created_at AS published_at
    FROM memory_documents d JOIN memory_receipts r ON d.note_id=r.note_id
    WHERE d.note_id=? AND r.operation_id=? AND d.candidate_id=?`,
    )
    .get(job.note_id, job.operation_id, c.candidate_id) as Row;
  proven(
    doc &&
      ["LINEAGE_PENDING", "NEEDS_REVIEW"].includes(doc.state) &&
      doc.workspace_id === c.workspace_id &&
      doc.room_id === c.room_id &&
      doc.owner_persona_id === c.owner_persona_id &&
      doc.scope === c.scope &&
      doc.receipt_digest === job.file_digest &&
      job.prepared === 1 &&
      job.error_code === null,
  );
  proven(
    !app.db
      .prepare("SELECT 1 FROM memory_retract_requests WHERE note_id=? LIMIT 1")
      .get(doc.note_id),
  );
  const last = app.db
    .prepare(
      `SELECT state,version FROM memory_changes WHERE note_id=?
    AND state NOT IN ('NEEDS_REVIEW','LINEAGE_PENDING') ORDER BY seq DESC LIMIT 1`,
    )
    .get(doc.note_id);
  proven(last?.state === "PUBLISHED" && last.version === doc.version);
  const first = app.db
    .prepare("SELECT * FROM memory_versions WHERE note_id=? AND version=1")
    .get(doc.note_id);
  const latest = app.db
    .prepare("SELECT * FROM memory_versions WHERE note_id=? AND version=?")
    .get(doc.note_id, doc.version);
  proven(
    first &&
      first.digest === job.file_digest &&
      first.relative_path === job.relative_path &&
      first.body_digest === c.body_digest &&
      first.created_at === doc.published_at &&
      latest &&
      latest.digest === doc.digest &&
      latest.body_digest === doc.body_digest,
  );
  const approved = readVersion(app, String(first.digest));
  proven(approved.equals(Buffer.from(job.markdown, "utf8")));
  const current = doc.version === 1 ? approved : readVersion(app, doc.digest);
  if (doc.version > 1)
    proven(
      app.db
        .prepare(
          `SELECT 1 FROM memory_changes
    WHERE note_id=? AND version=? AND action='BODY_CHANGED' AND state='PUBLISHED' LIMIT 1`,
        )
        .get(doc.note_id, doc.version),
    );
  const parsed = parseMemoryMarkdown(current);
  proven(
    parsed.noteId === doc.note_id &&
      parsed.operationId === job.operation_id &&
      parsed.metadata === parseMemoryMarkdown(approved).metadata &&
      digest(parsed.body) === doc.body_digest &&
      current.equals(readVaultFile(app, doc.relative_path)),
  );
  proven(
    !app.db
      .prepare("SELECT incomplete FROM memory_scan_state WHERE singleton=1")
      .get()?.incomplete,
  );
  if (doc.state === "NEEDS_REVIEW")
    assertPublicationCapacity(app, job.operation_id);
  app.db
    .prepare("UPDATE memory_documents SET state='PUBLISHED' WHERE note_id=?")
    .run(doc.note_id);
}

/** Called inside the bounded worker's final writer after the full ancestor proof. A savepoint
 * allows the ordinary read/approval validators to inspect the exact revision without exposing
 * intermediate state. Failed evidence leaves the durable candidate, editable file and job intact. */
export function recoverHeldCandidate(
  app: AppDatabase,
  id: string,
  exceededLegacyBudget: boolean,
  priorState = "NEEDS_REVIEW",
): boolean {
  if (priorState === "NEEDS_REVIEW" && !exceededLegacyBudget) return false;
  const db = app.db,
    policy = new AuthorizationPolicy(app);
  db.exec("SAVEPOINT legacy_memory_evidence");
  try {
    proven(
      db
        .prepare(
          `SELECT 1 FROM memory_lineage_work w WHERE candidate_id=? AND mode='LEGACY' AND prior_state=?
      AND status='PENDING' AND invalidated=0 AND calls_done>0 AND NOT EXISTS(
        SELECT 1 FROM memory_lineage_queue q WHERE q.candidate_id=w.candidate_id AND checked=0)`,
        )
        .get(id, priorState),
    );
    const c = exportBinding(db, id);
    if (priorState === "NEEDS_REVIEW") {
      // createRoom inserts the creator's membership in the room-creation transaction.
      // Its later deletion triggered a sticky source hold in older schemas even though
      // it left no ACL epoch event. Other explicitly granted Actors may never have been members.
      const missingCreator = db
        .prepare(
          `
        SELECT 1 FROM rooms r JOIN memory_authorities a
          ON a.candidate_id=? AND a.actor_id=r.created_by AND a.room_id=r.room_id
        WHERE r.workspace_id=? AND r.room_id=?
        AND NOT EXISTS (SELECT 1 FROM room_memberships m WHERE m.workspace_id=r.workspace_id
          AND m.room_id=r.room_id AND m.actor_id=r.created_by) LIMIT 1`,
        )
        .get(id, c.workspace_id, c.room_id);
      proven(!missingCreator);
    }
    proven(
      !db
        .prepare(
          "SELECT 1 FROM app_audit_events WHERE workspace_id=? AND action='MEMORY_CANDIDATE_RETRACTED' AND target_id=? LIMIT 1",
        )
        .get(c.workspace_id, id),
    );
    const decisions = db
      .prepare(
        "SELECT decision FROM memory_reviews WHERE candidate_id=? LIMIT 2",
      )
      .all(id);
    const job = db
      .prepare("SELECT * FROM memory_jobs WHERE candidate_id=?")
      .get(id) as Row | undefined;
    let restored: string;
    if (!job) {
      proven(
        ["NEEDS_REVIEW", "PENDING_REVIEW"].includes(priorState) &&
          decisions.length === 0 &&
          !db
            .prepare(
              "SELECT 1 FROM memory_documents WHERE candidate_id=? OR note_id=? LIMIT 1",
            )
            .get(id, c.target_note_id),
      );
      restored = "PENDING_REVIEW";
      db.prepare(
        "UPDATE memory_candidates SET state=? WHERE candidate_id=?",
      ).run(restored, id);
      checkAuthority(app, policy, c);
    } else {
      proven(
        decisions.length === 1 &&
          decisions[0].decision === "approve" &&
          job.status !== "RETRACTED",
      );
      // Only an existing completed publication can restore a held, already-reviewed candidate.
      restored = job.status === "PENDING" ? "APPROVED" : job.status;
      proven(
        ["APPROVED", "PUBLISHING", "PUBLISHED", "FAILED", "CONFLICT"].includes(
          restored,
        ) &&
          (priorState === restored ||
            (priorState === "NEEDS_REVIEW" && restored === "PUBLISHED")),
      );
      proven(job.error_code !== "RESTORE_PUBLICATION_UNCERTAIN");
      db.prepare(
        "UPDATE memory_candidates SET state='APPROVED' WHERE candidate_id=?",
      ).run(id);
      checkAuthority(app, policy, c, job.reviewer_id);
      assertPublicationBinding(app, job);
      checkReviewRequest(db, job);
      if (restored === "PUBLISHED") checkPublished(app, c, job);
      else
        proven(
          !db
            .prepare(
              "SELECT 1 FROM memory_documents WHERE candidate_id=? OR note_id=? LIMIT 1",
            )
            .get(id, c.target_note_id) &&
            !db
              .prepare(
                "SELECT 1 FROM memory_receipts WHERE operation_id=? OR note_id=? LIMIT 1",
              )
              .get(job.operation_id, c.target_note_id),
        );
      db.prepare(
        "UPDATE memory_candidates SET state=? WHERE candidate_id=?",
      ).run(restored, id);
    }
    db.exec("RELEASE legacy_memory_evidence");
    return true;
  } catch (error) {
    db.exec(
      "ROLLBACK TO legacy_memory_evidence; RELEASE legacy_memory_evidence",
    );
    // Missing files, unsupported encodings, changed authority and malformed persisted bindings
    // all withhold release. SQLite/programming errors must surface to the worker for retry.
    if (
      error instanceof Unproven ||
      error instanceof SyntaxError ||
      (error instanceof Error &&
        "code" in error &&
        !String(error.code).startsWith("ERR_SQLITE"))
    )
      return false;
    throw error;
  }
}
