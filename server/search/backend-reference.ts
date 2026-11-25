import { randomUUID } from "node:crypto";
import type {
  SearchSource,
  SearchTarget,
} from "../../shared/search-sources.ts";
import {
  candidateLimit,
  sourceChunks,
  sourceKeys,
  type CandidatePage,
  type IndexPage,
  type LexicalFilter,
  type SearchBackend,
  type SearchCandidate,
} from "./backend.ts";
import { analyzeQuery, contentScore } from "./lexical.ts";

/** Small exhaustive oracle for contract tests. Deployment uses the indexed backend. */
export class ReferenceSearchBackend implements SearchBackend {
  readonly generationId = randomUUID();
  private sources = new Map<string, SearchSource>();
  private cursors = new Map<string, string>();
  applyPage(page: IndexPage) {
    const previous = page.cursor && this.getCursor(page.cursor.stream);
    if (page.cursor && previous === page.cursor.value) return;
    if (page.expectedCursor !== undefined && previous !== page.expectedCursor)
      throw new Error("SEARCH_CURSOR_CONFLICT");
    const next = new Map(this.sources);
    for (const { target, id } of page.deletes) {
      for (const [key, doc] of next)
        if (doc.target === target && doc.groupId === id) next.delete(key);
    }
    for (const doc of page.upserts)
      next.set(doc.target + ":" + doc.sourceId, structuredClone(doc));
    this.sources = next;
    if (page.cursor) this.cursors.set(page.cursor.stream, page.cursor.value);
  }
  getCursor(stream: string) {
    return this.cursors.get(stream) ?? null;
  }
  coverage() {
    const counts: Record<SearchTarget, number> = { memory: 0, archive: 0 };
    for (const doc of this.sources.values())
      for (const _chunk of sourceChunks(doc)) counts[doc.target]++;
    return counts;
  }
  query(filter: LexicalFilter): CandidatePage {
    const query = analyzeQuery(filter.query);
    const limit = candidateLimit(filter.limit);
    const hits: SearchCandidate[] = [];
    for (const doc of this.sources.values()) {
      const history =
        doc.target === "archive" && filter.includeHistory === true;
      if (
        doc.target !== filter.target ||
        (!doc.current && !history) ||
        (filter.personaId !== undefined &&
          filter.personaId !== doc.personaId) ||
        (filter.from !== undefined && doc.recordedAt < filter.from) ||
        (filter.until !== undefined && doc.recordedAt >= filter.until) ||
        !filter.allowsScope(
          doc.target,
          doc.personaId,
          doc.visibility,
          doc.channel,
        ) ||
        !filter.eligible(doc.ref, history)
      )
        continue;
      const exact = sourceKeys(doc).some((key) => query.whole.includes(key));
      let best: SearchCandidate;
      for (const chunk of sourceChunks(doc)) {
        if (!exact && !query.probes.some((probe) => chunk.text.includes(probe)))
          continue;
        const score = (exact ? 1000 : 0) + contentScore(chunk.text, query);
        if (
          !best ||
          score > best.score ||
          (score === best.score && chunk.id < best.id)
        ) {
          best = {
            id: chunk.id,
            citation: chunk.citation,
            score,
            personaId: doc.personaId,
            visibility: doc.visibility,
            role: doc.role,
            speakerId: doc.speakerId,
            channel: doc.channel,
            current: doc.current,
            recordedAt: doc.recordedAt,
          };
        }
      }
      if (best) hits.push(best);
    }
    hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
    return { hits: hits.slice(0, limit), limited: hits.length > limit };
  }
  validate() {}
  close() {
    this.sources.clear();
    this.cursors.clear();
  }
}
