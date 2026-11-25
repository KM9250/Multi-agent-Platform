import { basename } from "node:path";
import type { AppDatabase } from "../app-data/db.ts";
import type { AuthorizationPolicy, Actor } from "../auth/authorization.ts";
import type { MemoryRef, SearchSource } from "../../shared/search-sources.ts";
import { SQLiteSearchBackend, type SearchCandidate } from "./backend.ts";
import {
  decodeProfile,
  operationId,
  type MemoryScope,
  type SearchProfile,
} from "./profile.ts";
import { EMBEDDING_SPACE, formattedInput, hash } from "./embedding.ts";
import { SearchSources, isSourceBoundary } from "./sources.ts";

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

function plannedFilter(
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

export function documentOperationKey(
  path: string,
  profileVersion: number,
  chunkId: string,
) {
  // Match operations written by the initial MEM-2 release. File names identify one pinned generation.
  return JSON.stringify([basename(path), profileVersion, chunkId]);
}

interface PlannedChunk {
  id: string;
  ref: MemoryRef;
  start: number;
  end: number;
  visibility: MemoryScope;
}
interface CorpusInspection {
  state:
    | "ready"
    | "no_dense_coverage"
    | "incomplete_dense_coverage"
    | "dense_limit";
  planned: number;
  indexed: number;
  missing: PlannedChunk[];
  candidates: SearchCandidate[];
}

function cosine(vector: unknown, query?: Float32Array) {
  if (
    !(vector instanceof Uint8Array) ||
    vector.byteLength !== EMBEDDING_SPACE.dimensions * 4
  )
    return null;
  const values = new DataView(
    vector.buffer,
    vector.byteOffset,
    vector.byteLength,
  );
  let dot = 0,
    norm = 0;
  for (let i = 0; i < EMBEDDING_SPACE.dimensions; i++) {
    const v = values.getFloat32(4 * i, true);
    norm += v * v;
    if (query) dot += v * query[i];
  }
  // The installed space stores unit-normalized float32 values. Reject corrupt/non-finite blobs on preflight too.
  if (
    !Number.isFinite(norm) ||
    Math.abs(norm - 1) > 1e-4 ||
    !Number.isFinite(dot)
  )
    return null;
  return dot / Math.sqrt(norm);
}

/** Check the entire authorized plan before a query dispatch or a bounded exact scan.
 * Historical profile and receipt prove how an installed vector was created. They grant no current rights.
 */
export function scanCorpus(
  app: AppDatabase,
  policy: AuthorizationPolicy,
  actor: Actor,
  roomId: string,
  index: SQLiteSearchBackend,
  indexPath: string,
  profile: SearchProfile,
  query?: Float32Array,
): CorpusInspection {
  const sources = new SearchSources(app, policy, actor, roomId);
  const filter = plannedFilter(index, sources, profile);
  const rows = sources.withCandidateSnapshot("memory", () =>
    index.db
      .prepare(
        `SELECT c.id,c.ref,c.visibility,c.start,c.end,
    v.operation_id,v.space_id,length(v.vector) AS size FROM chunks c LEFT JOIN search_vectors v ON v.chunk_id=c.id
    WHERE ${filter.sql} ORDER BY c.source_id,c.start LIMIT ?`,
      )
      .all(...filter.params, DENSE_LIMITS.chunks + 1),
  );
  const result: CorpusInspection = {
    state: "no_dense_coverage",
    planned: rows.length,
    indexed: 0,
    missing: [],
    candidates: [],
  };
  if (
    rows.length > DENSE_LIMITS.chunks ||
    rows.length * EMBEDDING_SPACE.dimensions * 4 > DENSE_LIMITS.bytes ||
    rows.reduce((size, row) => size + Number(row.size ?? 0), 0) >
      DENSE_LIMITS.bytes
  )
    return { ...result, state: "dense_limit" };
  if (!rows.length) return result;

  const receipt = app.db
    .prepare(`SELECT o.payload_digest,o.source_ref,p.version,p.config_json,p.config_digest,p.space_id,p.provider,p.model
    FROM search_operations o JOIN search_profiles p ON p.workspace_id=o.workspace_id AND p.actor_id=o.actor_id
    AND p.room_id=o.room_id AND p.version=o.profile_version
    WHERE o.workspace_id=? AND o.actor_id=? AND o.room_id=? AND o.operation_id=?
    AND o.state='SUCCEEDED' AND o.purpose='DOCUMENT_EMBEDDING'`);
  const loadVector = index.db.prepare(
    "SELECT vector FROM search_vectors WHERE chunk_id=? AND operation_id=? AND space_id=?",
  );
  const scores: { id: string; score: number }[] = [];
  let previousRef = "",
    source: SearchSource | undefined;
  const compatibleScore = (row: (typeof rows)[number], chunk: PlannedChunk) => {
    if (
      chunk.ref.target !== "memory" ||
      row.space_id !== profile.spaceId ||
      row.size !== EMBEDDING_SPACE.dimensions * 4
    )
      return null;

    const origin = receipt.get(
      actor.workspaceId,
      actor.actorId,
      roomId,
      row.operation_id,
    );
    const citation = { ...chunk.ref, start: chunk.start, end: chunk.end };
    if (
      !origin ||
      origin.space_id !== profile.spaceId ||
      origin.source_ref !== JSON.stringify(citation)
    )
      return null;
    const originKey = documentOperationKey(
      indexPath,
      Number(origin.version),
      chunk.id,
    );
    if (
      row.operation_id !==
      operationId(actor, roomId, "DOCUMENT_EMBEDDING", originKey)
    )
      return null;
    const historical = decodeProfile(origin);
    if (
      historical.personaId !== profile.personaId ||
      !historical.scopes.includes(chunk.visibility) ||
      !historical.purposes.includes("DOCUMENT_EMBEDDING")
    )
      return null;

    // Read once per note in this scan. readNote checks live bytes, lineage, current version and grants.
    if (previousRef !== row.ref) {
      source = sources.read(chunk.ref);
      previousRef = String(row.ref);
    }
    if (
      !source ||
      source.personaId !== profile.personaId ||
      source.visibility !== chunk.visibility ||
      chunk.start < 0 ||
      chunk.end <= chunk.start ||
      chunk.end > source.text.length ||
      !isSourceBoundary(source.text, chunk.start) ||
      !isSourceBoundary(source.text, chunk.end)
    )
      return null;
    const input = formattedInput(
      "DOCUMENT_EMBEDDING",
      source.text.slice(chunk.start, chunk.end),
    );
    if (origin.payload_digest !== hash(input)) return null;
    return cosine(
      loadVector.get(row.id, row.operation_id, profile.spaceId)?.vector,
      query,
    );
  };
  for (const row of rows) {
    const chunk: PlannedChunk = {
      id: String(row.id),
      ref: JSON.parse(String(row.ref)) as MemoryRef,
      start: Number(row.start),
      end: Number(row.end),
      visibility: row.visibility as MemoryScope,
    };
    const score = compatibleScore(row, chunk);
    if (score === null) result.missing.push(chunk);
    else {
      result.indexed++;
      if (query) scores.push({ id: chunk.id, score });
    }
  }
  if (result.missing.length)
    return { ...result, state: "incomplete_dense_coverage" };
  scores.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  const byId = index.db.prepare("SELECT * FROM chunks WHERE id=?");
  result.candidates = scores
    .slice(0, DENSE_LIMITS.candidates)
    .map(({ id, score }) => index.candidate(byId.get(id)!, score));
  result.state = "ready";
  return result;
}
