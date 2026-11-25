import { basename } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync } from "node:fs";
import {
  DatabaseSync,
  type SQLInputValue,
  type SQLOutputValue,
} from "node:sqlite";
import type {
  SearchCitation,
  SearchSource,
  SearchTarget,
  SourceMetadata,
  SourceRef,
} from "../../shared/search-sources.ts";
import { chunkRanges } from "./chunk.ts";
import {
  analyzeQuery,
  contentScore,
  normalizeSearch,
  shortPostings,
} from "./lexical.ts";

export const BACKEND_CONTRACT = "map-search-sqlite-v1";
export const MAX_CANDIDATES = 100;

export interface CandidateFilter {
  target: SearchTarget;
  includeHistory?: boolean;
  personaId?: string;
  from?: number;
  until?: number;
  allowsScope: (
    target: SearchTarget,
    persona: string | null,
    visibility: string,
    channel: string,
  ) => boolean;
  eligible: (ref: SourceRef, includeHistory: boolean) => boolean;
}

export interface LexicalFilter extends CandidateFilter {
  query: string;
  limit?: number;
}
export interface SearchCandidate extends SourceMetadata {
  id: string;
  citation: SearchCitation;
  score: number;
}
export interface CandidatePage {
  hits: SearchCandidate[];
  limited: boolean;
}
export interface IndexPage {
  deletes: { target: SearchTarget; id: string }[];
  upserts: SearchSource[];
  cursor?: { stream: string; value: string };
  expectedCursor?: string | null;
}
export interface SearchBackend {
  readonly generationId: string;
  applyPage(page: IndexPage): void;
  getCursor(stream: string): string | null;
  coverage(): { memory: number; archive: number };
  query(filter: LexicalFilter): CandidatePage;
  validate(): void;
  close(): void;
}

const schema = `
  CREATE TABLE format(contract TEXT PRIMARY KEY, generation TEXT NOT NULL) STRICT;
  CREATE TABLE cursors(stream TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
  CREATE TABLE chunks (
    pk INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, source_id TEXT NOT NULL, group_id TEXT NOT NULL,
    target TEXT NOT NULL, version INTEGER NOT NULL, current INTEGER NOT NULL,
    recorded_at INTEGER NOT NULL, persona_id TEXT, visibility TEXT NOT NULL, channel TEXT NOT NULL,
    ref TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL,
    metadata TEXT NOT NULL, text TEXT NOT NULL
  ) STRICT;
  CREATE INDEX chunks_owner ON chunks(target,group_id);
  CREATE INDEX chunks_source ON chunks(target,source_id,version);
  CREATE INDEX chunks_time ON chunks(target,current,recorded_at);
  CREATE INDEX chunks_history_time ON chunks(target,recorded_at);
  CREATE VIRTUAL TABLE chunk_fts USING fts5(text,content='chunks',content_rowid='pk',tokenize='trigram');
  CREATE TRIGGER insert_fts AFTER INSERT ON chunks BEGIN
    INSERT INTO chunk_fts(rowid,text) VALUES (new.pk,new.text);
  END;
  CREATE TRIGGER delete_fts AFTER DELETE ON chunks BEGIN
    INSERT INTO chunk_fts(chunk_fts,rowid,text) VALUES ('delete',old.pk,old.text);
  END;
  CREATE TABLE short_terms(
    term TEXT NOT NULL, chunk_row INTEGER NOT NULL REFERENCES chunks(pk) ON DELETE CASCADE,
    PRIMARY KEY(term,chunk_row)
  ) WITHOUT ROWID, STRICT;
  CREATE INDEX short_chunk ON short_terms(chunk_row);
  CREATE TABLE exact_ids(
    key TEXT NOT NULL,chunk_row INTEGER NOT NULL REFERENCES chunks(pk) ON DELETE CASCADE,
    PRIMARY KEY(key,chunk_row)
  ) WITHOUT ROWID, STRICT;
  CREATE INDEX exact_chunk ON exact_ids(chunk_row);
  CREATE TABLE search_vectors(
    chunk_id TEXT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
    space_id TEXT NOT NULL,operation_id TEXT NOT NULL, vector BLOB NOT NULL
  ) STRICT;
`;

export function sourceKeys(source: SearchSource): string[] {
  const ref = source.ref;
  return [
    ...new Set(
      (ref.target === "memory"
        ? [ref.noteId]
        : [ref.messageId, ref.segmentId, ref.revisionId]
      ).map(normalizeSearch),
    ),
  ];
}

function hashRef(ref: SourceRef): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        ref.target === "memory"
          ? [
              ref.target,
              ref.workspaceId,
              ref.roomId,
              ref.noteId,
              ref.version,
              ref.fileDigest,
              ref.bodyDigest,
            ]
          : [
              ref.target,
              ref.workspaceId,
              ref.roomId,
              ref.messageId,
              ref.version,
              ref.revisionId,
              ref.segmentId,
              ref.segmentDigest,
            ],
      ),
    )
    .digest("hex");
}

export function* sourceChunks(source: SearchSource) {
  const hash = hashRef(source.ref);
  const metadata = { speakerId: source.speakerId, role: source.role };
  for (const range of chunkRanges(source.text, source.target === "memory")) {
    yield {
      id: hash + "-" + range.start + "-" + range.end,
      citation: { ...source.ref, ...range },
      text: normalizeSearch(source.text.slice(range.start, range.end)),
      metadata,
    };
  }
}

export function candidateLimit(limit = MAX_CANDIDATES) {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_CANDIDATES)
    throw new Error("SEARCH_LIMIT_INVALID");
  return limit;
}

type Row = Record<string, SQLOutputValue>;

export class SQLiteSearchBackend implements SearchBackend {
  readonly db: DatabaseSync;
  readonly generationId: string;

  constructor(
    path: string,
    options: { create?: boolean; readOnly?: boolean } = {},
  ) {
    this.generationId =
      path === ":memory:" ? randomUUID() : basename(path, ".sqlite");
    if (options.readOnly && options.create)
      throw new Error("SEARCH_INDEX_OPTIONS");
    if (path !== ":memory:") {
      if (!existsSync(path) && options.create)
        closeSync(openSync(path, "wx", 0o600));
      const file = lstatSync(path);
      if (!file.isFile() || file.nlink !== 1 || (file.mode & 0o077) !== 0)
        throw new Error("SEARCH_INDEX_PATH");
    }
    this.db = new DatabaseSync(path, { readOnly: options.readOnly === true });
    try {
      this.db.exec(
        "PRAGMA foreign_keys=ON; PRAGMA busy_timeout=500; PRAGMA temp_store=MEMORY;",
      );
      if (options.create) {
        this.db.exec("BEGIN IMMEDIATE");
        this.db.exec(schema);
        this.db
          .prepare("INSERT INTO format VALUES (?,?)")
          .run(BACKEND_CONTRACT, this.generationId);
        this.db.exec("COMMIT");
      } else {
        const format = this.db
          .prepare("SELECT contract,generation FROM format")
          .get();
        if (
          format?.contract !== BACKEND_CONTRACT ||
          format.generation !== this.generationId
        )
          throw new Error("SEARCH_INDEX_FORMAT");
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  getCursor(stream: string): string | null {
    return (
      (this.db.prepare("SELECT value FROM cursors WHERE stream=?").get(stream)
        ?.value as string) ?? null
    );
  }

  applyPage(page: IndexPage): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previous = page.cursor && this.getCursor(page.cursor.stream);
      if (page.cursor && previous === page.cursor.value) {
        this.db.exec("COMMIT");
        return;
      }
      if (page.expectedCursor !== undefined && previous !== page.expectedCursor)
        throw new Error("SEARCH_CURSOR_CONFLICT");
      const del = this.db.prepare(
        "DELETE FROM chunks WHERE target=? AND group_id=?",
      );
      for (const item of page.deletes) del.run(item.target, item.id);
      const replace = this.db.prepare(
        "DELETE FROM chunks WHERE target=? AND source_id=? AND (ref<>? OR version<>?)",
      );
      const insert = this.db.prepare(`INSERT INTO chunks
        (id,source_id,group_id,target,version,current,recorded_at,persona_id,visibility,channel,ref,start,end,metadata,text)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`);
      const update = this.db.prepare(
        `UPDATE chunks SET current=?,recorded_at=?,persona_id=?,visibility=?,channel=?,metadata=? WHERE id=?`,
      );
      const short = this.db.prepare("INSERT INTO short_terms VALUES (?,?)");
      const exact = this.db.prepare("INSERT INTO exact_ids VALUES (?,?)");
      for (const source of page.upserts) {
        const ref = JSON.stringify(source.ref);
        replace.run(source.target, source.sourceId, ref, source.version);
        const keys = sourceKeys(source);
        for (const chunk of sourceChunks(source)) {
          const metadata = JSON.stringify(chunk.metadata);
          const row = insert.run(
            chunk.id,
            source.sourceId,
            source.groupId,
            source.target,
            source.version,
            Number(source.current),
            source.recordedAt,
            source.personaId,
            source.visibility,
            source.channel,
            ref,
            chunk.citation.start,
            chunk.citation.end,
            metadata,
            chunk.text,
          );
          if (row.changes === 0) {
            update.run(
              Number(source.current),
              source.recordedAt,
              source.personaId,
              source.visibility,
              source.channel,
              metadata,
              chunk.id,
            );
            continue;
          }
          for (const term of shortPostings(chunk.text))
            short.run(term, row.lastInsertRowid);
          for (const key of keys) exact.run(key, row.lastInsertRowid);
        }
      }
      if (page.cursor)
        this.db
          .prepare("INSERT OR REPLACE INTO cursors VALUES (?,?)")
          .run(page.cursor.stream, page.cursor.value);
      this.db.exec("COMMIT");
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  coverage() {
    const counts = { memory: 0, archive: 0 };
    for (const row of this.db
      .prepare("SELECT target,count(*) AS n FROM chunks GROUP BY target")
      .all())
      counts[row.target as SearchTarget] = Number(row.n);
    return counts;
  }

  /** Install request-local predicates. Connections must never be shared across overlapping requests. */
  allowed(
    filter: CandidateFilter,
    options: { deferSourceCheck?: boolean } = {},
  ) {
    const includeHistory =
      filter.target === "archive" && filter.includeHistory === true;
    const scopeCache = new Map<string, number>();
    this.db.function(
      "authorized_scope",
      (target, persona, visibility, channel) => {
        const key = JSON.stringify([target, persona, visibility, channel]);
        const cached = scopeCache.get(key);
        if (cached !== undefined) return cached;
        const permitted = Number(
          filter.allowsScope(
            target as SearchTarget,
            persona as string | null,
            String(visibility),
            String(channel),
          ),
        );
        if (scopeCache.size < 256) scopeCache.set(key, permitted);
        return permitted;
      },
    );
    this.db.function("eligible_source", (ref) =>
      Number(
        filter.eligible(JSON.parse(String(ref)) as SourceRef, includeHistory),
      ),
    );
    const where = ["c.target=?"];
    const params: SQLInputValue[] = [filter.target];
    if (!includeHistory) where.unshift("c.current=1");
    if (filter.personaId !== undefined) {
      where.push("c.persona_id=?");
      params.push(filter.personaId);
    }
    if (filter.from !== undefined) {
      where.push("c.recorded_at>=?");
      params.push(filter.from);
    }
    if (filter.until !== undefined) {
      where.push("c.recorded_at<?");
      params.push(filter.until);
    }
    where.push(
      "authorized_scope(c.target,c.persona_id,c.visibility,c.channel)",
    );
    if (!options.deferSourceCheck) where.push("eligible_source(c.ref)");
    return { sql: where.join(" AND "), params };
  }

  candidate(row: Row, score: number): SearchCandidate {
    const ref = JSON.parse(String(row.ref)) as SourceRef;
    const metadata = JSON.parse(String(row.metadata)) as {
      role: string;
      speakerId: string | null;
    };
    return {
      id: String(row.id),
      citation: { ...ref, start: Number(row.start), end: Number(row.end) },
      score,
      recordedAt: Number(row.recorded_at),
      personaId: row.persona_id as string | null,
      current: !!row.current,
      visibility: String(row.visibility),
      channel: String(row.channel),
      ...metadata,
    };
  }

  query(filter: LexicalFilter): CandidatePage {
    const terms = analyzeQuery(filter.query);
    const limit = candidateLimit(filter.limit);
    const allowed = this.allowed(filter, { deferSourceCheck: true });
    this.db.function("content_score", (text) =>
      contentScore(String(text), terms),
    );
    const routes = [
      "SELECT chunk_row AS pk, 0 AS bm25_score, 1 AS exact FROM exact_ids WHERE key IN (SELECT value FROM json_each(?))",
    ];
    const params: SQLInputValue[] = [JSON.stringify(terms.whole)];
    if (terms.fts) {
      routes.push(
        "SELECT rowid AS pk,-rank AS bm25_score,0 AS exact FROM chunk_fts WHERE chunk_fts MATCH ?",
      );
      params.push(terms.fts);
    }
    if (terms.short.length) {
      routes.push(
        "SELECT chunk_row AS pk,0 AS bm25_score,0 AS exact FROM short_terms WHERE term IN (SELECT value FROM json_each(?))",
      );
      params.push(JSON.stringify(terms.short));
    }
    // Rank all matching rows within the caller's present scope/time bounds. Iterate in content
    // order until K+1 *currently eligible* distinct sources pass. No fixed pre-authorization
    // slice can exhaust K with stale/deleted records or overlapping passages.
    // Without a date restriction SQLite otherwise walks every row of the time index even
    // for a single exact identifier. Drive the lookup from the sparse posting list.
    const join =
      filter.from === undefined && filter.until === undefined
        ? "CROSS JOIN"
        : "JOIN";
    const rows = this.db
      .prepare(
        `WITH routes AS (${routes.join(" UNION ALL ")}),
      matches AS (SELECT pk,max(bm25_score) AS relevance,max(exact) AS exact FROM routes GROUP BY pk)
      SELECT c.pk,c.source_id,c.version,
        content_score(c.text) + min(m.relevance,100)*0.01 + m.exact*1000 AS score
      FROM matches m ${join} chunks c ON c.pk=m.pk WHERE ${allowed.sql}
      ORDER BY score DESC,c.id`,
      )
      .iterate(...params, ...allowed.params);
    const get = this.db.prepare("SELECT * FROM chunks WHERE pk=?");
    const hits: SearchCandidate[] = [];
    const accepted = new Set<string>();
    for (const match of rows) {
      const key = JSON.stringify([match.source_id, match.version]);
      if (accepted.has(key)) continue;
      const row = get.get(match.pk)!;
      if (
        !filter.eligible(
          JSON.parse(String(row.ref)),
          filter.target === "archive" && filter.includeHistory === true,
        )
      )
        continue;
      if (hits.length === limit) return { hits, limited: true };
      accepted.add(key);
      hits.push(this.candidate(row, Number(match.score)));
    }
    return { hits, limited: false };
  }

  validate(): void {
    if (
      this.db.prepare("PRAGMA quick_check").get()?.quick_check !== "ok" ||
      this.db.prepare("PRAGMA foreign_key_check").get()
    )
      throw new Error("SEARCH_INDEX_INVALID");
    this.db.exec(
      "INSERT INTO chunk_fts(chunk_fts,rank) VALUES('integrity-check',1)",
    );
  }

  close(): void {
    this.db.close();
  }
}
