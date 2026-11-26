import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { AppError } from "../../shared/app-contracts/index.ts";
import type { AppDatabase } from "../app-data/db.ts";
import type { Actor, AuthorizationPolicy } from "../auth/authorization.ts";

/** Internal, signed capability description. HTTP requests never create or accept this object. */
export interface AiSearchBinding {
  contract: "MAP-MEM-3:AI_SEARCH:1";
  workspaceId: string;
  actorId: string;
  roomId: string;
  runId: string;
  planId: string;
  consumerPersonaId: string;
  purpose: "answer";
  audience: "room";
  provider: string;
  model: string;
  inputBinding: { messageId: string; revision: number; seq: number };
  maxArchiveMessageSeq: number;
  excludeMessageId?: string;
  roomRevision: number;
  personaRevision: number;
  requestDigest: string;
  bindingDigest: string;
  signature: string;
}

type Description = Omit<AiSearchBinding, "bindingDigest" | "signature">;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function encoded(binding: Description) {
  return JSON.stringify([
    binding.contract, binding.workspaceId, binding.actorId, binding.roomId,
    binding.runId, binding.planId, binding.consumerPersonaId, binding.purpose,
    binding.audience, binding.provider, binding.model,
    binding.inputBinding?.messageId, binding.inputBinding?.revision,
    binding.inputBinding?.seq, binding.maxArchiveMessageSeq,
    binding.excludeMessageId ?? null, binding.roomRevision,
    binding.personaRevision, binding.requestDigest,
  ]);
}
const denied = () => new AppError("INVALID_AI_CONTEXT_BINDING", 403);
const changed = () => new AppError("CONTEXT_CHANGED", 409);

/** Caller supplies only server-selected execution identities; source bounds come from the accepted run. */
export function createAiSearchBinding(
  app: AppDatabase,
  policy: AuthorizationPolicy,
  actor: Actor,
  input: { runId: string; planId: string; consumerPersonaId: string; provider: string; model: string },
): AiSearchBinding {
  if (Object.values(input).some((v) => typeof v !== "string" || !v || v.length > 256))
    throw denied();
  const run = app.db.prepare("SELECT * FROM app_generation_runs WHERE workspace_id=? AND actor_id=? AND run_id=?")
    .get(actor.workspaceId, actor.actorId, input.runId);
  if (!run) throw denied();
  const accepted = JSON.parse(String(run.request_json));
  const current = accepted.inputBinding;
  if (!current || !accepted.personaIds?.includes(input.consumerPersonaId)) throw denied();
  const description: Description = {
    contract: "MAP-MEM-3:AI_SEARCH:1",
    workspaceId: actor.workspaceId,
    actorId: actor.actorId,
    roomId: String(run.room_id),
    runId: input.runId,
    planId: input.planId,
    consumerPersonaId: input.consumerPersonaId,
    purpose: "answer",
    audience: "room",
    provider: input.provider,
    model: input.model,
    inputBinding: { messageId: current.messageId, revision: current.revision, seq: current.seq },
    maxArchiveMessageSeq: current.seq,
    ...(run.target_message_id ? { excludeMessageId: String(run.target_message_id) } : {}),
    roomRevision: accepted.expectedRoomRevision,
    personaRevision: accepted.personaRevisions?.[input.consumerPersonaId],
    requestDigest: hash(String(run.request_json)),
  };
  const bindingDigest = hash(encoded(description));
  const binding: AiSearchBinding = {
    ...description,
    bindingDigest,
    signature: createHmac("sha256", app.cursorKey).update(bindingDigest).digest("hex"),
  };
  assertAiSearchBinding(app, policy, actor, description.roomId, binding);
  Object.freeze(binding.inputBinding);
  return Object.freeze(binding);
}

/** Workers verify the signature and live database; serialization cannot turn arbitrary metadata into authority. */
export function assertAiSearchBinding(
  app: AppDatabase,
  policy: AuthorizationPolicy,
  actor: Actor,
  roomId: string,
  binding: AiSearchBinding,
): void {
  if (!binding || binding.contract !== "MAP-MEM-3:AI_SEARCH:1" ||
    binding.workspaceId !== actor.workspaceId || binding.actorId !== actor.actorId ||
    binding.roomId !== roomId || binding.purpose !== "answer" || binding.audience !== "room" ||
    !/^[a-f0-9]{64}$/.test(binding.signature ?? "") ||
    !/^[a-f0-9]{64}$/.test(binding.bindingDigest ?? "") ||
    hash(encoded(binding)) !== binding.bindingDigest ||
    !timingSafeEqual(Buffer.from(binding.signature), Buffer.from(createHmac("sha256", app.cursorKey)
      .update(binding.bindingDigest).digest("hex")))) throw denied();
  const target = { workspaceId: actor.workspaceId, roomId, personaId: binding.consumerPersonaId };
  policy.assert(actor, "READ_ROOM", { roomId });
  policy.assert(actor, "GENERATE", target);
  policy.assert(actor, "SEND_TO_PROVIDER", { ...target, provider: binding.provider });
  const run = app.db.prepare("SELECT * FROM app_generation_runs WHERE workspace_id=? AND room_id=? AND actor_id=? AND run_id=?")
    .get(actor.workspaceId, roomId, actor.actorId, binding.runId);
  if (!run || run.session_id !== (actor.sessionId ?? null) || run.state !== "RUNNING" || run.cancelled_at !== null)
    throw new AppError("RUN_NOT_ACTIVE", 409);
  if (hash(String(run.request_json)) !== binding.requestDigest ||
    (run.target_message_id ?? undefined) !== binding.excludeMessageId) throw changed();
  const input = app.db.prepare("SELECT current_revision,seq,role,deleted_at FROM messages WHERE workspace_id=? AND room_id=? AND message_id=?")
    .get(actor.workspaceId, roomId, binding.inputBinding.messageId);
  if (!input || input.deleted_at !== null || input.role !== "user" ||
    input.current_revision !== binding.inputBinding.revision || input.seq !== binding.inputBinding.seq ||
    input.seq !== binding.maxArchiveMessageSeq) throw changed();
  const room = app.db.prepare("SELECT revision,config_json FROM rooms WHERE workspace_id=? AND room_id=? AND deleted_at IS NULL")
    .get(actor.workspaceId, roomId);
  const persona = app.db.prepare(`SELECT rp.persona_revision,r.config_json FROM room_personas rp
    JOIN personas p USING(workspace_id,persona_id) JOIN persona_revisions r ON r.workspace_id=rp.workspace_id
    AND r.persona_id=rp.persona_id AND r.revision=rp.persona_revision
    WHERE rp.workspace_id=? AND rp.room_id=? AND rp.persona_id=? AND p.deleted_at IS NULL`)
    .get(actor.workspaceId, roomId, binding.consumerPersonaId);
  if (!room || room.revision !== binding.roomRevision || !persona || persona.persona_revision !== binding.personaRevision)
    throw changed();
  const config = JSON.parse(String(persona.config_json));
  if (config.isEnabled === false || config.historicalIdentity || (config.model && config.model !== binding.model))
    throw changed();
  const accepted = JSON.parse(String(run.request_json));
  if (!accepted.personaIds?.includes(binding.consumerPersonaId) ||
    (JSON.parse(String(room.config_json)).internalStateSettings?.enabled && accepted.content?.trim() === "/memory"))
    throw denied();
}
