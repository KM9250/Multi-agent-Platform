import React, { useEffect, useRef, useState } from "react";
import { DataDialog } from "./AppDataPanels";
import {
  AppAPIError,
  appRequest,
  roomPath,
  type RoomDTO,
} from "../services/appClient";
import {
  ASSERTION_TYPES,
  MEMORY_KINDS,
  MEMORY_SCOPES,
  type MemoryBinding,
  type MemoryCandidateDTO,
} from "../shared/memory-contracts";

const labels: Record<string, string> = {
  unclassified: "Unclassified",
  semantic: "Fact or preference",
  episodic: "Event",
  procedural: "Procedure",
  user_assertion: "User assertion",
  persona_subjective: "Persona perspective",
  verified_record: "Verified record",
  hypothesis: "Hypothesis",
  persona_private: "Private to Persona",
  room_shared: "Shared with room",
  PENDING_REVIEW: "Awaiting review",
  APPROVED: "Approved",
  PUBLISHING: "Publishing",
  PUBLISHED: "Published",
  MANUAL_PROPOSAL: "Approved · apply in Obsidian",
  REJECTED: "Rejected",
  FAILED: "Publication failed",
  CONFLICT: "Conflict",
  RETRACTED: "Retracted",
  DIRTY: "File changed",
  DELETED: "File missing",
  SUPERSEDED: "Superseded",
  NEEDS_REVIEW: "Needs review",
};
const label = (value: string) => labels[value] ?? value;
const small = "text-xs text-zinc-400";
const card = "space-y-3 rounded-lg border border-zinc-700 p-4";
const paragraph = "whitespace-pre-wrap break-words text-sm";
type MemoryPage = { items: MemoryCandidateDTO[]; nextCursor?: string };
type Note = {
  noteId: string;
  relativePath: string;
  personaId: string;
  state: string;
  version: number;
  scope: string;
  digest: string;
};
type HandwrittenSource = {
  type: "handwritten";
  noteId: string;
  version: number;
  relativePath: string;
  digest: string;
  registrar: string;
  registeredAt: number;
};
type NoteDetail = Note & {
  body: string;
  kind: string;
  assertionType: string;
  sourceRefs: (string | HandwrittenSource)[];
};
type NoteVersion = { version: number; recordedAt: number };
type Write = {
  path: string;
  method: "POST" | "PATCH";
  data: Record<string, unknown>;
  success: string;
  done?: () => void;
};
type Save = (operation: Write) => void;

function errorText(cause: unknown) {
  if (!(cause instanceof AppAPIError)) return "Connection failed.";
  if (cause.code === "MEMORY_UNAVAILABLE")
    return "The current publication is unavailable. Refresh after the Vault scan completes or open an authorized historical version.";
  if (cause.status === 403 || cause.status === 404)
    return "This operation or memory is unavailable to your account.";
  if (cause.status === 409)
    return "The saved state changed. Refresh and review the current version.";
  return cause.code;
}

// Repeat only reads while the panel is open. Abort pending reads when switching between rooms or versions.
function useRead<T>(
  path: string | undefined,
  refresh: number,
  expire: () => void,
) {
  const [result, setResult] = useState<{
    path: string;
    value?: T;
    error?: string;
  }>();
  const expireRef = useRef(expire);
  expireRef.current = expire;
  useEffect(() => {
    if (!path) {
      setResult(undefined);
      return;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function read() {
      try {
        const value = await appRequest<T>(
          path!,
          "GET",
          undefined,
          controller.signal,
        );
        if (!controller.signal.aborted) setResult({ path: path!, value });
      } catch (cause) {
        if (controller.signal.aborted) return;
        setResult({ path: path!, error: errorText(cause) });
        if (cause instanceof AppAPIError && cause.status === 401)
          expireRef.current();
      }
      if (!controller.signal.aborted) timer = setTimeout(read, 3500);
    }
    void read();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [path, refresh]);
  return result?.path === path ? result : undefined;
}

function SourceReader({
  path,
  refresh,
  expire,
}: {
  path: string;
  refresh: number;
  expire: () => void;
}) {
  const source = useRead<{ body: string }>(path, refresh, expire);
  if (source?.error) return <p role="alert">{source.error}</p>;
  return source?.value ? (
    <blockquote className="mt-2 border-l-2 border-zinc-600 pl-3 whitespace-pre-wrap break-words">
      {source.value.body}
    </blockquote>
  ) : (
    <p>Loading original…</p>
  );
}

function CandidateCard({
  item,
  name,
  selected,
  toggle,
  locked,
  save,
  base,
  refresh,
  expire,
}: {
  refresh: number;
  expire: () => void;
  item: MemoryCandidateDTO;
  name: string;
  selected: boolean;
  toggle: () => void;
  locked: boolean;
  save: Save;
  base: string;
}) {
  const [withdraw, setWithdraw] = useState<MemoryBinding>();
  const [showSource, setShowSource] = useState(false);
  const [draft, setDraft] = useState<MemoryCandidateDTO>();
  const editable = ["PENDING_REVIEW", "DRAFT"].includes(item.state);
  const stale = draft && draft.revision !== item.revision;
  const proposal = item.binding.targetVersion != null;
  return (
    <article className={card}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <label className="flex items-center gap-2 font-medium">
          {editable && (
            <input
              type="checkbox"
              aria-label={`Select candidate for ${name}`}
              checked={selected}
              disabled={locked || !!draft}
              onChange={toggle}
            />
          )}
          {name}
        </label>
        <span className="text-xs text-blue-300">{label(item.state)}</span>
      </div>
      <p className={small}>
        {label(item.scope)} · {label(item.kind)} · {label(item.assertionType)} ·
        Revision {item.revision}
      </p>
      <p className={small}>
        {proposal
          ? `Proposed text for note ${item.binding.targetNoteId}, version ${item.binding.targetVersion}. Apply the reviewed change in Obsidian.`
          : "Publishes as a new Markdown note in the registered MAP Vault."}
      </p>
      <p className={paragraph}>{item.body}</p>
      <details
        className={small}
        onToggle={(event) => {
          if (!event.currentTarget.open) setShowSource(false);
        }}
      >
        <summary className="cursor-pointer">
          Source and generation details
        </summary>
        {item.provenance && (
          <p className="my-2">
            {item.provenance.provider} · {item.provenance.model} ·{" "}
            {new Date(item.provenance.generatedAt).toLocaleString()}
          </p>
        )}
        <ul className="list-disc pl-5 break-all">
          {item.sourceRefs.map((ref) => (
            <li key={ref}>{ref}</li>
          ))}
        </ul>
        {item.provenance && (
          <p className="mt-2 break-all">
            Generation context manifest · {item.provenance.manifestDigest}
          </p>
        )}
        {item.sourceRefs.length > 0 && (
          <>
            <button
              className="map-button mt-2"
              onClick={() => setShowSource(!showSource)}
            >
              {showSource ? "Hide source text" : "Read source text"}
            </button>
            {showSource && (
              <SourceReader
                path={
                  base +
                  "/candidates/" +
                  encodeURIComponent(item.id) +
                  "/source"
                }
                refresh={refresh}
                expire={expire}
              />
            )}
          </>
        )}
      </details>
      {[
        "PENDING_REVIEW",
        "APPROVED",
        "PUBLISHING",
        "MANUAL_PROPOSAL",
        "FAILED",
        "CONFLICT",
      ].includes(item.state) &&
        (withdraw ? (
          <div className="space-y-2">
            <p className="text-sm">Withdraw this candidate and its approval?</p>
            <button
              className="map-button"
              disabled={locked || withdraw.revision !== item.revision}
              onClick={() =>
                save({
                  path:
                    base +
                    "/candidates/" +
                    encodeURIComponent(item.id) +
                    "/retract",
                  method: "POST",
                  data: { binding: withdraw },
                  success: "Candidate withdrawn.",
                  done: () => setWithdraw(undefined),
                })
              }
            >
              Confirm withdrawal
            </button>{" "}
            <button
              className="map-button"
              disabled={locked}
              onClick={() => setWithdraw(undefined)}
            >
              Cancel withdrawal
            </button>
          </div>
        ) : (
          <button
            className="map-button"
            disabled={locked}
            onClick={() => setWithdraw(item.binding)}
          >
            Withdraw candidate
          </button>
        ))}
      {item.state === "FAILED" && (
        <button
          className="map-button"
          disabled={locked}
          onClick={() =>
            save({
              path:
                base + "/candidates/" + encodeURIComponent(item.id) + "/retry",
              method: "POST",
              data: {},
              success: "Publication retry requested.",
            })
          }
        >
          Retry publication
        </button>
      )}
      {item.state === "CONFLICT" && (
        <p className="text-sm text-amber-300">
          The Vault file conflicts with this publication. Ask the Host to
          inspect both versions.
        </p>
      )}
      {draft ? (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (stale || !editable) return;
            save({
              path: `${base}/candidates/${encodeURIComponent(item.id)}`,
              method: "PATCH",
              data: {
                expectedRevision: draft.revision,
                body: draft.body,
                kind: draft.kind,
                assertionType: draft.assertionType,
                scope: draft.scope,
              },
              success: "Candidate revision saved.",
              done: () => setDraft(undefined),
            });
          }}
        >
          <label className="map-label">
            Candidate text
            <textarea
              className="map-input min-h-24"
              required
              value={draft.body}
              onChange={(event) =>
                setDraft({ ...draft, body: event.target.value })
              }
            />
          </label>
          <div className="grid gap-2 sm:grid-cols-3">
            <label className="map-label">
              Memory type
              <select
                className="map-input"
                value={draft.kind}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    kind: event.target.value as typeof draft.kind,
                  })
                }
              >
                {MEMORY_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {label(k)}
                  </option>
                ))}
              </select>
            </label>
            <label className="map-label">
              Claim type
              <select
                className="map-input"
                value={draft.assertionType}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    assertionType: event.target
                      .value as typeof draft.assertionType,
                  })
                }
              >
                {ASSERTION_TYPES.map((k) => (
                  <option key={k} value={k}>
                    {label(k)}
                  </option>
                ))}
              </select>
            </label>
            <label className="map-label">
              Publication scope
              <select
                className="map-input"
                value={draft.scope}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    scope: event.target.value as typeof draft.scope,
                  })
                }
              >
                {MEMORY_SCOPES.map((k) => (
                  <option key={k} value={k}>
                    {label(k)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {(stale || !editable) && (
            <p role="alert">
              This candidate changed. Compare your draft with the saved text
              above and reopen the editor to edit the current version.
            </p>
          )}
          {draft.scope === "room_shared" && (
            <p className="text-xs text-amber-300">
              Approval will make this text available within this room.
            </p>
          )}
          <div className="flex gap-2">
            <button
              className="map-button"
              disabled={locked || stale || !editable || !draft.body.trim()}
            >
              Save candidate
            </button>
            <button
              type="button"
              className="map-button"
              disabled={locked}
              onClick={() => setDraft(undefined)}
            >
              Cancel edit
            </button>
          </div>
        </form>
      ) : (
        editable && (
          <button
            className="map-button"
            disabled={locked}
            onClick={() => {
              if (selected) toggle();
              setDraft(item);
            }}
          >
            Edit candidate
          </button>
        )
      )}
    </article>
  );
}

function NoteReader({
  note,
  base,
  refresh,
  expire,
  save,
  locked,
}: {
  note: Note;
  base: string;
  refresh: number;
  expire: () => void;
  save: Save;
  locked: boolean;
}) {
  const [historyPages, setHistoryPages] = useState<number[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [version, setVersion] = useState<number>();
  const [proposal, setProposal] = useState<{
    body: string;
    expectedDigest: string;
    expectedVersion: number;
  }>();
  const [confirmRetract, setConfirmRetract] = useState<{
    expectedDigest: string;
    expectedVersion: number;
  }>();
  const path = `${base}/notes/${encodeURIComponent(note.noteId)}`;
  const history = useRead<NoteVersion[]>(
    historyOpen
      ? path +
          "/history" +
          (historyPages.length ? "?before=" + historyPages.at(-1) : "")
      : undefined,
    refresh,
    expire,
  );
  const url = version
    ? path + "?version=" + version
    : note.state === "PUBLISHED"
      ? path
      : undefined;
  const detail = useRead<NoteDetail>(url, refresh, expire);
  const data = detail?.value;
  const current =
    !version &&
    data?.version === note.version &&
    data?.digest === note.digest &&
    note.state === "PUBLISHED";
  const readable = version ? data?.version === version : current;
  return (
    <div className="space-y-3 border-t border-zinc-700 pt-3">
      <button
        className="map-button"
        onClick={() => {
          setHistoryOpen(!historyOpen);
          setVersion(undefined);
        }}
      >
        Version history
      </button>
      {historyOpen && (
        <>
          {history?.error && <p role="alert">{history.error}</p>}
          <label className="map-label">
            View version
            <select
              className="map-input"
              value={version ?? ""}
              onChange={(event) => {
                setVersion(Number(event.target.value) || undefined);
                setProposal(undefined);
                setConfirmRetract(undefined);
              }}
            >
              <option value="">Current publication</option>
              {history?.value?.map((v) => (
                <option key={v.version} value={v.version}>
                  Historical version {v.version}
                </option>
              ))}
            </select>
          </label>
          {historyPages.length > 0 && (
            <button
              className="map-button"
              onClick={() => {
                setVersion(undefined);
                setHistoryPages(historyPages.slice(0, -1));
              }}
            >
              Newer versions
            </button>
          )}
          {history?.value?.length === 200 && (
            <button
              className="map-button"
              onClick={() => {
                setVersion(undefined);
                setHistoryPages([
                  ...historyPages,
                  history.value!.at(-1)!.version,
                ]);
              }}
            >
              Older versions
            </button>
          )}
        </>
      )}
      {!url && (
        <p role="status" className={small}>
          Current text unavailable · {label(note.state)}
        </p>
      )}
      {url && !detail?.error && !readable && (
        <p role="status" className={small}>
          Checking the requested version…
        </p>
      )}
      {detail?.error && <p role="alert">{detail.error}</p>}
      {data && readable && (
        <>
          <h4 className="font-medium">
            {version
              ? `Historical version ${version}`
              : `Current version ${data.version}`}
          </h4>
          <p className={paragraph}>{data.body}</p>
          <p className={small}>
            {label(data.kind)} · {label(data.assertionType)}
          </p>
          {data.sourceRefs.length > 0 && (
            <details className={small}>
              <summary className="cursor-pointer">Note source</summary>
              <ul className="mt-2 space-y-2 break-all">
                {data.sourceRefs.map((ref) =>
                  typeof ref === "string" ? (
                    <li key={ref}>{ref}</li>
                  ) : (
                    <li key={ref.noteId} className="space-y-1">
                      <p>Handwritten note · registered by {ref.registrar}</p>
                      <p>
                        Original file · {ref.relativePath} (version{" "}
                        {ref.version})
                      </p>
                      <p>
                        Registered {new Date(ref.registeredAt).toLocaleString()}
                      </p>
                      <p>Original file digest · {ref.digest}</p>
                    </li>
                  ),
                )}
              </ul>
            </details>
          )}
          {current && (
            <div className="flex flex-wrap gap-2">
              <button
                className="map-button"
                disabled={locked}
                onClick={() => {
                  setConfirmRetract(undefined);
                  setProposal({
                    body: data.body,
                    expectedVersion: data.version,
                    expectedDigest: data.digest,
                  });
                }}
              >
                Propose a change
              </button>
            </div>
          )}
        </>
      )}
      {!version && note.state !== "RETRACTED" && !confirmRetract && (
        <button
          className="map-button"
          disabled={locked}
          onClick={() => {
            setProposal(undefined);
            setConfirmRetract({
              expectedVersion: note.version,
              expectedDigest: note.digest,
            });
          }}
        >
          Retract publication
        </button>
      )}
      {proposal && (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            save({
              path: path + "/proposals",
              method: "POST",
              data: proposal,
              success: "Change proposal saved for review.",
              done: () => setProposal(undefined),
            });
          }}
        >
          <label className="map-label">
            Proposed text for version {proposal.expectedVersion}
            <textarea
              className="map-input min-h-24"
              value={proposal.body}
              required
              onChange={(event) =>
                setProposal({ ...proposal, body: event.target.value })
              }
            />
          </label>
          <button
            className="map-button"
            disabled={
              locked ||
              !current ||
              proposal.expectedDigest !== data?.digest ||
              !proposal.body.trim()
            }
          >
            Save proposal
          </button>{" "}
          <button
            className="map-button"
            type="button"
            onClick={() => setProposal(undefined)}
          >
            Cancel proposal
          </button>
        </form>
      )}
      {confirmRetract && (
        <div className="space-y-2">
          <p>
            Withdraw registered version {confirmRetract.expectedVersion} from
            current memory?
          </p>
          <button
            className="map-button"
            disabled={
              locked ||
              !!version ||
              note.state === "RETRACTED" ||
              confirmRetract.expectedVersion !== note.version ||
              confirmRetract.expectedDigest !== note.digest
            }
            onClick={() =>
              save({
                path: path + "/retract",
                method: "POST",
                data: confirmRetract,
                success: "Publication retracted.",
                done: () => setConfirmRetract(undefined),
              })
            }
          >
            Confirm retraction
          </button>{" "}
          <button
            className="map-button"
            onClick={() => setConfirmRetract(undefined)}
          >
            Cancel retraction
          </button>
        </div>
      )}
    </div>
  );
}

export default function MemoryPanel({
  room,
  close,
  onSessionExpired,
}: {
  room: RoomDTO;
  close: () => void;
  onSessionExpired: () => void;
}) {
  const base = roomPath(room.id) + "/memory";
  const [tab, setTab] = useState<"candidates" | "notes">("candidates");
  const [pages, setPages] = useState<string[]>([""]);
  const [refresh, setRefresh] = useState(0);
  const cursor = pages.at(-1);
  const [notePages, setNotePages] = useState<string[]>([]);
  const candidates = useRead<MemoryPage>(
    tab === "candidates"
      ? base +
          "/candidates" +
          (cursor ? "?after=" + encodeURIComponent(cursor) : "")
      : undefined,
    refresh,
    onSessionExpired,
  );
  const notes = useRead<Note[]>(
    tab === "notes"
      ? base +
          "/notes" +
          (notePages.length
            ? "?after=" + encodeURIComponent(notePages.at(-1)!)
            : "")
      : undefined,
    refresh,
    onSessionExpired,
  );
  const [selection, setSelection] = useState<Map<string, MemoryBinding>>(
    new Map(),
  );
  const [openedNote, setOpenedNote] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState<Write>();
  const [notice, setNotice] = useState("");
  const inFlight = useRef(false);
  const controller = useRef<AbortController>(undefined);
  useEffect(() => {
    controller.current = new AbortController();
    return () => controller.current?.abort();
  }, []);
  const selected = (candidates?.value?.items ?? []).filter((c) => {
    const seen = selection.get(c.id);
    // Revisions bind all editable fields. A stale selection must never approve a replacement revision.
    return (
      ["PENDING_REVIEW", "DRAFT"].includes(c.state) &&
      seen?.revision === c.revision &&
      seen.bodyDigest === c.binding.bodyDigest &&
      seen.sourcesDigest === c.binding.sourcesDigest &&
      seen.ownerPersonaId === c.binding.ownerPersonaId &&
      seen.scope === c.scope &&
      seen.targetNoteId === c.binding.targetNoteId &&
      seen.targetVersion === c.binding.targetVersion &&
      seen.targetDigest === c.binding.targetDigest
    );
  });
  const locked = busy || !!uncertain;
  const name = (id: string) => room.agents.find((a) => a.id === id)?.name ?? id;
  async function submit(write: Write) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setNotice("");
    const signal = controller.current?.signal;
    try {
      await appRequest(write.path, write.method, write.data, signal);
      if (signal?.aborted) return;
      setUncertain(undefined);
      setNotice(write.success);
      write.done?.();
    } catch (cause) {
      if (signal?.aborted) return;
      if (cause instanceof AppAPIError && cause.status === 401) {
        onSessionExpired();
        return;
      }
      if (cause instanceof AppAPIError && cause.status < 500) {
        setUncertain(undefined);
        setNotice(errorText(cause));
      } else {
        setUncertain(write);
        setNotice(
          "The server receipt was interrupted. Retry the same request to confirm its outcome.",
        );
      }
    } finally {
      if (!signal?.aborted) {
        inFlight.current = false;
        setBusy(false);
        setRefresh((n) => n + 1);
      }
    }
  }
  function save(write: Write) {
    if (!locked)
      void submit({
        ...write,
        data: { ...write.data, requestId: crypto.randomUUID() },
      });
  }
  function review(decision: "approve" | "reject") {
    if (!selected.length || selected.length !== selection.size) return;
    save({
      path: base + "/reviews",
      method: "POST",
      data: { decision, items: selected.map((c) => selection.get(c.id)) },
      success:
        decision === "approve"
          ? "Approval saved. Each candidate shows its publication status."
          : "Selected candidates rejected.",
      done: () => setSelection(new Map()),
    });
  }
  function changePage(stack: string[]) {
    setPages(stack);
    setSelection(new Map());
  }
  const failure = tab === "notes" ? notes?.error : candidates?.error;
  return (
    <DataDialog title="Room memory" close={close}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <button
            className="map-button"
            aria-pressed={tab === "candidates"}
            disabled={locked}
            onClick={() => setTab("candidates")}
          >
            Candidates
          </button>
          <button
            className="map-button"
            aria-pressed={tab === "notes"}
            disabled={locked}
            onClick={() => setTab("notes")}
          >
            Vault notes
          </button>
          <button
            className="map-button ml-auto"
            onClick={() => setRefresh((n) => n + 1)}
          >
            Refresh memory
          </button>
        </div>
        {busy && (
          <p className={small} role="status">
            Saving the memory operation…
          </p>
        )}
        {notice && (
          <p className="text-sm text-blue-300" role="status">
            {notice}
          </p>
        )}
        {uncertain && (
          <button
            className="map-button"
            disabled={busy}
            onClick={() => void submit(uncertain)}
          >
            Retry same request
          </button>
        )}
        {failure && <p role="alert">{failure}</p>}
        {tab === "candidates" && (
          <>
            {!candidates && <p role="status">Loading candidates…</p>}
            {candidates?.value?.items.length === 0 && (
              <p className="text-sm">
                No candidates available for review in this room. Generate
                candidates with /memory.
              </p>
            )}
            {!!candidates?.value?.items.length && (
              <div className="space-y-2">
                <p className="text-sm">
                  Review the text, Persona and publication scope before
                  approving.
                </p>
                {selection.size !== selected.length && (
                  <p role="alert">
                    A selected candidate changed. Clear your selection and
                    review the current versions.
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  {selection.size > 0 && (
                    <button
                      className="map-button"
                      disabled={locked}
                      onClick={() => setSelection(new Map())}
                    >
                      Clear selection
                    </button>
                  )}
                  <button
                    className="map-button"
                    disabled={
                      locked ||
                      !selected.length ||
                      selection.size !== selected.length
                    }
                    onClick={() => review("approve")}
                  >
                    Approve selected ({selected.length})
                  </button>
                  <button
                    className="map-button"
                    disabled={
                      locked ||
                      !selected.length ||
                      selection.size !== selected.length
                    }
                    onClick={() => review("reject")}
                  >
                    Reject selected ({selected.length})
                  </button>
                </div>
              </div>
            )}
            {candidates?.value?.items.map((item) => (
              <React.Fragment key={item.id}>
                <CandidateCard
                  item={item}
                  base={base}
                  expire={onSessionExpired}
                  refresh={refresh}
                  name={name(item.ownerPersonaId)}
                  selected={selected.some((c) => c.id === item.id)}
                  locked={locked}
                  save={save}
                  toggle={() => {
                    const next = new Map(selection);
                    if (selected.some((c) => c.id === item.id))
                      next.delete(item.id);
                    else next.set(item.id, item.binding);
                    setSelection(next);
                  }}
                />
              </React.Fragment>
            ))}
            <div className="flex gap-2">
              {pages.length > 1 && (
                <button
                  className="map-button"
                  disabled={locked}
                  onClick={() => changePage(pages.slice(0, -1))}
                >
                  Previous candidates
                </button>
              )}
              {candidates?.value?.nextCursor && (
                <button
                  className="map-button"
                  disabled={locked}
                  onClick={() =>
                    changePage([...pages, candidates.value!.nextCursor!])
                  }
                >
                  More candidates
                </button>
              )}
            </div>
          </>
        )}
        {tab === "notes" && (
          <>
            {!notes && <p role="status">Loading notes…</p>}
            {notes?.value?.length === 0 && (
              <p className="text-sm">No Vault notes available in this room.</p>
            )}
            {notes?.value?.map((note) => (
              <article key={note.noteId} className={card}>
                <h3 className="font-medium break-all">
                  {note.relativePath || note.noteId}
                </h3>
                <p className={small}>
                  {name(note.personaId)} · {label(note.scope)} ·{" "}
                  {label(note.state)} · Version {note.version}
                </p>
                <button
                  className="map-button"
                  onClick={() =>
                    setOpenedNote(
                      openedNote === note.noteId ? undefined : note.noteId,
                    )
                  }
                >
                  {openedNote === note.noteId ? "Close note" : "View note"}
                </button>
                {openedNote === note.noteId && (
                  <NoteReader
                    note={note}
                    base={base}
                    refresh={refresh}
                    expire={onSessionExpired}
                    save={save}
                    locked={locked}
                  />
                )}
              </article>
            ))}
            {notePages.length > 0 && (
              <button
                className="map-button"
                disabled={locked}
                onClick={() => setNotePages(notePages.slice(0, -1))}
              >
                Previous notes
              </button>
            )}
            {notes?.value?.length === 200 && (
              <button
                className="map-button"
                disabled={locked}
                onClick={() =>
                  setNotePages([...notePages, notes.value!.at(-1)!.noteId])
                }
              >
                More notes
              </button>
            )}
          </>
        )}
      </div>
    </DataDialog>
  );
}
