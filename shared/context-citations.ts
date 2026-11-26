import type { SearchCitation } from "./search-sources.ts";

/** Public projection only: no query, private ancestor, storage path or ACL snapshot. */
export interface AnswerSourceDTO {
  alias: string;
  citation: SearchCitation;
  recordedAt: number;
}
export interface AnswerContextDTO {
  contract: "MAP-MEM-3:CONTEXT:1";
  messageId: string;
  revision: number;
  receiptId: string;
  mode: "none" | "memory" | "archive" | "both";
  state: "ready" | "partial" | "unavailable";
  searches: Array<{
    target: "memory" | "archive";
    status: string;
    found: boolean;
  }>;
  supplied: AnswerSourceDTO[];
  citedAliases: string[];
}

/** Reserved syntax is a link only when it names an authorized supplied alias. */
export function citedSourceAliases(text: string, allowed: ReadonlySet<string>): string[] {
  return [...new Set(Array.from(text.matchAll(/\[\[MAP_SOURCE:(S[1-9][0-9]*)\]\]/g),
    match => match[1]).filter(alias => allowed.has(alias)))];
}

export function answerSourceParts(text: string, allowed: ReadonlySet<string>): Array<
  { text: string; alias?: never } | { alias: string; text?: never }
> {
  const parts: Array<{ text: string; alias?: never } | { alias: string; text?: never }> = [];
  let end = 0;
  for (const match of text.matchAll(/\[\[MAP_SOURCE:(S[1-9][0-9]*)\]\]/g)) {
    if (!allowed.has(match[1])) continue;
    if (match.index! > end) parts.push({ text: text.slice(end, match.index) });
    parts.push({ alias: match[1] });
    end = match.index! + match[0].length;
  }
  if (end < text.length) parts.push({ text: text.slice(end) });
  return parts;
}
