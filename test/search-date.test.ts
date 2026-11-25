import test from "node:test";
import assert from "node:assert/strict";
import { dateRange, dateLayer } from "../server/search/date.ts";
import { searchInput } from "../server/search/input.ts";

test("S-02/07 civil intervals cross months, years, leap days and DST", () => {
  for (const [day, first, last] of [
    ["2026-11-11", "2026-11-04", "2026-11-18"],
    ["2024-03-01", "2024-02-23", "2024-03-08"],
    ["2027-01-02", "2026-12-26", "2027-01-09"],
  ]) {
    const range = dateRange({
      anchorDate: day,
      mode: "approx",
      timeZone: "Asia/Tokyo",
    });
    assert.equal(range.firstDate, first);
    assert.equal(range.lastDate, last);
    assert.equal(range.startInclusive, Date.parse(first + "T00:00:00+09:00"));
    assert.equal(
      range.endExclusive,
      Date.parse(last + "T00:00:00+09:00") + 86_400_000,
    );
    assert.equal(dateLayer(range, range.startInclusive), "near7");
  }
  for (const [anchorDate, hours] of [
    ["2024-03-10", 23],
    ["2024-11-03", 25],
  ] as const) {
    const r = dateRange({
      mode: "strict",
      anchorDate,
      timeZone: "America/New_York",
    });
    assert.equal(r.endExclusive - r.startInclusive, hours * 3_600_000);
  }
  for (const anchorDate of ["0001-01-01", "9999-12-31"]) {
    const day = dateRange({ mode: "strict", anchorDate, timeZone: "UTC" });
    assert.equal(day.startInclusive, Date.parse(anchorDate + "T00:00:00Z"));
    assert.equal(day.endExclusive - day.startInclusive, 86_400_000);
  }
  const leap = dateRange({
    mode: "strict",
    anchorDate: "2024-02-29",
    endDate: "2024-03-01",
    timeZone: "UTC",
  });
  assert.equal(leap.endExclusive - leap.startInclusive, 2 * 86_400_000);
});
test("reject incomplete dates, non-IANA offsets, impossible dates and unsupported filters", () => {
  for (const [anchorDate, timeZone] of [
    ["11-11", "UTC"],
    ["2026-02-29", "UTC"],
    ["2026-01-01", "+09:00"],
    ["2011-12-30", "Pacific/Apia"],
    ["2026-01-01", "invalid/zone"],
  ])
    assert.throws(() => dateRange({ mode: "strict", anchorDate, timeZone }));
  const req = { target: "memory", query: "猫", requestId: crypto.randomUUID() };
  for (const extra of [
    { date: {} },
    { projectId: "x" },
    { revisionMode: "include_history" },
    { actorId: "other" },
    { limit: 21 },
    { purpose: "ai_context" },
  ])
    assert.throws(() => searchInput({ ...req, ...extra }));
});
