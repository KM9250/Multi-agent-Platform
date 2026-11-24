import { runSearchProcess } from "./query-process.ts";
import { basename } from "node:path";
import type { AppDatabase } from "../app-data/db.ts";
import type { Actor, AuthorizationPolicy } from "../auth/authorization.ts";
import { SQLiteSearchBackend, type SearchCandidate } from "./backend.ts";
import { DENSE_LIMITS, plannedFilter } from "./dense-corpus.ts";
import type { DenseScanJob } from "./dense-worker.ts";
import {
  DenseError,
  EMBEDDING_SPACE,
  GoogleEmbeddingProvider,
  type EmbeddingProvider,
  type SearchUsage,
} from "./embedding.ts";
import {
  assertDispatchScope,
  dispatchEmbedding,
  getSearchProfile,
  operationId,
  type MemoryScope,
} from "./profile.ts";
import { SearchSources } from "./sources.ts";

function providerOrEnv(provider?: EmbeddingProvider) {
  return (
    provider ??
    (process.env.GEMINI_API_KEY
      ? new GoogleEmbeddingProvider(process.env.GEMINI_API_KEY)
      : undefined)
  );
}
function knownError(error: unknown, signal: AbortSignal) {
  if (signal.aborted) return "deadline_or_cancelled";
  return error instanceof DenseError ? error.message : "dense_unavailable";
}
function deadline(ms: number, signal?: AbortSignal) {
  return AbortSignal.any(
    signal ? [signal, AbortSignal.timeout(ms)] : [AbortSignal.timeout(ms)],
  );
}

/** Called only inside the explicitly enabled generation worker. Each operation has its own intent. */
export async function buildDenseIndex(
  app: AppDatabase,
  policy: AuthorizationPolicy,
  actor: Actor,
  roomId: string,
  indexPath: string,
  signal?: AbortSignal,
  provider?: EmbeddingProvider,
) {
  const profile = getSearchProfile(app, actor, roomId);
  const coverage = {
    state: "profile_unconfigured",
    planned: 0,
    indexed: 0,
    spaceId: profile?.spaceId ?? null,
    profileVersion: profile?.version ?? null,
  };
  if (!profile) return coverage;
  if (!profile.purposes.includes("DOCUMENT_EMBEDDING"))
    return { ...coverage, state: "documents_disabled" };
  const adapter = providerOrEnv(provider);
  if (!adapter) return { ...coverage, state: "unconfigured_provider" };
  const until = deadline(DENSE_LIMITS.documentJobMs, signal);
  const index = new SQLiteSearchBackend(indexPath);
  try {
    const sources = new SearchSources(app, policy, actor, roomId);
    sources.assertRoom("memory");
    const filter = plannedFilter(index, sources, profile);
    const rows = sources.withCandidateSnapshot("memory", () =>
      index.db
        .prepare(
          `SELECT c.id,c.ref,c.visibility,c.start,c.end FROM chunks c WHERE ${filter.sql}
      ORDER BY c.id LIMIT ?`,
        )
        .all(...filter.params, DENSE_LIMITS.chunks + 1),
    );
    coverage.planned = rows.length;
    if (
      rows.length > DENSE_LIMITS.chunks ||
      rows.length * EMBEDDING_SPACE.dimensions * 4 > DENSE_LIMITS.bytes
    )
      return { ...coverage, state: "dense_limit" };
    const present = index.db.prepare(
      "SELECT 1 FROM search_vectors WHERE chunk_id=? AND operation_id=? AND space_id=? AND length(vector)=?",
    );
    const save = index.db.prepare(
      "INSERT OR REPLACE INTO search_vectors(chunk_id,space_id,operation_id,vector) VALUES(?,?,?,?)",
    );
    for (const row of rows) {
      until.throwIfAborted();
      const ref = JSON.parse(String(row.ref));
      const citation = {
        ...ref,
        start: Number(row.start),
        end: Number(row.end),
      };
      const operationKey = JSON.stringify([
        basename(indexPath),
        profile.version,
        row.id,
      ]);
      const id = operationId(actor, roomId, "DOCUMENT_EMBEDDING", operationKey);
      if (
        !present.get(
          row.id,
          id,
          profile.spaceId,
          EMBEDDING_SPACE.dimensions * 4,
        )
      ) {
        const readText = () => {
          const source = sources.resolve(citation);
          if (
            source.personaId !== profile.personaId ||
            source.visibility !== row.visibility ||
            !profile.scopes.includes(source.visibility as MemoryScope)
          )
            throw new DenseError("scope_unavailable");
          return source.text;
        };
        const result = await dispatchEmbedding(app, policy, adapter, {
          actor,
          roomId,
          profile,
          scopes: [row.visibility as MemoryScope],
          purpose: "DOCUMENT_EMBEDDING",
          operationKey,
          sourceRef: JSON.stringify(citation),
          signal: deadline(DENSE_LIMITS.dispatchMs, until),
          readText,
        });
        const blob = Buffer.alloc(result.vector.length * 4);
        result.vector.forEach((n, i) => blob.writeFloatLE(n, 4 * i));
        app.transaction(() => {
          assertDispatchScope(
            app,
            policy,
            actor,
            roomId,
            profile,
            "DOCUMENT_EMBEDDING",
            [row.visibility as MemoryScope],
          );
          readText();
          save.run(row.id, profile.spaceId, result.operationId, blob);
        }, "search-adopt-vector");
      }
      coverage.indexed++;
    }
    return { ...coverage, state: "ready" };
  } catch (error) {
    return { ...coverage, state: knownError(error, until) };
  } finally {
    index.close();
  }
}

let running = 0;
type ScanResult = { state: string; candidates: SearchCandidate[] };
function runScan(job: DenseScanJob, signal: AbortSignal): Promise<ScanResult> {
  return runSearchProcess(
    new URL("./dense-worker.ts", import.meta.url),
    job,
    signal,
  );
}

export interface DenseResult extends ScanResult {
  external: { calls: number; usage: SearchUsage["completeness"] | "NONE" };
}
export async function searchDense(
  app: AppDatabase,
  policy: AuthorizationPolicy,
  actor: Actor,
  roomId: string,
  indexPath: string,
  query: string,
  requestId: string,
  options: {
    personaId?: string;
    signal?: AbortSignal;
    provider?: EmbeddingProvider;
  } = {},
): Promise<DenseResult> {
  const external: DenseResult["external"] = { calls: 0, usage: "NONE" };
  const empty = (state: string): DenseResult => ({
    state,
    candidates: [],
    external,
  });
  const profile = getSearchProfile(app, actor, roomId);
  if (!profile) return empty("profile_unconfigured_or_stopped");
  if (
    options.personaId !== undefined &&
    profile.personaId !== options.personaId
  )
    return empty("profile_scope");
  if (!profile.purposes.includes("QUERY_EMBEDDING"))
    return empty("query_disabled");
  const adapter = providerOrEnv(options.provider);
  if (!adapter) return empty("unconfigured_provider");
  if (running >= DENSE_LIMITS.workers) return empty("worker_saturated");
  running++;
  const signal = deadline(DENSE_LIMITS.deadlineMs, options.signal);
  let attempted = false;
  const key = operationId(actor, roomId, "QUERY_EMBEDDING", requestId);
  try {
    assertDispatchScope(
      app,
      policy,
      actor,
      roomId,
      profile,
      "QUERY_EMBEDDING",
      profile.scopes,
    );
    const job: DenseScanJob = {
      root: app.root,
      appPath: app.path,
      indexPath,
      actor,
      roomId,
      idleTimeoutMs: policy.idleTimeoutMs,
      profileVersion: profile.version,
    };
    const preflight = await runScan(job, signal);
    if (preflight.state !== "ready") return empty(preflight.state);
    const measured: EmbeddingProvider = {
      spaceId: adapter.spaceId,
      embed(req) {
        attempted = true;
        return adapter.embed(req);
      },
    };
    const embedded = await dispatchEmbedding(app, policy, measured, {
      actor,
      roomId,
      profile,
      scopes: profile.scopes,
      purpose: "QUERY_EMBEDDING",
      operationKey: requestId,
      signal,
      readText: () => query,
    });
    const scored = await runScan({ ...job, query: embedded.vector }, signal);
    assertDispatchScope(
      app,
      policy,
      actor,
      roomId,
      profile,
      "QUERY_EMBEDDING",
      profile.scopes,
    );
    return { ...scored, external };
  } catch (error) {
    return empty(knownError(error, signal));
  } finally {
    running--;
    if (attempted) {
      external.calls = 1;
      const receipt = app.db
        .prepare(
          "SELECT usage_json FROM search_operations WHERE operation_id=?",
        )
        .get(key);
      external.usage = receipt?.usage_json
        ? JSON.parse(String(receipt.usage_json)).completeness
        : "UNKNOWN";
    }
  }
}

/** Rank one starts at 1. A list can contribute only once for a stable business key. */
export function fuseRanks<T>(
  lists: readonly (readonly T[])[],
  key: (item: T) => string,
  k = 60,
): T[] {
  if (!Number.isFinite(k) || k <= 0)
    throw new DenseError("invalid_rrf_constant");
  const merged = new Map<string, { item: T; score: number }>();
  for (const list of lists) {
    const seen = new Set<string>();
    for (const item of list) {
      const id = key(item);
      if (seen.has(id)) continue;
      seen.add(id);
      const entry = merged.get(id) ?? { item, score: 0 };
      entry.score += 1 / (k + seen.size);
      merged.set(id, entry);
    }
  }
  return [...merged.entries()]
    .sort(([a, x], [b, y]) => y.score - x.score || (a < b ? -1 : 1))
    .map(([, entry]) => entry.item);
}
