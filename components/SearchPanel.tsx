import React, { useLayoutEffect, useRef, useState } from "react";
import { AppAPIError, type RoomDTO } from "../services/appClient";
import { openSearchCitation, searchRoom } from "../services/searchClient";
import type {
  CitationResponse,
  SearchCitation,
  SearchRequest,
  SearchResponse,
  SearchResult,
} from "../shared/search-contracts";
import { DataDialog } from "./AppDataPanels";

const stateLabels: Record<SearchResponse["status"], string> = {
  ready: "Search complete",
  partial: "Partial results",
  degraded: "Reduced search coverage",
  unbuilt: "The room index has not been built.",
  building: "Index synchronization is in progress.",
  resync_required:
    "The room index needs resynchronization. Run the search again after it is rebuilt.",
  stopped: "Room indexing is paused.",
  unavailable: "The room index is unavailable.",
};
const methodLabels = {
  lexical: "Local text search",
  dense: "Dense search",
  rerank: "Reranking",
};
const denseReasons: Record<string, string> = {
  profile_unconfigured_or_stopped: "the search profile is missing or stopped",
  profile_scope: "the Persona is outside the search profile",
  query_disabled: "the profile does not permit sending queries",
  incomplete_dense_coverage: "the vector index is incomplete",
  no_dense_coverage: "the vector index has no eligible records",
  unconfigured_provider: "the embedding provider is unconfigured",
  outcome_unknown: "the provider did not confirm the outcome",
  provider_rejected: "the provider rejected the request",
  budget_exhausted: "the search budget has been reached",
  dense_limit: "the searchable vectors exceed the processing limit",
  dense_unavailable: "the dense search service is unavailable",
};
function reasonText(reason: string, denseState?: string) {
  if (reason === "INDEX_LAGGING")
    return "Recent changes may be missing from these results. Run the search again after the index synchronizes.";
  if (reason === "INDEX_FRESHNESS_UNAVAILABLE")
    return "Index freshness could not be verified. Retry the search or ask the Host to check synchronization.";
  if (reason === "DEADLINE_EXCEEDED")
    return "Search reached its time limit. Retry or narrow the search.";
  if (reason === "INDEX_REFRESH_FAILED")
    return "The last index update failed. The Host can check the index and retry synchronization.";
  if (reason === "INDEX_REFRESHING")
    return "The index is updating. Run the search again after synchronization.";
  const label = reason.replaceAll("_", " ").toLowerCase();
  return reason === denseState
    ? `Dense search unavailable (${denseReasons[reason] ?? label}).`
    : label;
}
const revisionLabels: Record<string, string> = {
  original: "Original",
  correction: "Correction",
  regeneration: "Regeneration",
  revision: "Revision",
};
const textClass =
  "whitespace-pre-wrap break-words border-l-2 border-zinc-600 pl-3 text-sm";
const metaClass = "text-xs text-zinc-400";

function sourceError(cause: unknown) {
  if (!(cause instanceof AppAPIError))
    return "Connection failed. Run the search again.";
  if (cause.code.includes("RESYNC_REQUIRED"))
    return stateLabels.resync_required;
  if (cause.status === 403 || cause.status === 404)
    return "This search or source is unavailable to your account.";
  if (cause.status === 409)
    return "The source or index changed. Search again to see the current version, or select Archive history to look for an earlier revision.";
  return cause.code;
}

function recordedTime(timestamp: number, timeZone?: string) {
  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}

function CitationDetails({ citation }: { citation: SearchCitation }) {
  return (
    <details className={metaClass}>
      <summary className="cursor-pointer">Citation details</summary>
      <dl className="mt-2 space-y-1 break-all">
        {(citation.target === "memory"
          ? [
              ["Note", citation.noteId],
              ["File digest", citation.fileDigest],
              ["Body digest", citation.bodyDigest],
            ]
          : [
              ["Message", citation.messageId],
              ["Revision", citation.revisionId],
              ["Segment", citation.segmentId],
              ["Segment digest", citation.segmentDigest],
            ]
        ).map(([label, value]) => (
          <div key={label}>
            <dt className="inline font-medium">{label} </dt>
            <dd className="inline font-mono">{value}</dd>
          </div>
        ))}
        <div>
          <dt className="inline font-medium">UTF-16 range </dt>
          <dd className="inline">
            [{citation.start}, {citation.end})
          </dd>
        </div>
      </dl>
    </details>
  );
}

export default function SearchPanel({
  room,
  close,
  onSessionExpired,
}: {
  room: RoomDTO;
  close: () => void;
  onSessionExpired: () => void;
}) {
  const [target, setTarget] = useState<SearchRequest["target"]>("memory");
  const [query, setQuery] = useState("");
  const [personaId, setPersonaId] = useState("");
  const [history, setHistory] = useState(false);
  const [anchor, setAnchor] = useState("");
  const [endDate, setEndDate] = useState("");
  const [strict, setStrict] = useState(false);
  const [zone, setZone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  );
  const [response, setResponse] = useState<SearchResponse>();
  const [source, setSource] = useState<{
    index: number;
    value: CitationResponse;
  }>();
  const [busy, setBusy] = useState<"search" | "source">();
  const [error, setError] = useState("");
  const active = useRef<AbortController>();

  function discard() {
    active.current?.abort();
    setResponse(undefined);
    setSource(undefined);
    setBusy(undefined);
    setError("");
  }
  useLayoutEffect(() => {
    const onHide = () => {
      discard();
      setQuery("");
    };
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      active.current?.abort();
    };
  }, []);

  async function perform(
    kind: "search" | "source",
    operation: (signal: AbortSignal) => Promise<void>,
  ) {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setBusy(kind);
    setError("");
    setSource(undefined);
    try {
      await operation(controller.signal);
    } catch (cause) {
      if (controller.signal.aborted) return;
      setResponse(undefined);
      setSource(undefined);
      if (cause instanceof AppAPIError && cause.status === 401) {
        onSessionExpired();
        return;
      }
      if (
        cause instanceof AppAPIError &&
        (cause.status === 403 || cause.code.includes("RESYNC_REQUIRED"))
      )
        setQuery("");
      setError(sourceError(cause));
    } finally {
      if (!controller.signal.aborted) setBusy(undefined);
    }
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!query.trim()) return;
    setResponse(undefined);
    const request: SearchRequest = {
      requestId: crypto.randomUUID(),
      target,
      query: query.trim(),
      revisionMode:
        target === "archive" && history ? "include_history" : "current",
      retrievalMode: "auto",
      ...(personaId ? { personaId } : {}),
      ...(target === "archive" && anchor
        ? {
            date: {
              mode: strict ? "strict" : "approx",
              anchorDate: anchor,
              timeZone: zone,
              ...(strict && endDate ? { endDate } : {}),
            },
          }
        : {}),
    };
    void perform("search", async (signal) => {
      const result = await searchRoom(room.id, request, signal);
      if (signal.aborted) return;
      if (result.status === "resync_required") {
        setQuery("");
        setError(stateLabels.resync_required);
        return;
      }
      setResponse(result);
    });
  }
  function open(index: number, hit: SearchResult, surrounding: boolean) {
    void perform("source", async (signal) => {
      const value = await openSearchCitation(
        room.id,
        hit.citation,
        !hit.current && response?.scope.revisionMode === "include_history",
        surrounding,
        signal,
      );
      if (!signal.aborted) setSource({ index, value });
    });
  }
  const names = new Map(
    room.agents.map((agent) => [agent.id, agent.name] as const),
  );
  const date = response?.scope.date;

  return (
    <DataDialog title="Search room" close={close}>
      <form
        className="space-y-3"
        onSubmit={submit}
        onChange={discard}
        autoComplete="off"
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="map-label">
            Search in
            <select
              className="map-input"
              value={target}
              onChange={(e) =>
                setTarget(e.target.value as SearchRequest["target"])
              }
            >
              <option value="memory">Memory · published notes</option>
              <option value="archive">Archive · original conversations</option>
            </select>
          </label>
          <label className="map-label">
            Persona
            <select
              className="map-input"
              aria-label="Persona"
              value={personaId}
              onChange={(e) => setPersonaId(e.target.value)}
            >
              <option value="">All available</option>
              {room.agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="map-label">
          Search terms
          <input
            className="map-input"
            type="text"
            required
            maxLength={512}
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        {target === "archive" && (
          <>
            <label className="map-label">
              Conversation revisions
              <select
                className="map-input"
                value={history ? "include_history" : "current"}
                onChange={(e) =>
                  setHistory(e.target.value === "include_history")
                }
              >
                <option value="current">Current only</option>
                <option value="include_history">
                  Include historical revisions
                </option>
              </select>
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="map-label">
                Conversation date (optional)
                <input
                  className="map-input"
                  type="date"
                  value={anchor}
                  onChange={(e) => setAnchor(e.target.value)}
                />
              </label>
              {anchor && (
                <label className="map-label">
                  Time zone
                  <input
                    className="map-input"
                    required
                    maxLength={80}
                    value={zone}
                    onChange={(e) => setZone(e.target.value)}
                  />
                </label>
              )}
            </div>
            {anchor && (
              <>
                <label className="map-label">
                  Date matching
                  <select
                    className="map-input"
                    value={strict ? "strict" : "approx"}
                    onChange={(e) => setStrict(e.target.value === "strict")}
                  >
                    <option value="approx">
                      Within 7 calendar days either side
                    </option>
                    <option value="strict">Exact date or period</option>
                  </select>
                </label>
                {strict && (
                  <label className="map-label">
                    End date (optional)
                    <input
                      className="map-input"
                      type="date"
                      min={anchor}
                      value={endDate}
                      onChange={(e) => setEndDate(e.target.value)}
                    />
                  </label>
                )}
              </>
            )}
          </>
        )}
        <button
          className="map-button"
          disabled={busy === "search" || !query.trim()}
        >
          {busy === "search" ? "Searching…" : "Search"}
        </button>
      </form>
      {error && (
        <p role="alert" className="mt-4 text-sm text-amber-300">
          {error}
        </p>
      )}
      {response && (
        <section
          className="mt-5 space-y-3 border-t border-zinc-700 pt-4"
          aria-label="Search results"
        >
          <h3 className="font-medium" role="status">
            {stateLabels[response.status]}
          </h3>
          <p className={metaClass}>
            {room.title} ·{" "}
            {response.scope.target === "memory" ? "Memory" : "Archive"} ·{" "}
            {response.scope.revisionMode === "include_history"
              ? "Current and historical versions"
              : "Current versions"}
            {response.scope.personaId &&
              ` · ${names.get(response.scope.personaId) ?? "Selected Persona"}`}
          </p>
          {!date && response.scope.target === "archive" && (
            <p className={metaClass}>All recorded dates</p>
          )}
          {date && (
            <p className="text-sm">
              Requested {date.anchorDate}
              {date.endDate && ` through ${date.endDate}`} · Searched{" "}
              {date.firstDate} through {date.lastDate} ({date.timeZone})
            </p>
          )}
          <p className={metaClass}>
            Index {response.coverage.indexState} ·{" "}
            {response.methods.length
              ? response.methods
                  .map((method) => methodLabels[method])
                  .join(" + ")
              : "No retrieval executed"}{" "}
            · {Math.round(response.elapsedMs)} ms
            {response.external.calls === 0 && " · No external calls"}
          </p>
          {response.coverage.syncedAt !== undefined && (
            <p className={metaClass}>
              Last completed sync{" "}
              <time
                dateTime={new Date(response.coverage.syncedAt).toISOString()}
              >
                {recordedTime(response.coverage.syncedAt, date?.timeZone)}
              </time>
              {response.coverage.updating && " · Updating"}
            </p>
          )}
          {response.reasons.length > 0 && (
            <ul className="list-disc pl-5 text-sm text-amber-300">
              {response.reasons.map((reason) => (
                <li key={reason}>
                  {reasonText(reason, response.coverage.denseState)}
                </li>
              ))}
            </ul>
          )}
          {response.results.length === 0 && response.status === "ready" && (
            <p>
              No matching record was found within the saved records you can
              access in this search.
            </p>
          )}
          {response.results.length === 0 && response.status === "partial" && (
            <p>No verified matches are available in these partial results.</p>
          )}
          {response.results.length === 0 &&
            response.status === "degraded" &&
            response.methods.length === 1 &&
            response.methods[0] === "lexical" && (
              <p>Local text search returned no matches.</p>
            )}
          {response.results.map((hit, index) => (
            <article
              className="space-y-2 rounded-lg border border-zinc-700 p-3"
              key={index}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <strong className="text-sm">
                  {hit.citation.target === "memory"
                    ? "Published note"
                    : "Conversation"}{" "}
                  · {hit.current ? "Current" : "Historical"} version{" "}
                  {hit.citation.version}
                  {hit.citation.target === "archive" &&
                    hit.revisionKind &&
                    ` · ${revisionLabels[hit.revisionKind] ?? "Revision"}`}
                </strong>
                <time
                  className={metaClass}
                  dateTime={new Date(hit.recordedAt).toISOString()}
                >
                  {hit.citation.target === "memory"
                    ? "Version recorded "
                    : "Occurred "}
                  {recordedTime(hit.recordedAt, date?.timeZone)}
                </time>
              </div>
              <p className={metaClass}>
                {[
                  hit.role,
                  hit.speakerId && names.get(hit.speakerId),
                  hit.channel,
                  hit.visibility,
                  hit.personaId &&
                    `Persona: ${names.get(hit.personaId) ?? hit.personaId}`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              <blockquote className={textClass}>{hit.snippet}</blockquote>
              <CitationDetails citation={hit.citation} />
              <div className="flex flex-wrap gap-2">
                <button
                  className="map-button"
                  disabled={busy === "source"}
                  onClick={() => open(index, hit, false)}
                >
                  {hit.current ? "Open original" : "Open historical original"}
                </button>
                {hit.citation.target === "archive" && (
                  <button
                    className="map-button"
                    disabled={busy === "source"}
                    onClick={() => open(index, hit, true)}
                  >
                    Open surrounding messages
                  </button>
                )}
              </div>
              {source?.index === index && (
                <section
                  aria-label="Verified source"
                  className="space-y-2 border-t border-zinc-700 pt-2"
                >
                  <h4 className="text-sm font-medium">
                    Verified source · Version {source.value.citation.version}
                    {source.value.citation.target === "archive" &&
                      source.value.revisionKind &&
                      ` · ${revisionLabels[source.value.revisionKind] ?? "Revision"}`}
                  </h4>
                  <blockquote className={textClass}>
                    {source.value.text}
                  </blockquote>
                  {source.value.surrounding?.map((entry, i) => (
                    <div key={i}>
                      <time className={metaClass}>
                        {recordedTime(entry.recordedAt, date?.timeZone)}
                      </time>
                      <blockquote className={textClass}>
                        {entry.text}
                      </blockquote>
                    </div>
                  ))}
                  <button
                    className="map-button"
                    onClick={() => setSource(undefined)}
                  >
                    Close original
                  </button>
                </section>
              )}
            </article>
          ))}
        </section>
      )}
    </DataDialog>
  );
}
