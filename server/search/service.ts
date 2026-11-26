import { AppError } from "../../shared/app-contracts/index.ts";
import type {
  SearchAudience,
  SearchResponse,
} from "../../shared/search-contracts.ts";
import type { SearchCitation } from "../../shared/search-sources.ts";
import type { AppDatabase } from "../app-data/db.ts";
import type { Actor, AuthorizationPolicy } from "../auth/authorization.ts";
import type { SearchCandidate } from "./backend.ts";
import { dateLayer } from "./date.ts";
import { searchDense, fuseRanks } from "./dense.ts";
import {
  acquireActiveIndex,
  isIndexUpdatePending,
  requestIndexUpdate,
} from "./index.ts";
import { getSearchProfile, type SearchProfile } from "./profile.ts";
import { searchInput } from "./input.ts";
import { lexicalQuery } from "./query-process.ts";
import { SearchSources } from "./sources.ts";
import { withVerifiedNoteAncestors } from "../memory/source-validation.ts";
import { assertAiSearchBinding, type AiSearchBinding } from "./ai-binding.ts";

export type AiSearchResponse = SearchResponse & { generationId?: string };

const DEADLINE_MS = 10_000;
const MAX_CONCURRENT = 4;
let running = 0;
function overlaps(a: SearchCitation, b: SearchCitation) {
  const same =
    a.target === "memory" && b.target === "memory"
      ? a.noteId === b.noteId
      : a.target === "archive" &&
        b.target === "archive" &&
        a.segmentId === b.segmentId;
  return same && a.version === b.version && a.start < b.end && b.start < a.end;
}
function isAccessError(e: unknown) {
  const status = (e as { status?: number })?.status;
  return status === 401 || status === 403 || status === 404;
}
function stopsAiRun(error: unknown) {
  const code = (error as { code?: string; message?: string })?.code ??
    (error as { message?: string })?.message;
  return ["OUTCOME_UNKNOWN", "SEARCH_OUTCOME_UNKNOWN", "RUN_NOT_ACTIVE", "CONTEXT_CHANGED",
    "INVALID_AI_CONTEXT_BINDING", "AUTHORIZATION_CHANGED", "run_unavailable", "invalid_run_binding",
    "profile_changed_or_disabled", "source_changed"].includes(code);
}

/** The public search API deliberately accepts only the human audience. */
export async function searchRoom(
  app: AppDatabase,
  policy: AuthorizationPolicy,
  actor: Actor,
  roomId: string,
  req: ReturnType<typeof searchInput>,
  audience: SearchAudience,
  clientSignal?: AbortSignal,
): Promise<SearchResponse> {
  if (
    audience.purpose !== "human" ||
    audience.roomId !== roomId ||
    audience.scope !== req.target
  )
    throw new AppError("FORBIDDEN", 403);
  return searchInternal(app, policy, actor, roomId, req, clientSignal);
}

/** Generation-only entry. Its signed binding is constructed from an accepted, live run. */
export async function searchAiContext(
  app: AppDatabase,
  policy: AuthorizationPolicy,
  actor: Actor,
  roomId: string,
  req: ReturnType<typeof searchInput>,
  binding: AiSearchBinding,
  signal?: AbortSignal,
): Promise<AiSearchResponse> {
  assertAiSearchBinding(app, policy, actor, roomId, binding);
  if (req.revisionMode !== "current") throw new AppError("AI_CURRENT_REVISION_REQUIRED", 400);
  if (signal?.aborted) throw signal.reason;
  return searchInternal(app, policy, actor, roomId, req, signal, binding);
}

async function searchInternal(
  app: AppDatabase,
  policy: AuthorizationPolicy,
  actor: Actor,
  roomId: string,
  req: ReturnType<typeof searchInput>,
  clientSignal?: AbortSignal,
  aiBinding?: AiSearchBinding,
): Promise<AiSearchResponse> {
  const start = performance.now();
  const sources = new SearchSources(app, policy, actor, roomId, aiBinding);
  sources.assertRoom(req.target);
  const acl = policy.revision(actor);
  const response: AiSearchResponse = {
    results: [],
    methods: [],
    reasons: [],
    status: "ready",
    elapsedMs: 0,
    scope: {
      roomId,
      target: req.target,
      revisionMode: req.revisionMode,
      ...(req.personaId ? { personaId: req.personaId } : {}),
      ...(req.date ? { date: req.date } : {}),
    },
    coverage: {
      indexState: "UNBUILT",
      revisionMode: req.revisionMode,
      planned: [
        req.target === "archive" ? "authorized_segments" : "published_notes",
      ],
    },
    external: { status: "none", calls: 0 },
    verification: { checked: 0, excluded: 0 },
  };
  const active = acquireActiveIndex(app, policy, actor, roomId);
  const finish = () => {
    if (aiBinding && clientSignal?.aborted) throw clientSignal.reason;
    if (policy.revision(actor) !== acl)
      throw new AppError("SEARCH_RESYNC_REQUIRED", 409);
    sources.assertRoom(req.target);
    if (active.state === "ACTIVE" && !aiBinding)
      response.coverage.updating = isIndexUpdatePending(active);
    response.elapsedMs = Math.round(performance.now() - start);
    return response;
  };
  response.coverage.indexState = active.state;
  if (active.state !== "ACTIVE") {
    if (active.state !== "STOPPED")
      void requestIndexUpdate(app, policy, actor, roomId).catch(() => {});
    response.status =
      active.state === "UNBUILT"
        ? "unbuilt"
        : active.state === "BUILDING"
          ? "building"
          : active.state === "RESYNC_REQUIRED"
            ? "resync_required"
            : active.state === "STOPPED"
              ? "stopped"
              : "unavailable";
    response.reasons.push(
      active.reason === "SEARCH_FILE_MISSING"
        ? "SEARCH_FILE_MISSING"
        : active.state,
    );
    return finish();
  }
  if (aiBinding) response.generationId = active.generationId;
  else response.coverage.syncedAt = active.syncedAt;
  if (active.reason && !aiBinding) {
    response.status = "partial";
    response.reasons.push("INDEX_REFRESH_FAILED");
  }
  if (running >= MAX_CONCURRENT) {
    response.status = "partial";
    response.reasons.push("QUEUE_FULL");
    return finish();
  }
  running++;
  const timeout = AbortSignal.timeout(DEADLINE_MS);
  const signal = clientSignal
    ? AbortSignal.any([timeout, clientSignal])
    : timeout;
  try {
    // Pin the requested policy before starting either method. Dispatch rechecks it after lexical work.
    let profile: SearchProfile | null = null;
    let includeDense = false;
    if (req.target === "memory" && req.retrievalMode !== "lexical") {
      try {
        profile = getSearchProfile(app, actor, roomId);
        includeDense =
          (!aiBinding && req.retrievalMode === "hybrid") ||
          !!(
            profile?.purposes.includes("QUERY_EMBEDDING") &&
            (!req.personaId || profile.personaId === req.personaId) &&
            (!aiBinding || (profile.aiContext?.queryEmbedding === true &&
              profile.aiContext.consumerPersonaIds.includes(aiBinding.consumerPersonaId) &&
              profile.scopes.includes("room_shared")))
          );
      } catch (error) {
        if (isAccessError(error)) throw error;
        response.coverage.denseState = "dense_unavailable";
        response.reasons.push("dense_unavailable");
        if (response.status === "ready") response.status = "degraded";
      }
    }
    const includeHistory = req.revisionMode === "include_history";
    const lexical = await lexicalQuery(
      {
        root: app.root,
        appPath: app.path,
        indexPath: active.path,
        cursor: active.manifest.positions?.[req.target],
        roomId,
        actor,
        idleTimeoutMs: policy.idleTimeoutMs,
        target: req.target,
        query: req.query,
        includeHistory,
        personaId: req.personaId,
        from: req.date?.startInclusive,
        until: req.date?.endExclusive,
        aiBinding,
      },
      signal,
    );
    response.methods.push("lexical");
    if (lexical.lagging) {
      response.reasons.push("INDEX_LAGGING");
      response.status = "partial";
    }
    void requestIndexUpdate(app, policy, actor, roomId, {
      force: lexical.lagging,
    }).catch(() => {
      /* The worker records job failures. */
    });

    let ranked = lexical.hits;
    if (includeDense) {
      if (policy.revision(actor) !== acl)
        throw new AppError("SEARCH_RESYNC_REQUIRED", 409);
      // Keep part of the request deadline for resolving lexical citations after a slow provider.
      const remaining = Math.max(
        0,
        Math.floor(DEADLINE_MS - 1000 - (performance.now() - start)),
      );
      const denseSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(remaining),
      ]);
      const dense = await searchDense(
        app,
        policy,
        actor,
        roomId,
        active.path,
        req.query,
        req.requestId,
        {
          personaId: req.personaId,
          profile,
          signal: denseSignal,
          aiBinding,
        },
      ).catch((error) => {
        if (aiBinding && (clientSignal?.aborted || stopsAiRun(error))) throw error;
        if (isAccessError(error)) throw error;
        return {
          state: "dense_unavailable",
          candidates: [],
          external: { calls: undefined, usage: "UNKNOWN" },
        };
      });
      response.external = {
        status:
          dense.external.calls === undefined
            ? "unknown"
            : dense.external.calls
              ? "dispatched"
              : "none",
        ...dense.external,
      };
      response.coverage.denseState = dense.state;
      if (dense.state === "ready") {
        response.methods.push("dense");
        ranked = fuseRanks<SearchCandidate>(
          [ranked, dense.candidates],
          (hit) => hit.id,
        );
      } else {
        response.reasons.push(dense.state);
        if (response.status === "ready") response.status = "degraded";
      }
    }
    if (policy.revision(actor) !== acl)
      throw new AppError("SEARCH_RESYNC_REQUIRED", 409);
    // The lexical and optional dense workers have finished. Only verified original text is serialized.
    for (const hit of ranked) {
      if (
        response.results.length >= req.limit ||
        response.verification.checked >= 200
      )
        break;
      if (signal.aborted || performance.now() - start >= DEADLINE_MS) {
        response.status = "partial";
        response.reasons.push("DEADLINE_EXCEEDED");
        break;
      }
      if (
        response.results.some((result) =>
          overlaps(result.citation, hit.citation),
        )
      )
        continue;
      response.verification.checked++;
      try {
        const {
          text,
          citation,
          current,
          recordedAt,
          personaId,
          speakerId,
          role,
          channel,
          visibility,
          revisionKind,
        } = hit.citation.target === "memory"
          ? await withVerifiedNoteAncestors(app, [hit.citation.noteId],
            () => sources.resolve(hit.citation, { includeHistory }), signal)
          : sources.resolve(hit.citation, { includeHistory });
        if (
          (req.personaId && req.personaId !== personaId) ||
          (req.date &&
            (recordedAt < req.date.startInclusive ||
              recordedAt >= req.date.endExclusive))
        )
          continue;
        response.results.push({
          snippet: text,
          citation,
          current,
          recordedAt,
          personaId,
          speakerId,
          role,
          channel,
          visibility,
          ...(revisionKind ? { revisionKind } : {}),
          ...(req.date?.mode === "approx"
            ? { dateLayer: dateLayer(req.date, recordedAt) }
            : {}),
        });
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (aiBinding && ["RUN_NOT_ACTIVE", "CONTEXT_CHANGED", "INVALID_AI_CONTEXT_BINDING"].includes(code)) throw e;
        if (code === "UNAUTHENTICATED") throw e;
        response.verification.excluded++;
        const reason = [
          "FORBIDDEN",
          "NOT_FOUND",
          "MEMORY_UNAVAILABLE",
          "SOURCE_CHANGED",
        ].includes(code)
          ? "SOURCE_CHANGED"
          : "SOURCE_VERIFICATION_UNAVAILABLE";
        if (!response.reasons.includes(reason)) response.reasons.push(reason);
      }
    }
    if (lexical.limited || response.verification.checked >= 200) {
      response.reasons.push("CANDIDATE_LIMIT");
      if (response.results.length < req.limit) response.status = "partial";
    }
    if (response.verification.excluded) {
      response.status = "partial";
    }
  } catch (e) {
    if (aiBinding && (clientSignal?.aborted || stopsAiRun(e))) throw e;
    if (
      isAccessError(e) ||
      (e as { code?: string }).code === "SEARCH_RESYNC_REQUIRED"
    )
      throw e;
    const code = (e as { code?: string }).code;
    if (code === "SEARCH_CURSOR_INVALID") {
      response.status = "resync_required";
      response.coverage.indexState = "RESYNC_REQUIRED";
      response.reasons.push("SEARCH_RESYNC_REQUIRED");
      void requestIndexUpdate(app, policy, actor, roomId, {
        rebuild: true,
      }).catch(() => {});
    } else {
      response.status = response.methods.length ? "partial" : "unavailable";
      response.reasons.push(
        signal.aborted
          ? "DEADLINE_EXCEEDED"
          : code === "SEARCH_FRESHNESS_UNAVAILABLE"
            ? "INDEX_FRESHNESS_UNAVAILABLE"
            : "INDEX_UNAVAILABLE",
      );
    }
  } finally {
    running--;
  }
  return finish();
}
