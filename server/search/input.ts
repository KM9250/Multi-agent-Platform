import { AppError } from "../../shared/app-contracts/index.ts";
import type { SearchRequest } from "../../shared/search-contracts.ts";
import { bool, integer, object, string } from "../app-data/validation.ts";
import { parseCitation } from "./sources.ts";
import { dateRange } from "./date.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function invalid(): never {
  throw new AppError("INVALID_INPUT");
}
function identifier(value: unknown) {
  const id = string(value, 160);
  if (!/^[A-Za-z0-9_.:-]+$/.test(id)) invalid();
  return id;
}
export function searchInput(value: unknown) {
  const p = object(value, [
    "requestId",
    "target",
    "query",
    "revisionMode",
    "retrievalMode",
    "date",
    "personaId",
    "limit",
  ]);
  if (!uuid.test(string(p.requestId, 36))) invalid();
  if (p.target !== "memory" && p.target !== "archive") invalid();
  const query = string(p.query, 512).trim();
  const revisionMode =
    p.revisionMode === undefined ? "current" : p.revisionMode;
  const retrievalMode =
    p.retrievalMode === undefined ? "auto" : p.retrievalMode;
  if (revisionMode !== "current" && revisionMode !== "include_history")
    invalid();
  if (!["auto", "lexical", "hybrid"].includes(retrievalMode)) invalid();
  if (
    p.target === "memory" &&
    (revisionMode !== "current" || p.date !== undefined)
  )
    invalid();
  if (p.target === "archive" && retrievalMode === "hybrid") invalid();
  const req: SearchRequest = {
    requestId: p.requestId,
    target: p.target,
    query,
    ...(p.personaId === undefined
      ? {}
      : { personaId: identifier(p.personaId) }),
  };
  return {
    ...req,
    revisionMode: revisionMode as "current" | "include_history",
    retrievalMode: retrievalMode as "auto" | "lexical" | "hybrid",
    date: p.date === undefined ? undefined : dateRange(p.date),
    limit: p.limit === undefined ? 10 : integer(p.limit, 1, 20),
  };
}

export function citationInput(value: unknown) {
  const p = object(value, ["citation", "includeHistory", "surrounding"]);
  const citation = parseCitation(p.citation);
  const includeHistory =
    p.includeHistory === undefined ? false : bool(p.includeHistory);
  const surrounding = p.surrounding === undefined ? false : bool(p.surrounding);
  if (citation.target === "memory" && (includeHistory || surrounding))
    invalid();
  return { citation, includeHistory, surrounding: surrounding ? 2 : 0 };
}
