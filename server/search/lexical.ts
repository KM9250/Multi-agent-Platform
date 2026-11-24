export const NORMALIZER_VERSION = "nfkc-lower-whitespace-v1";
export const ANALYZER_VERSION = "trigram-shortpostings-id-v1";
export const MAX_QUERY_POINTS = 512;
const MAX_PROBES = 32;

export function normalizeSearch(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

/** Both indexes and query analysis count Unicode code points. */
export function shortPostings(text: string): Set<string> {
  const points = [...text];
  const terms = new Set<string>();
  for (let i = 0; i < points.length; i++) {
    terms.add(points[i]);
    if (i + 1 < points.length) terms.add(points[i] + points[i + 1]);
  }
  return terms;
}

function sample<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  return Array.from(
    { length: max },
    (_, i) => items[Math.floor((i * (items.length - 1)) / (max - 1))],
  );
}

export function analyzeQuery(raw: string) {
  if ([...raw].length > MAX_QUERY_POINTS || raw.includes("\0"))
    throw new Error("SEARCH_QUERY_INVALID");
  const normalized = normalizeSearch(raw);
  if (!normalized) throw new Error("SEARCH_QUERY_INVALID");
  // Script boundaries retain both parts of mixed terms such as 設計DB.
  const tokens =
    normalized.match(
      /\/?[\p{Script=Latin}\p{Number}_-]+|[\p{Script=Han}\p{Script=Katakana}\p{Script=Hiragana}ー]+|[\p{L}\p{M}]+|\p{Extended_Pictographic}/gu,
    ) ?? [];
  const whole = sample([...new Set([normalized, ...tokens])], MAX_PROBES);
  const partial = new Set<string>();
  for (const token of tokens) {
    const points = [...token];
    if (
      points.length <= 4 ||
      !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(token)
    )
      continue;
    for (let i = 0; i + 2 < points.length; i++)
      partial.add(points.slice(i, i + 3).join(""));
  }
  const probes = [...new Set([...whole, ...sample([...partial], MAX_PROBES)])];
  const short = probes.filter((term) => [...term].length < 3);
  const long = probes.filter((term) => [...term].length >= 3);
  const fts = long
    .map((term) => '"' + term.replaceAll('"', '""') + '"')
    .join(" OR ");
  return { normalized, whole, short, fts, probes };
}

export type AnalyzedQuery = ReturnType<typeof analyzeQuery>;

export function contentScore(text: string, query: AnalyzedQuery): number {
  let score = text.includes(query.normalized) ? 8 : 0;
  for (const t of query.whole) if (text.includes(t)) score += 2;
  for (const t of query.probes) if (text.includes(t)) score += 0.125;
  return score;
}
