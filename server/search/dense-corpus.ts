import type { AppDatabase } from "../app-data/db.ts";
import type { AuthorizationPolicy, Actor } from "../auth/authorization.ts";
import { SQLiteSearchBackend, type SearchCandidate } from "./backend.ts";
import { type MemoryScope, type SearchProfile } from "./profile.ts";
import { EMBEDDING_SPACE, DenseError } from "./embedding.ts";
import { SearchSources } from "./sources.ts";

export const DENSE_LIMITS = Object.freeze({
  chunks: 10_000,
  bytes: 24 * 1024 * 1024,
  candidates: 100,
  workers: 2,
  queued: 0,
  deadlineMs: 8_000,
  documentJobMs: 10 * 60_000,
  dispatchMs: 12_000,
});

export function plannedFilter(
  index: SQLiteSearchBackend,
  sources: SearchSources,
  profile: SearchProfile,
) {
  return index.allowed({
    target: "memory",
    personaId: profile.personaId,
    eligible: (ref, history) => sources.eligible(ref, history),
    allowsScope: (target, persona, visibility, channel) =>
      target === "memory" &&
      persona === profile.personaId &&
      profile.scopes.includes(visibility as MemoryScope) &&
      sources.allowsScope(target, persona, visibility, channel),
  });
}

/** Runs in an isolated process. All admissible vectors participate or the entire dense route is skipped. */
export function scanCorpus(
  app: AppDatabase,
  policy: AuthorizationPolicy,
  actor: Actor,
  roomId: string,
  index: SQLiteSearchBackend,
  profile: SearchProfile,
  query?: Float32Array,
) {
  const sources = new SearchSources(app, policy, actor, roomId);
  sources.assertRoom("memory");
  const filter = plannedFilter(index, sources, profile);
  const rows = sources.withCandidateSnapshot("memory", () =>
    index.db
      .prepare(
        `SELECT c.id,c.ref,c.start,c.end,v.operation_id,v.space_id,length(v.vector) AS size
    FROM chunks c LEFT JOIN search_vectors v ON v.chunk_id=c.id WHERE ${filter.sql} LIMIT ?`,
      )
      .all(...filter.params, DENSE_LIMITS.chunks + 1),
  );
  const empty: SearchCandidate[] = [];
  if (
    rows.length > DENSE_LIMITS.chunks ||
    rows.reduce((sum, r) => sum + Number(r.size ?? 0), 0) > DENSE_LIMITS.bytes
  )
    return { state: "dense_limit", candidates: empty };
  if (!rows.length) return { state: "no_dense_coverage", candidates: empty };
  const receipt = app.db
    .prepare(`SELECT source_ref FROM search_operations WHERE workspace_id=? AND actor_id=?
    AND room_id=? AND profile_version=? AND operation_id=? AND purpose='DOCUMENT_EMBEDDING' AND state='SUCCEEDED'`);
  const scores: { id: string; score: number }[] = [];
  const get = index.db.prepare(
    "SELECT vector FROM search_vectors WHERE chunk_id=? AND space_id=? AND operation_id=?",
  );
  for (const row of rows) {
    const citation = {
      ...JSON.parse(String(row.ref)),
      start: row.start,
      end: row.end,
    };
    if (
      row.space_id !== profile.spaceId ||
      Number(row.size) !== EMBEDDING_SPACE.dimensions * 4 ||
      receipt.get(
        actor.workspaceId,
        actor.actorId,
        roomId,
        profile.version,
        row.operation_id,
      )?.source_ref !== JSON.stringify(citation)
    )
      return { state: "incomplete_dense_coverage", candidates: empty };
    if (!query) continue;
    const data = get.get(row.id, row.space_id, row.operation_id)?.vector;
    if (!(data instanceof Uint8Array) || data.byteLength !== query.length * 4)
      throw new DenseError("invalid_vector");
    const values = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let dot = 0,
      norm = 0;
    for (let i = 0; i < query.length; i++) {
      const v = values.getFloat32(4 * i, true);
      dot += v * query[i];
      norm += v * v;
    }
    if (!(norm > 0) || !Number.isFinite(dot) || !Number.isFinite(norm))
      throw new DenseError("invalid_vector");
    scores.push({ id: String(row.id), score: dot / Math.sqrt(norm) });
  }
  scores.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  const byId = index.db.prepare("SELECT * FROM chunks WHERE id=?");
  return {
    state: "ready",
    candidates: scores
      .slice(0, DENSE_LIMITS.candidates)
      .map(({ id, score }) => index.candidate(byId.get(id)!, score)),
  };
}
