import type { Actor, AuthorizationPort } from "../../shared/app-contracts/index.ts";
import type { AnswerContextDTO, AnswerSourceDTO } from "../../shared/context-citations.ts";
import { citedSourceAliases } from "../../shared/context-citations.ts";
import type { AppDatabase } from "../app-data/db.ts";
import { digest } from "../app-data/validation.ts";
import { readContextManifest } from "./context-manifest.ts";

/** Derive a bounded public sidecar from the receipt for this exact saved answer revision. */
export function answerContext(
  app: AppDatabase,
  policy: AuthorizationPort,
  actor: Actor,
  roomId: string,
  messageId: string,
  revision: number,
  publicText: string,
): AnswerContextDTO | undefined {
  const rows = app.db.prepare(`SELECT c.call_id,c.manifest_json,c.manifest_digest,c.run_id,c.persona_id,c.provider,c.model,
      g.actor_id,g.request_json,g.target_message_id
    FROM app_generation_receipts r JOIN app_provider_calls c
      ON c.workspace_id=r.workspace_id AND c.room_id=r.room_id AND c.run_id=r.run_id AND c.call_id=r.call_id
    JOIN app_generation_runs g ON g.workspace_id=c.workspace_id AND g.room_id=c.room_id AND g.run_id=c.run_id
    JOIN messages m ON m.workspace_id=r.workspace_id AND m.room_id=r.room_id AND m.message_id=r.message_id
      AND m.role='model' AND m.persona_id=c.persona_id
    WHERE r.workspace_id=? AND r.room_id=? AND r.message_id=? AND r.revision=?
      AND r.status='COMPLETED' AND c.state='COMPLETED' AND c.purpose='answer' LIMIT 2`)
    .all(actor.workspaceId, roomId, messageId, revision);
  // A corrected answer has no matching generation receipt. Multiple receipts are not interchangeable.
  if (rows.length !== 1) return undefined;
  const row = rows[0];
  const unavailable: AnswerContextDTO = {
    contract: "MAP-MEM-3:CONTEXT:1", messageId, revision, receiptId: String(row.call_id),
    mode: "none", state: "unavailable", searches: [], supplied: [], citedAliases: [],
  };
  try {
    if (digest(String(row.manifest_json)) !== row.manifest_digest) return unavailable;
    const manifest = readContextManifest(String(row.manifest_json));
    if (manifest.contract !== "MAP-MEM-3:CONTEXT:1") return undefined;
    const plan = manifest.retrieval;
    const accepted = JSON.parse(String(row.request_json)).inputBinding;
    if (!plan || plan.workspaceId !== actor.workspaceId || plan.roomId !== roomId ||
        plan.runId !== row.run_id || plan.consumerPersonaId !== row.persona_id ||
        plan.actorId !== row.actor_id || plan.provider !== row.provider || plan.model !== row.model ||
        !accepted || plan.inputBinding.messageId !== accepted.messageId ||
        plan.inputBinding.revision !== accepted.revision || plan.inputBinding.seq !== accepted.seq ||
        plan.inputBinding.excludeMessageId !== (row.target_message_id ?? undefined) ||
        plan.purpose !== "answer" || plan.audience !== "room" || plan.sources.length > 10)
      return unavailable;
    let hidden = false;
    const supplied: AnswerSourceDTO[] = [];
    for (const source of plan.sources) {
      const citation = source.citation;
      if (citation.roomId !== roomId || citation.workspaceId !== actor.workspaceId ||
          !/^S[1-9][0-9]*$/.test(source.alias) || supplied.some(item => item.alias === source.alias))
        return unavailable;
      try {
        const target = { roomId, personaId: source.ownerPersonaId ?? undefined,
          visibility: source.scope };
        if (citation.target === "memory") {
          if (source.scope !== "room_shared" || !source.ownerPersonaId) return unavailable;
          policy.assert(actor, "READ_MEMORY", target);
        } else {
          if (source.scope !== "public" || !["public_message", "shared_summary"].includes(source.channel))
            return unavailable;
          policy.assert(actor, "READ_CONVERSATION", target);
        }
        // Construct fields explicitly. The internal plan may contain further audit evidence.
        const ref = citation.target === "memory" ? {
          target: "memory" as const, noteId: citation.noteId,
          fileDigest: citation.fileDigest, bodyDigest: citation.bodyDigest,
        } : {
          target: "archive" as const, messageId: citation.messageId, revisionId: citation.revisionId,
          segmentId: citation.segmentId, segmentDigest: citation.segmentDigest,
        };
        supplied.push({ alias: source.alias, recordedAt: source.recordedAt, citation: {
          ...ref, workspaceId: citation.workspaceId, roomId: citation.roomId,
          version: citation.version, start: citation.start, end: citation.end,
        } });
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (status !== 403 && status !== 404) throw error;
        hidden = true;
      }
    }
    return {
      ...unavailable,
      mode: plan.route.mode,
      state: hidden || plan.searches.some(search => search.status !== "ready") ? "partial" : "ready",
      searches: plan.searches.map(search => ({ target: search.target, status: search.status,
        found: supplied.some(source => source.citation.target === search.target) })),
      supplied,
      citedAliases: citedSourceAliases(publicText, new Set(supplied.map(source => source.alias))),
    };
  } catch (error) {
    if ((error as { status?: number }).status === 401) throw error;
    // An unrecognized/invalid receipt is explicitly unavailable, never a valid empty provenance.
    return unavailable;
  }
}
