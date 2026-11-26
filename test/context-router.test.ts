import test from "node:test";
import assert from "node:assert/strict";
import { extractContextQuery, interpretContextDate, normalizeTurnContext, routeContext } from "../server/generation/context-router.ts";
import { dateRange } from "../server/search/date.ts";

const acceptedAt = Date.parse("2026-11-25T16:00:00Z"); // Nov 26 in Tokyo.
function route(content: string, extra: any = {}) {
  return routeContext({ content, purpose: "answer", dateInterpretation: interpretContextDate(content, extra.context, acceptedAt), ...extra });
}

test("MEM-3A deterministic routing follows the accepted intent examples", () => {
  for (const [content, mode] of [
    ["ありがとうございます", "none"],
    ["保存方式は何に決めていましたか", "memory"],
    ["前に話した事柄Aについて", "archive"],
    ["2026年11月11日に話した事柄A", "archive"],
    ["前の発言と現在の方針を比較したい", "both"],
    ["11月11日は何曜日ですか", "none"],
  ]) assert.equal(route(content).mode, mode, content);
  assert.deepEqual(route("2026年11月11日に話した事柄A").dateInterpretation.range,
    dateRange({ mode: "approx", anchorDate: "2026-11-11", timeZone: "UTC" }));
  assert.equal(route("今後どうしますか").mode, "memory");
  assert.equal(route("今後どうしますか", { memoryAvailable: false }).mode, "none");
});

test("MEM-3A purpose exclusion, explicit modes and server defaults have deterministic precedence", () => {
  for (const purpose of ["decision", "memory", "subagent"])
    assert.equal(route("前の発言と現在の方針を比較", { purpose, context: { mode: "both" } }).mode, "none");
  assert.equal(route("/memory", { memoryCommand: true, context: { mode: "both" } }).mode, "none");
  assert.equal(route("前に話したこと", { context: { mode: "none" } }).mode, "none");
  assert.equal(route("前に話したこと", { roomMode: "memory" }).mode, "memory");
  assert.equal(route("今後", { roomMode: "archive", personaMode: "none" }).mode, "none");
  assert.equal(route("前に話したこと", { context: { mode: "auto" }, personaMode: "none" }).mode, "archive");
  assert.equal(route("", { context: { mode: "archive" } }).mode, "none");
});

test("MEM-3A query extraction is bounded and never cuts a surrogate pair", () => {
  const long = "a".repeat(511) + "😀tail";
  const query = extractContextQuery(long);
  assert.equal(query.text, "a".repeat(511));
  assert.equal(query.truncated, true);
  assert.deepEqual(extractContextQuery(long), query);
  assert.equal(extractContextQuery("😀".repeat(256)).text.length, 512);
  assert.equal(extractContextQuery("  source\r\ntext  ").text, "source\r\ntext");
});

test("MEM-3A input context is closed, date validation is shared, and timezone is validated without a date", () => {
  assert.equal(normalizeTurnContext(undefined), undefined);
  assert.deepEqual(normalizeTurnContext({}), {});
  for (const value of [
    { mode: "invented" }, { consumerPersonaId: "private-owner" }, { timeZone: "bad/time_zone" },
    { date: { mode: "strict", anchorDate: "2026-02-30" } },
    { mode: "none", date: { mode: "strict", anchorDate: "2026-11-11" } },
    { mode: "memory", date: { mode: "approx", anchorDate: "2026-11-11" } },
    { date: { mode: "approx", anchorDate: "2026-11-11", endDate: "2026-11-12" } },
    { date: { mode: "strict", anchorDate: "2026-11-11", maxArchiveMessageSeq: 999 } },
  ]) assert.throws(() => normalizeTurnContext(value));
  let invoked = false;
  assert.throws(() => normalizeTurnContext({ get mode() { invoked = true; return "both"; } }));
  assert.equal(invoked, false);
});

test("MEM-3A relative dates use the accepted civil day and yearless dates remain ambiguous", () => {
  const context = normalizeTurnContext({ mode: "archive", timeZone: "Asia/Tokyo" });
  for (const [text, day] of [["今日話した", "2026-11-26"], ["昨日話した", "2026-11-25"], ["一昨日話した", "2026-11-24"]])
    assert.equal(interpretContextDate(text, context, acceptedAt).range?.anchorDate, day);
  const ambiguous = route("11月11日に話した内容");
  assert.equal(ambiguous.mode, "archive");
  assert.equal(ambiguous.dateInterpretation.status, "ambiguous");
  assert.equal(ambiguous.dateInterpretation.range, undefined);
  const strict = route("11月11日の会話を厳密に調べて");
  assert.equal(strict.mode, "none");
  assert.equal(strict.reason, "date_condition_required");
  assert.equal(route("訂正前の発言を見たい").reason, "human_history_required");
});

test("MEM-3A explicit archive date takes precedence over a default Memory setting", () => {
  const context = normalizeTurnContext({ date: { mode: "strict", anchorDate: "2026-11-11", endDate: "2026-11-12" }, timeZone: "Asia/Tokyo" });
  const actual = route("事柄A", { context, roomMode: "memory", personaMode: "memory" });
  assert.equal(actual.mode, "archive");
  assert.equal(actual.dateInterpretation.range?.firstDate, "2026-11-11");
  assert.equal(actual.dateInterpretation.range?.lastDate, "2026-11-12");
});
