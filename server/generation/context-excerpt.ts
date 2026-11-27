import { analyzeQuery, contentScore, normalizeSearch } from "../search/lexical.ts";
import { isSourceBoundary } from "../search/sources.ts";

export interface ExcerptRange { start: number; end: number }
export function excerptBoundary(text: string, offset: number): boolean {
  return isSourceBoundary(text, offset) && !(text[offset - 1] === "\r" && text[offset] === "\n");
}

/** Local sentence/line selection only. Scoring may normalize a copy; offsets and
 * supplied bytes always refer to the unmodified, verified original. A complete
 * sentence crossing a chunk boundary remains part of the required range. */
export function partialQuoteRanges(text: string, hit: ExcerptRange, query: string, opening: "sentence" | "line" | undefined) {
  const analyzed = analyzeQuery(query);
  let start = 0, bestScore = -1;
  let required: ExcerptRange = { start: 0, end: text.length };
  const consider = (end: number) => {
    if (text.slice(start, end).trim() && ((opening && bestScore < 0) || (!opening && start < hit.end && hit.start < end))) {
      const score = contentScore(normalizeSearch(text.slice(start, end)), analyzed);
      if (score > bestScore) { bestScore = score; required = { start, end }; }
    }
    start = end;
  };
  // Keep punctuation, closing quotes and a following line break together. Never
  // split CRLF or a surrogate pair. No arbitrary cut inside the required sentence.
  const endings = opening === "line" ? /\r\n|[\r\n]/gu
    : /[。！？!?](?:[」』"')）]*)(?:[ \t]*(?:\r\n|[\r\n]))?|\.(?=\s|$)(?:[ \t]*(?:\r\n|[\r\n]))?|\r\n|[\r\n]/gu;
  for (const match of text.matchAll(endings)) {
    consider(match.index + match[0].length);
    if ((opening && bestScore >= 0) || (!opening && start >= hit.end)) break;
  }
  if (start < text.length && (!opening || bestScore < 0)) consider(text.length);
  const bounded = (range: ExcerptRange) => {
    let { start, end } = range;
    if (!excerptBoundary(text, start)) start--;
    if (!excerptBoundary(text, end)) end++;
    return { start, end };
  };
  // The hit and margins are preferences, not proof of the user's requested span.
  const hitRange = bounded({ start: Math.min(hit.start, required.start), end: Math.max(hit.end, required.end) });
  const preferred = hitRange.end - hitRange.start <= 4096 ? hitRange : required;
  const margin = Math.min(128, Math.max(0, Math.floor((4096 - (preferred.end - preferred.start)) / 2)));
  let expanded = bounded({ start: Math.max(0, preferred.start - margin), end: Math.min(text.length, preferred.end + margin) });
  if (expanded.end - expanded.start > 4096) expanded = preferred;
  return { required, hit: preferred, expanded };
}
