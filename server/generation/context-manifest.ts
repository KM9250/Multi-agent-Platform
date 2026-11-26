import type { ContextPlan, ContextSource } from "../../shared/context-contracts.ts";
import { parseCitation } from "../search/citation.ts";
import { dateRange } from "../search/date.ts";
import type { ContextManifest } from "./context.ts";
import { GenerationError, safeInput, stable } from "./types.ts";

const invalid = (): never => { throw new GenerationError("CONTEXT_MANIFEST_INVALID", 409); };
const isText = (value: unknown, max = 256): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const integer = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number => Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
const digest = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function object(value: any, allowed?: string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    (allowed && Object.keys(value).some(key => !allowed.includes(key)))) invalid();
}
function requireFact(value: unknown): asserts value { if (!value) invalid(); }

export function validateContextPlan(value: unknown): ContextPlan {
  const plan = value as ContextPlan;
  object(plan, ["id", "actorId", "workspaceId", "roomId", "runId", "consumerPersonaId", "purpose", "audience", "provider", "model", "inputBinding", "roomRevision", "personaRevision", "aclRevision", "route", "searches", "sources", "permissions", "packingVersion", "estimatorVersion", "estimatedTokens", "payloadDigest"]);
  requireFact([plan.id, plan.actorId, plan.workspaceId, plan.roomId, plan.runId, plan.consumerPersonaId, plan.provider, plan.model].every(item => isText(item)));
  requireFact(plan.purpose === "answer" && plan.audience === "room" && integer(plan.roomRevision, 1) && integer(plan.personaRevision, 1) && integer(plan.aclRevision, 1));
  object(plan.inputBinding, ["messageId", "revision", "seq", "excludeMessageId"]);
  requireFact(isText(plan.inputBinding.messageId) && integer(plan.inputBinding.revision, 1) && integer(plan.inputBinding.seq, 1) &&
    (plan.inputBinding.excludeMessageId === undefined || isText(plan.inputBinding.excludeMessageId)));
  requireFact(plan.packingVersion === "map-context-pack-v1" && plan.estimatorVersion === "utf8-bytes-div3-v1" && integer(plan.estimatedTokens, 0, 6144) && digest(plan.payloadDigest));
  object(plan.route, ["version", "requestedMode", "mode", "reason", "query", "dateInterpretation", "requiresEvidence", "requiresExactExcerpt", "requiresFullSource"]);
  const route = plan.route;
  requireFact(["map-context-router-v1", "map-context-router-v2"].includes(route.version) && ["auto", "none", "memory", "archive", "both"].includes(route.requestedMode) &&
    ["none", "memory", "archive", "both"].includes(route.mode) && isText(route.reason) && typeof route.requiresEvidence === "boolean" && typeof route.requiresExactExcerpt === "boolean");
  requireFact(route.version === "map-context-router-v1" ? route.requiresFullSource === undefined :
    typeof route.requiresFullSource === "boolean" && (!route.requiresFullSource || route.requiresExactExcerpt));
  object(route.query, ["version", "text", "truncated"]);
  requireFact(route.query.version === "map-context-query-v1" && typeof route.query.text === "string" && route.query.text.length <= 512 && typeof route.query.truncated === "boolean");
  object(route.dateInterpretation, ["version", "status", "source", "timeZone", "range"]);
  const date = route.dateInterpretation;
  requireFact(date.version === "map-context-date-v1" && ["none", "resolved", "ambiguous", "needs_condition"].includes(date.status) &&
    ["none", "explicit", "absolute_text", "relative_text", "year_missing"].includes(date.source) && isText(date.timeZone, 80));
  dateRange({ mode: "strict", anchorDate: "2000-01-15", timeZone: date.timeZone });
  if (date.range) {
    object(date.range, ["mode", "anchorDate", "endDate", "timeZone", "firstDate", "lastDate", "startInclusive", "endExclusive"]);
    requireFact(["strict", "approx"].includes(date.range.mode) && /^\d{4}-\d{2}-\d{2}$/.test(date.range.anchorDate) &&
      date.range.timeZone === date.timeZone && Number.isSafeInteger(date.range.startInclusive) && Number.isSafeInteger(date.range.endExclusive) &&
      date.range.startInclusive < date.range.endExclusive);
    const canonical = dateRange({ mode: date.range.mode, anchorDate: date.range.anchorDate,
      timeZone: date.range.timeZone, ...(date.range.endDate ? { endDate: date.range.endDate } : {}) });
    requireFact(stable(canonical) === stable(date.range));
  }
  requireFact((date.status === "resolved") === !!date.range);
  requireFact(Array.isArray(plan.sources) && plan.sources.length <= 10);
  const aliases = new Set<string>(), resources = new Map<string, string>();
  const counts = { memory: 0, archive: 0 };
  const permissions = new Map<string, unknown>();
  for (const source of plan.sources) {
    object(source, ["alias", "citation", "ownerPersonaId", "scope", "recordedAt", "channel"]);
    requireFact(/^S[1-9]\d?$/.test(source.alias) && !aliases.has(source.alias));
    aliases.add(source.alias);
    let citation: ContextSource["citation"];
    try { citation = parseCitation(source.citation); } catch { invalid(); }
    requireFact(stable(citation) === stable(source.citation) && citation.workspaceId === plan.workspaceId && citation.roomId === plan.roomId);
    requireFact(++counts[citation.target] <= 5 && Number.isSafeInteger(source.recordedAt));
    requireFact(source.ownerPersonaId === null || isText(source.ownerPersonaId));
    requireFact(citation.target === "memory" ? source.scope === "room_shared" && isText(source.ownerPersonaId) && source.channel === "note"
      : source.scope === "public" && ["public_message", "shared_summary"].includes(source.channel));
    const key = citation.target === "memory" ? `memory:${citation.noteId}` : `archive:${citation.segmentId}`;
    const identity = stable({ ...citation, start: undefined, end: undefined });
    requireFact(!resources.has(key) || resources.get(key) === identity);
    resources.set(key, identity);
    const permission = { operation: citation.target === "memory" ? "READ_MEMORY" : "READ_CONVERSATION",
      roomId: plan.roomId, personaId: source.ownerPersonaId ?? "", visibility: source.scope, provider: "" };
    permissions.set(stable(permission), permission);
  }
  requireFact(Array.isArray(plan.permissions) && plan.permissions.length === permissions.size);
  for (const permission of plan.permissions) {
    object(permission, ["operation", "roomId", "personaId", "visibility", "provider"]);
    requireFact(permissions.delete(stable(permission)));
  }
  requireFact(Array.isArray(plan.searches) && plan.searches.length <= 2);
  const targets = new Set<string>();
  for (const search of plan.searches) {
    object(search, ["target", "requestId", "status", "methods", "reasons", "scope", "coverage", "external", "searchOperationIds"]);
    requireFact(["memory", "archive"].includes(search.target) && !targets.has(search.target) && isText(search.requestId));
    targets.add(search.target);
    requireFact(["ready", "partial", "degraded", "unbuilt", "building", "resync_required", "stopped", "unavailable"].includes(search.status));
    requireFact(Array.isArray(search.methods) && search.methods.length <= 3 && search.methods.every(method => ["lexical", "dense", "rerank"].includes(method)));
    requireFact(Array.isArray(search.reasons) && search.reasons.length <= 32 && search.reasons.every(reason => isText(reason)));
    requireFact(Array.isArray(search.searchOperationIds) && search.searchOperationIds.length <= 2 && search.searchOperationIds.every(id => isText(id)));
    object(search.scope); object(search.coverage); object(search.external);
    requireFact(search.scope.roomId === plan.roomId && search.scope.target === search.target && search.scope.revisionMode === "current" && search.coverage.revisionMode === "current");
    requireFact(search.target === "archive" ? !search.methods.includes("dense") && search.scope.personaId === undefined : search.scope.date === undefined);
  }
  for (const source of plan.sources) requireFact(targets.has(source.citation.target));
  requireFact(route.mode === "both" ? targets.size === 2 : route.mode === "none" ? targets.size === 0 : targets.size === 1 && targets.has(route.mode));
  return plan;
}

/** Read released DATA-1 manifests unchanged; an unknown contract is never an empty dependency set. */
export function readContextManifest(value: unknown): ContextManifest {
  try {
    if (typeof value === "string") {
      if (Buffer.byteLength(value, "utf8") > 1_048_576) invalid();
      value = JSON.parse(value);
    }
    safeInput(value);
    const manifest = value as ContextManifest;
    object(manifest, ["contract", "roomId", "roomRevision", "personaId", "personaRevision", "messages", "attachments", "purpose", "audience", "provider", "model", "aclRevision", "estimatedInputTokens", "maxOutputTokens", "thinkingBudget", "retrieval", "payloadDigest"]);
    requireFact(["MAP-DATA-1:SERVER_CONVERSATION:1", "MAP-MEM-3:CONTEXT:1"].includes(manifest.contract));
    requireFact([manifest.roomId, manifest.personaId, manifest.provider, manifest.model].every(item => isText(item)));
    requireFact(integer(manifest.roomRevision, 1) && integer(manifest.personaRevision, 1) && integer(manifest.aclRevision, 1) && integer(manifest.estimatedInputTokens) && integer(manifest.maxOutputTokens, 1));
    requireFact(["decision", "answer", "memory", "subagent"].includes(manifest.purpose) && ["room", "private"].includes(manifest.audience));
    requireFact(manifest.thinkingBudget === undefined || integer(manifest.thinkingBudget, 0, manifest.maxOutputTokens));
    requireFact(Array.isArray(manifest.messages) && manifest.messages.length <= 103 && Array.isArray(manifest.attachments) && manifest.attachments.length <= 1616);
    for (const message of manifest.messages) {
      object(message, ["id", "revision", "revisionId", "segments", "speaker"]);
      requireFact(isText(message.id) && isText(message.revisionId) && integer(message.revision, 1) && Array.isArray(message.segments) && message.segments.length <= 16);
      for (const segment of message.segments) { object(segment, ["id", "digest"]); requireFact(isText(segment.id) && digest(segment.digest)); }
      if (message.speaker) {
        object(message.speaker, ["kind", "personaId", "name", "revision"]);
        requireFact(["human", "persona"].includes(message.speaker.kind) && (message.speaker.personaId === undefined || isText(message.speaker.personaId)) &&
          (message.speaker.name === undefined || typeof message.speaker.name === "string") && (message.speaker.revision === undefined || integer(message.speaker.revision, 1)));
      }
    }
    for (const attachment of manifest.attachments) { object(attachment, ["id", "digest"]); requireFact(isText(attachment.id) && digest(attachment.digest)); }
    if (manifest.contract === "MAP-DATA-1:SERVER_CONVERSATION:1") requireFact(manifest.retrieval === undefined && manifest.payloadDigest === undefined);
    else {
      const plan = validateContextPlan(manifest.retrieval);
      requireFact(manifest.purpose === "answer" && manifest.audience === "room" && digest(manifest.payloadDigest) &&
        plan.roomId === manifest.roomId && plan.consumerPersonaId === manifest.personaId && plan.roomRevision === manifest.roomRevision &&
        plan.personaRevision === manifest.personaRevision && plan.provider === manifest.provider && plan.model === manifest.model && plan.aclRevision === manifest.aclRevision);
    }
    return manifest;
  } catch (error) {
    if (error instanceof GenerationError && error.code === "CONTEXT_MANIFEST_INVALID") throw error;
    return invalid();
  }
}
