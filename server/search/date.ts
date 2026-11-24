import { AppError } from "../../shared/app-contracts/index.ts";
import type { SearchDateRange } from "../../shared/search-contracts.ts";
import { object, string } from "../app-data/validation.ts";

const DAY = 86_400_000;
function invalid(): never {
  throw new AppError("INVALID_INPUT");
}

function dayNumber(date: unknown): number {
  if (
    typeof date !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    date.startsWith("0000")
  )
    invalid();
  const midnight = Date.parse(date + "T00:00:00.000Z");
  if (
    !Number.isFinite(midnight) ||
    new Date(midnight).toISOString().slice(0, 10) !== date
  )
    invalid();
  return midnight;
}
function label(day: number): string {
  return new Date(day).toISOString().split("T")[0];
}
function formatter(timeZone: string) {
  if (timeZone.length > 80 || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(timeZone))
    invalid();
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      calendar: "gregory",
      numberingSystem: "latn",
      year: "numeric",
      era: "short",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    return invalid();
  }
}
function localDay(format: Intl.DateTimeFormat, timestamp: number) {
  const parts = Object.fromEntries(
    format.formatToParts(timestamp).map((p) => [p.type, p.value]),
  );
  // setUTCFullYear accepts ISO year zero and does not reinterpret years 1–99 as 1901–1999.
  const year = Number(parts.year);
  const date = new Date(0);
  date.setUTCFullYear(
    parts.era === "BC" ? 1 - year : year,
    Number(parts.month) - 1,
    Number(parts.day),
  );
  return date.getTime();
}
/** First instant whose civil date reaches the bound. The day can be 23 or 25 hours. */
function boundary(format: Intl.DateTimeFormat, day: number) {
  let low = day - 2 * DAY,
    high = day + 2 * DAY;
  while (high - low > 1) {
    const mid = low + Math.floor((high - low) / 2);
    if (localDay(format, mid) < day) low = mid;
    else high = mid;
  }
  return high;
}
export function dateRange(value: unknown): SearchDateRange {
  const d = object(value, ["mode", "anchorDate", "timeZone", "endDate"]);
  if (d.mode !== "strict" && d.mode !== "approx") invalid();
  const timeZone = string(d.timeZone, 80);
  const format = formatter(timeZone);
  const anchor = dayNumber(d.anchorDate);
  const last = d.endDate === undefined ? anchor : dayNumber(d.endDate);
  if (last < anchor || (d.mode === "approx" && d.endDate !== undefined))
    invalid();
  // An entire civil day was skipped in some IANA zones during date-line changes.
  if (
    localDay(format, boundary(format, anchor)) !== anchor ||
    (d.endDate && localDay(format, boundary(format, last)) !== last)
  )
    invalid();
  const firstDay = d.mode === "approx" ? anchor - 7 * DAY : anchor;
  const lastDay = d.mode === "approx" ? anchor + 7 * DAY : last;
  return {
    mode: d.mode,
    anchorDate: d.anchorDate,
    timeZone,
    ...(d.endDate ? { endDate: d.endDate } : {}),
    firstDate: label(firstDay),
    lastDate: label(lastDay),
    startInclusive: boundary(format, firstDay),
    endExclusive: boundary(format, lastDay + DAY),
  };
}
export function dateLayer(range: SearchDateRange, timestamp: number) {
  const days =
    Math.abs(
      localDay(formatter(range.timeZone), timestamp) -
        dayNumber(range.anchorDate),
    ) / DAY;
  return days === 0 ? "anchor" : days <= 3 ? "near3" : "near7";
}
