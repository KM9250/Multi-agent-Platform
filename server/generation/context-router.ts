import type {
  ContextDateInterpretation,
  ContextMode,
  ContextRoute,
  TurnContext,
} from "../../shared/context-contracts.ts";
import { dateRange } from "../search/date.ts";
import { exact, GenerationError, safeInput } from "./types.ts";

const modes: ContextMode[] = ["auto", "none", "memory", "archive", "both"];
const dateVersion = "map-context-date-v1" as const;
const historyIntent = /前に|以前|過去|話した|発言|会話|履歴|last time|previous|earlier|\bsaid\b|talked|discussed|conversation/i;
const memoryIntent = /決め|決定|確定|合意|方針|共有記憶|メモリ|\bmemory\b|\bpolicy\b|agreed|decided/i;
const strictIntent = /厳密|正確な日|その日だけ|当日だけ|exact date|strict|only on/i;

/** Closed HTTP input. MEM-2 remains the single civil-date/timezone validator. */
export function normalizeTurnContext(value: unknown): TurnContext | undefined {
  if (value === undefined) return undefined;
  safeInput(value);
  exact(value, ["mode", "timeZone", "date"]);
  const input = value as TurnContext;
  if (input.mode !== undefined && !modes.includes(input.mode))
    throw new GenerationError("INVALID_INPUT");
  const timeZone = input.timeZone ?? "UTC";
  // Validate a timezone even when the request does not have a date condition.
  dateRange({ mode: "strict", anchorDate: "2000-01-15", timeZone });
  if (input.date !== undefined) {
    exact(input.date, ["mode", "anchorDate", "endDate"]);
    if (input.mode === "none" || input.mode === "memory")
      throw new GenerationError("INVALID_CONTEXT_DATE_MODE");
    dateRange({ ...input.date, timeZone });
  }
  return {
    ...(input.mode === undefined ? {} : { mode: input.mode }),
    ...(input.timeZone === undefined ? {} : { timeZone }),
    ...(input.date === undefined ? {} : { date: { ...input.date } }),
  };
}

export function extractContextQuery(content: string): ContextRoute["query"] {
  const text = content.trim();
  let end = Math.min(512, text.length);
  if (end < text.length && end > 0 &&
      /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
  return { version: "map-context-query-v1", text: text.slice(0, end), truncated: end < text.length };
}

function civilDate(at: number, timeZone: string, offset: number): string {
  const fields = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone, calendar: "gregory", numberingSystem: "latn",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(at).map(p => [p.type, p.value]));
  const day = new Date(0);
  day.setUTCFullYear(Number(fields.year), Number(fields.month) - 1, Number(fields.day));
  day.setUTCDate(day.getUTCDate() + offset);
  return day.toISOString().slice(0, 10);
}

export function interpretContextDate(
  content: string,
  context: TurnContext | undefined,
  acceptedAt: number,
): ContextDateInterpretation {
  const timeZone = context?.timeZone ?? "UTC";
  const base = { version: dateVersion, timeZone };
  if (context?.date) return {
    ...base, status: "resolved", source: "explicit",
    range: dateRange({ ...context.date, timeZone }),
  };
  if (!historyIntent.test(content) && !["archive", "both"].includes(context?.mode ?? ""))
    return { ...base, status: "none", source: "none" };
  const mode = strictIntent.test(content) ? "strict" : "approx";
  const absolute = content.match(/(?<!\d)(\d{4})(?:年|[-/])(\d{1,2})(?:月|[-/])(\d{1,2})(?:日)?(?!\d)/);
  if (absolute) {
    const anchorDate = `${absolute[1]}-${absolute[2].padStart(2, "0")}-${absolute[3].padStart(2, "0")}`;
    try { return { ...base, status: "resolved", source: "absolute_text", range: dateRange({ mode, anchorDate, timeZone }) }; }
    catch { return { ...base, status: "needs_condition", source: "absolute_text" }; }
  }
  const relative = content.match(/一昨日|おととい|昨日|きのう|今日|きょう|day before yesterday|yesterday|today/i)?.[0].toLowerCase();
  if (relative) {
    const offset = /一昨日|おととい|day before yesterday/.test(relative) ? -2 : /昨日|きのう|yesterday/.test(relative) ? -1 : 0;
    return { ...base, status: "resolved", source: "relative_text", range: dateRange({ mode, anchorDate: civilDate(acceptedAt, timeZone, offset), timeZone }) };
  }
  if (/(?<!\d)\d{1,2}月\d{1,2}日|(?<!\d)\d{1,2}\/\d{1,2}(?!\d)/.test(content))
    return { ...base, status: mode === "strict" ? "needs_condition" : "ambiguous", source: "year_missing" };
  if (mode === "strict") return { ...base, status: "needs_condition", source: "none" };
  return { ...base, status: "none", source: "none" };
}

/** Deterministic policy: never calls an LLM or expands a date window. */
export function routeContext(input: {
  content: string;
  purpose: string;
  context?: TurnContext;
  personaMode?: ContextMode;
  roomMode?: ContextMode;
  dateInterpretation: ContextDateInterpretation;
  memoryAvailable?: boolean;
  memoryCommand?: boolean;
}): ContextRoute {
  const requestedMode = input.context?.mode ?? (input.context?.date ? "auto" : undefined) ?? input.personaMode ?? input.roomMode ?? "auto";
  const query = extractContextQuery(input.content);
  const base = { version: "map-context-router-v1" as const, requestedMode, query, dateInterpretation: input.dateInterpretation,
    requiresExactExcerpt: /原文|そのまま|一字一句|引用|verbatim|\bquot(?:e|ation)\b|exact wording/i.test(input.content) };
  const result = (mode: ContextRoute["mode"], reason: string, requiresEvidence = false): ContextRoute => ({ ...base, mode, reason, requiresEvidence });
  if (input.purpose !== "answer" || input.memoryCommand) return result("none", "purpose_excluded");
  if (requestedMode === "none") return result("none", "explicit_none");
  if (!query.text) return result("none", "empty_query");
  if (/訂正前|修正前|before (?:the )?correction|previous revision/i.test(input.content))
    return result("none", "human_history_required", true);
  if (input.dateInterpretation.status === "needs_condition") return result("none", "date_condition_required", true);
  if (requestedMode !== "auto") return result(requestedMode, "configured_mode", ["archive", "both"].includes(requestedMode));
  const history = historyIntent.test(input.content), memory = memoryIntent.test(input.content);
  if (history && memory && /比較|違い|比べ|compare|comparison/i.test(input.content)) return result("both", "compare_history_policy", true);
  if (input.dateInterpretation.source === "explicit") return result("archive", "explicit_date", true);
  if (memory) return result("memory", "established_memory", true);
  if (history) return result("archive", "past_conversation", true);
  if (!query.text || /^(?:ありがとう(?:ございます|ございました)?|どうも|了解(?:しました)?|わかりました|はい|いいえ|こんにちは|おはよう(?:ございます)?|thanks?(?: you)?|hello|hi|ok(?:ay)?)[\s!！。.?？]*$/i.test(query.text))
    return result("none", "no_retrieval_needed");
  if (/何曜日|what day of the week/i.test(input.content)) return result("none", "general_calendar_question");
  return input.memoryAvailable === false ? result("none", "memory_unavailable") : result("memory", "small_memory_fallback");
}
