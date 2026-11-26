import type { DatabaseSync } from "node:sqlite";
import type { AppDatabase } from "../app-data/db.ts";
import { createHistoricalGrantCheck } from "../auth/revocations.ts";
import { requiresExactScope } from "../auth/operations.ts";
import { AuthorizationPolicy } from "../auth/authorization.ts";
import { recoverHeldCandidate } from "./lineage-recovery.ts";
import { APP_LIMITS } from "../../shared/app-contracts/index.ts";
import { DEFAULT_GENERATION_LIMITS } from "../generation/types.ts";
import { digest } from "../app-data/validation.ts";
import type { ContextManifest } from "../generation/context.ts";
import { readContextManifest } from "../generation/context-manifest.ts";
import { parseMemoryMarkdown } from "./markdown.ts";
import { readVaultFile } from "./vault.ts";
import { inventoryNotePath, NoteVerificationPending } from "./verification-state.ts";

interface Dependency {
  type: "MESSAGE" | "ATTACHMENT" | "NOTE";
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
  notes: NoteDependency[];
}
interface NoteDependency {
  noteId: string;
  version: number;
  fileDigest: string;
  bodyDigest: string;
  ownerPersonaId: string;
  scope: "room_shared";
  consumerCallId: string;
  receiptBefore: number;
}
// These released thresholds identify legacy holds after a complete proof; they no longer bound the graph.
const oldCalls = 256,
  oldRefs = 16384;
export const LINEAGE_CALLS_PER_SLICE = 4;
export const LINEAGE_AUTHORITIES_PER_NOTE_SLICE = 32;
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
    db.prepare(`SELECT p.purpose,p.persona_id,p.manifest_digest,p.manifest_json,p.run_id,run.request_json,t.rowid AS receipt_order,t.message_id,t.revision,run.actor_id,w.acl_revision
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
    AND (?=0 OR (g.room_id=? AND g.persona_id=? AND g.visibility=?)) LIMIT 1`);
  const historicalGrantsCurrent = createHistoricalGrantCheck(db);
  return (callId: string): Lineage => {
    const parents = new Set<string>(),
      dependencies = new Map<string, Dependency>(),
      grants = new Map<string, SourceGrant>(),
      notes: NoteDependency[] = [];
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
          Number(requiresExactScope(operation)),
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
      m = readContextManifest(row.manifest_json);
    } catch {
      throw new Unverifiable();
    }
    requireFact(
      m &&
        ["MAP-DATA-1:SERVER_CONVERSATION:1", "MAP-MEM-3:CONTEXT:1"].includes(m.contract) &&
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
    const retrieved = (m as any).retrieval;
    if (m.contract === "MAP-MEM-3:CONTEXT:1") {
      const accepted = JSON.parse(String(row.request_json)).inputBinding;
      requireFact(retrieved && retrieved.actorId === row.actor_id && retrieved.workspaceId === workspaceId &&
        retrieved.runId === row.run_id && accepted && retrieved.inputBinding.messageId === accepted.messageId &&
        retrieved.inputBinding.revision === accepted.revision && retrieved.inputBinding.seq === accepted.seq &&
        Array.isArray(retrieved.sources) && retrieved.sources.length <= 10);
      for (const source of retrieved.sources) {
        const ref = source?.citation;
        requireFact(ref && ref.workspaceId === workspaceId && ref.roomId === roomId &&
          Number.isSafeInteger(ref.version) && ref.version > 0 &&
          Number.isSafeInteger(ref.start) && Number.isSafeInteger(ref.end) && ref.start >= 0 && ref.end > ref.start);
        if (ref.target === "memory") {
          requireFact(source.scope === "room_shared" && typeof source.ownerPersonaId === "string" &&
            typeof ref.noteId === "string" && typeof ref.fileDigest === "string" && typeof ref.bodyDigest === "string");
          notes.push({ noteId: ref.noteId, version: ref.version, fileDigest: ref.fileDigest,
            bodyDigest: ref.bodyDigest, ownerPersonaId: source.ownerPersonaId, scope: "room_shared",
            consumerCallId: callId, receiptBefore: Number(row.receipt_order) });
          remember({ type: "NOTE", id: ref.noteId, revision: ref.version, digest: ref.fileDigest });
        } else if (ref.target === "archive") {
          requireFact(source.scope === "public" && typeof ref.messageId === "string" &&
            typeof ref.revisionId === "string" && typeof ref.segmentId === "string" && typeof ref.segmentDigest === "string");
          // Archive excerpts are ordinary current public message dependencies. Reuse the
          // exact receipt and segment checks below, without recording a synthetic source.
          const existing = m.messages.find((message) => message.id === ref.messageId);
          if (existing) {
            requireFact(existing.revision === ref.version && existing.revisionId === ref.revisionId);
            const segment = existing.segments.find((s) => s.id === ref.segmentId);
            requireFact(!segment || segment.digest === ref.segmentDigest);
            if (!segment) existing.segments.push({ id: ref.segmentId, digest: ref.segmentDigest });
          } else m.messages.push({ id: ref.messageId, revision: ref.version, revisionId: ref.revisionId,
            segments: [{ id: ref.segmentId, digest: ref.segmentDigest }] });
          const saved = db.prepare(`SELECT s.content,m.seq FROM message_segments s JOIN messages m
            USING(workspace_id,room_id,message_id) WHERE s.workspace_id=? AND s.room_id=?
            AND s.message_id=? AND s.revision=? AND s.segment_id=? AND s.digest=? AND s.visibility='public'
            AND s.channel IN ('public_message','shared_summary')`).get(workspaceId, roomId,
              ref.messageId, ref.version, ref.segmentId, ref.segmentDigest);
          requireFact(saved && Number(saved.seq) <= retrieved.inputBinding.seq &&
            ref.messageId !== retrieved.inputBinding.excludeMessageId && ref.end <= String(saved.content).length);
        } else throw new Unverifiable();
      }
    } else requireFact(retrieved === undefined);
    const actor = String(row.actor_id);
    grant(actor, "READ_ROOM");
    grant(actor, "READ_CONVERSATION");
    for (const note of notes) grant(actor, "READ_MEMORY", note.ownerPersonaId, note.scope);
    // The DATA-1 compiler captures at most 100 history messages (+3 fixed workers),
    // eight attachments per message and separately configured persona context files.
    requireFact(
      m.messages.length <= maxManifestMessages + (m.contract === "MAP-MEM-3:CONTEXT:1" ? 5 : 0) &&
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
    return { parents, dependencies, grants, refs, notes };
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
  for (const note of proof.notes) {
    const old = db.prepare("SELECT * FROM memory_lineage_notes WHERE candidate_id=? AND note_id=?")
      .get(candidateId, note.noteId);
    requireFact(!old || (old.version === note.version && old.file_digest === note.fileDigest &&
      old.body_digest === note.bodyDigest && old.owner_persona_id === note.ownerPersonaId && old.scope === note.scope));
    const priorConsumer = old && db.prepare("SELECT rowid AS receipt_order FROM app_generation_receipts WHERE call_id=?")
      .get(old.consumer_call_id);
    requireFact(!old || priorConsumer);
    if (old?.checked && note.receiptBefore < Number(priorConsumer?.receipt_order)) {
      const producer = db.prepare(`SELECT t.rowid AS receipt_order FROM memory_documents d
        JOIN memory_candidates c ON c.candidate_id=d.candidate_id JOIN app_generation_receipts t
        ON t.workspace_id=c.workspace_id AND t.room_id=c.room_id AND t.call_id=c.call_id WHERE d.note_id=?`).get(note.noteId);
      requireFact(!producer || Number(producer.receipt_order) < note.receiptBefore);
    }
    const earliest = !old || note.receiptBefore < Number(priorConsumer?.receipt_order);
    db.prepare(`INSERT INTO memory_lineage_notes(candidate_id,note_id,version,file_digest,body_digest,
      owner_persona_id,scope,consumer_call_id,receipt_before) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(candidate_id,note_id) DO UPDATE SET consumer_call_id=excluded.consumer_call_id,receipt_before=excluded.receipt_before`)
      .run(candidateId, note.noteId, note.version, note.fileDigest, note.bodyDigest,
        note.ownerPersonaId, note.scope, earliest ? note.consumerCallId : old.consumer_call_id,
        earliest ? note.receiptBefore : Number(priorConsumer.receipt_order));
  }
  db.prepare(
    "UPDATE memory_lineage_queue SET checked=1 WHERE candidate_id=? AND call_id=?",
  ).run(candidateId, callId);
  db.prepare(
    `UPDATE memory_lineage_work SET calls_done=calls_done+1,refs_done=refs_done+?,
      last_step=(SELECT coalesce(max(last_step),0)+1 FROM memory_lineage_work WHERE status='PENDING') WHERE candidate_id=?`,
  ).run(proof.refs, candidateId);
}

/** File access is internal provenance validation; it does not confer private-source access
 * on the actor consuming the published projection. Each NOTE work item opens one file. */
export function verifyCurrentNoteFile(app: AppDatabase, row: Record<string, any>) {
  let inventoryPath: string | undefined;
  try {
    inventoryPath = inventoryNotePath(app, row);
    if (inventoryPath === undefined && app.db.prepare("SELECT incomplete FROM memory_scan_state WHERE singleton=1").get()?.incomplete)
      throw new NoteVerificationPending();
    const bytes = readVaultFile(app, inventoryPath ?? row.relative_path), parsed = parseMemoryMarkdown(bytes);
    requireFact(parsed.noteId === row.note_id && digest(bytes) === row.digest && digest(parsed.body) === row.body_digest);
    const version = app.db.prepare("SELECT digest,body_digest FROM memory_versions WHERE note_id=? AND version=?")
      .get(row.note_id, row.version);
    requireFact(version && version.digest === row.digest && version.body_digest === row.body_digest);
  } catch (error) {
    if (error instanceof NoteVerificationPending) throw error;
    if (["EIO", "EAGAIN", "EBUSY", "EACCES"].includes((error as any)?.code)) throw new NoteVerificationPending();
    if (error instanceof Error && "code" in error && String(error.code).startsWith("ERR_SQLITE")) throw error;
    if (inventoryPath !== undefined && !(error instanceof Unverifiable)) throw new NoteVerificationPending();
    throw new Unverifiable();
  }
}

function inspectNote(app: AppDatabase, candidateId: string, item: Record<string, any>): void {
  const db = app.db;
  const candidate = db.prepare("SELECT workspace_id,room_id FROM memory_candidates WHERE candidate_id=?").get(candidateId)!;
  const row = db.prepare(`SELECT d.* FROM memory_documents d JOIN personas p
    ON p.workspace_id=d.workspace_id AND p.persona_id=d.owner_persona_id
    WHERE d.note_id=? AND d.workspace_id=? AND d.room_id=? AND p.deleted_at IS NULL`).get(
      item.note_id, candidate.workspace_id, candidate.room_id);
  requireFact(row && row.state === "PUBLISHED" && row.version === item.version && row.digest === item.file_digest &&
    row.body_digest === item.body_digest && row.owner_persona_id === item.owner_persona_id && row.scope === item.scope);
  verifyCurrentNoteFile(app, row);
  const consuming = db.prepare(`SELECT p.reserved_at,t.rowid AS receipt_order FROM app_generation_receipts t JOIN app_provider_calls p
    USING(workspace_id,room_id,run_id,call_id) WHERE t.call_id=? AND t.workspace_id=? AND t.room_id=?`)
    .get(item.consumer_call_id, candidate.workspace_id, candidate.room_id);
  requireFact(consuming);
  let authorities: Record<string, any>[];
  let cursor: unknown;
  try { cursor = JSON.parse(String(item.after_authority_key)); } catch { throw new Unverifiable(); }
  requireFact(Array.isArray(cursor) && cursor.every(key => typeof key === "string"));
  let nextKey: string[] = cursor as string[];
  if (row.candidate_id) {
    const origin = db.prepare(`SELECT c.*,j.operation_id,j.revision AS approved_revision,j.file_digest,j.prepared,j.status,
      receipt.file_digest AS receipt_digest,receipt.created_at AS published_at,first.digest AS first_digest,
      proof.status AS proof_status,producer.rowid AS producer_order
      FROM memory_candidates c JOIN memory_jobs j ON j.candidate_id=c.candidate_id AND j.note_id=c.target_note_id
      JOIN memory_receipts receipt ON receipt.operation_id=j.operation_id AND receipt.note_id=j.note_id
      JOIN memory_versions first ON first.note_id=j.note_id AND first.version=1
      LEFT JOIN memory_lineage_work proof ON proof.candidate_id=c.candidate_id
      LEFT JOIN app_generation_receipts producer ON producer.workspace_id=c.workspace_id AND producer.room_id=c.room_id
        AND producer.call_id=c.call_id AND producer.status='COMPLETED'
      WHERE c.candidate_id=?`).get(row.candidate_id);
    requireFact(origin && origin.state === "PUBLISHED" && origin.status === "PUBLISHED" && origin.prepared === 1 &&
      origin.workspace_id === candidate.workspace_id && origin.room_id === candidate.room_id &&
      origin.target_note_id === row.note_id && origin.owner_persona_id === row.owner_persona_id &&
      origin.current_revision === origin.approved_revision && origin.file_digest === origin.receipt_digest &&
      origin.file_digest === origin.first_digest && origin.call_id && origin.proof_status === "DONE" &&
      Number(origin.published_at) <= Number(consuming.reserved_at) &&
      Number(origin.producer_order) < Number(consuming.receipt_order));
    if (item.phase === "SOURCE") {
      db.prepare("INSERT OR IGNORE INTO memory_lineage_queue(candidate_id,call_id) VALUES(?,?)").run(candidateId, origin.call_id);
      db.prepare("UPDATE memory_lineage_notes SET phase='AUTHORITIES' WHERE candidate_id=? AND note_id=?")
        .run(candidateId, item.note_id);
    }
    requireFact(cursor.length === 0 || cursor.length === 5);
    authorities = db.prepare(`SELECT * FROM memory_authorities
      WHERE candidate_id=? AND (actor_id,operation,room_id,persona_id,visibility)>(?,?,?,?,?)
      ORDER BY actor_id,operation,room_id,persona_id,visibility LIMIT ?`).all(
        row.candidate_id, ...(cursor.length ? cursor as string[] : ["", "", "", "", ""]),
        LINEAGE_AUTHORITIES_PER_NOTE_SLICE) as Record<string, any>[];
    const last = authorities.at(-1);
    if (last) nextKey = [last.actor_id, last.operation, last.room_id, last.persona_id, last.visibility];
  } else {
    const registrar = db.prepare(`SELECT h.*,p.active FROM memory_handwritten h JOIN principals p
      ON p.workspace_id=h.workspace_id AND p.actor_id=h.registrar_id WHERE h.note_id=?`).get(row.note_id);
    requireFact(registrar && registrar.active === 1 && registrar.workspace_id === candidate.workspace_id &&
      Number(registrar.registered_at) <= Number(consuming.reserved_at));
    requireFact(cursor.length === 0 || cursor.length === 1);
    authorities = db.prepare(`SELECT s.grant_id AS cursor_grant,g.actor_id,g.operation,g.room_id,g.persona_id,g.visibility,
      g.revoked_at,g.workspace_id FROM memory_handwritten_grants s JOIN access_grants g USING(grant_id)
      WHERE s.note_id=? AND s.grant_id>? ORDER BY s.grant_id LIMIT ?`).all(
        row.note_id, cursor[0] ?? "", LINEAGE_AUTHORITIES_PER_NOTE_SLICE) as Record<string, any>[];
    const last = authorities.at(-1);
    if (last) nextKey = [last.cursor_grant];
    requireFact(authorities.length > 0 || item.after_authority > 0);
    for (const grant of authorities) requireFact(grant.revoked_at === null &&
      grant.actor_id === registrar.registrar_id && grant.workspace_id === candidate.workspace_id);
  }
  const policy = new AuthorizationPolicy(app);
  for (const grant of authorities) {
    try {
      policy.assert({ workspaceId: String(candidate.workspace_id), actorId: grant.actor_id }, grant.operation,
        { roomId: grant.room_id, personaId: grant.persona_id, visibility: grant.visibility });
    } catch { throw new Unverifiable(); }
    db.prepare(`INSERT OR IGNORE INTO memory_authorities(candidate_id,actor_id,operation,room_id,persona_id,visibility)
      VALUES(?,?,?,?,?,?)`).run(candidateId, grant.actor_id, grant.operation, grant.room_id, grant.persona_id, grant.visibility);
  }
  const done = authorities.length < LINEAGE_AUTHORITIES_PER_NOTE_SLICE;
  db.prepare(`UPDATE memory_lineage_notes SET after_authority=?,after_authority_key=?,phase=?,checked=? WHERE candidate_id=? AND note_id=?`)
    .run(Number(item.after_authority) + authorities.length, JSON.stringify(nextKey), done ? "DONE" : "AUTHORITIES", Number(done), candidateId, item.note_id);
  db.prepare(`UPDATE memory_lineage_work SET notes_done=notes_done+?,refs_done=refs_done+?,
    last_step=(SELECT coalesce(max(last_step),0)+1 FROM memory_lineage_work WHERE status='PENDING') WHERE candidate_id=?`)
    .run(Number(done), authorities.length + Number(item.phase === "SOURCE"), candidateId);
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
  app?: AppDatabase,
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
  const nextNote = db.prepare("SELECT * FROM memory_lineage_notes WHERE candidate_id=? AND checked=0 ORDER BY note_id LIMIT 1");
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
      if (!item) {
        const note = nextNote.get(candidateId);
        if (!note) break;
        if (!app) return processed;
        inspectNote(app, candidateId, note);
        continue;
      }
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
    if (next.get(candidateId) || nextNote.get(candidateId)) return processed;
    // Source/ACL mutations invalidate checked rows in the source transaction. The last
    // slice holds the same SQLite writer lock as final promotion and any legacy receipt checks.
    const complete = db
      .prepare(
        "SELECT calls_done,refs_done,invalidated FROM memory_lineage_work WHERE candidate_id=?",
      )
      .get(candidateId)!;
    requireFact(!complete.invalidated && Number(complete.calls_done) > 0);
    if (job.mode === "LEGACY") {
      if (db.prepare("SELECT incomplete FROM memory_scan_state WHERE singleton=1").get()?.incomplete)
        throw new NoteVerificationPending();
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
    if (error instanceof NoteVerificationPending) {
      // Keep the exact NOTE cursor and proof counters, but yield this candidate's
      // place so another verifiable candidate can proceed on the next bounded slice.
      db.prepare(`UPDATE memory_lineage_work SET last_step=(SELECT coalesce(max(last_step),0)+1
        FROM memory_lineage_work WHERE status='PENDING') WHERE candidate_id=?`).run(candidateId);
      return processed + 1;
    }
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
export function checkNewLineage(db: DatabaseSync, candidateIds: string[], app?: AppDatabase) {
  let remaining = LINEAGE_CALLS_PER_SLICE;
  for (const candidateId of candidateIds) {
    queueLineage(db, candidateId, "NEW");
    if (remaining > 0) remaining -= workSlice(db, candidateId, remaining, undefined, app);
  }
}

/** One candidate and at most four CALL or bounded NOTE pages per writer transaction. No external side effects. */
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
      app,
    );
    return true;
  }, "memory_lineage_slice");
}
