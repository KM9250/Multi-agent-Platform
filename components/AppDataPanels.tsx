import React, { useState } from "react";
import {
  AppAPIError,
  appRequest,
  downloadJSON,
  type SessionDTO,
} from "../services/appClient";

export function DataDialog({
  title,
  children,
  close,
}: {
  title: string;
  children: React.ReactNode;
  close: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
      <section
        role="dialog"
        aria-label={title}
        aria-modal="true"
        className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-xl border border-zinc-700 bg-zinc-900 p-5"
      >
        <div className="flex items-center justify-between gap-4 mb-4">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button
            className="map-button"
            onClick={close}
            aria-label={`Close ${title}`}
          >
            Close
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}
export function LoginPanel({
  onLogin,
}: {
  onLogin: (session: SessionDTO) => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const session = await appRequest<SessionDTO>("/session/login", "POST", {
        username,
        password,
      });
      setPassword("");
      onLogin(session);
    } catch (e) {
      setPassword("");
      setError(e instanceof AppAPIError ? e.code : "CONNECTION_FAILED");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="min-h-screen flex items-center justify-center bg-zinc-950 p-6">
      <form
        onSubmit={submit}
        className="max-w-sm w-full rounded-2xl border border-zinc-800 bg-zinc-900 p-8 space-y-5"
      >
        <div>
          <p className="text-xs tracking-widest text-blue-400 mb-2">
            MULTI-AGENT NEXUS
          </p>
          <h1 className="text-2xl font-semibold">Sign in</h1>
          <p className="text-sm text-zinc-400 mt-2">
            Your rooms and conversations are saved on the server.
          </p>
        </div>
        <label className="map-label">
          Username
          <input
            className="map-input"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            maxLength={128}
          />
        </label>
        <label className="map-label">
          Password
          <input
            className="map-input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            maxLength={1024}
          />
        </label>
        {error && (
          <p role="alert" className="text-sm text-red-300">
            {error}
          </p>
        )}
        <button className="map-button w-full" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <p className="text-xs text-zinc-500">
          Use a local account created by the host administrator.
        </p>
      </form>
    </main>
  );
}

interface LegacyFile {
  schema: string;
  sourceId: string;
  rooms: unknown[];
}
export function MigrationPanel({
  close,
  imported,
  onError,
}: {
  close: () => void;
  imported: () => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const [source, setSource] = useState<LegacyFile>();
  const [legacyRaw, setLegacyRaw] = useState<string>();
  const [report, setReport] = useState<unknown>();
  const [dryRun, setDryRun] = useState(false);
  const [complete, setComplete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [requestId, setRequestId] = useState(crypto.randomUUID());
  const accept = (value: LegacyFile, raw?: string) => {
    setSource(value);
    setLegacyRaw(raw);
    setReport(undefined);
    setDryRun(false);
    setComplete(false);
    setRequestId(crypto.randomUUID());
  };
  const exportLegacy = () => {
    try {
      const raw = localStorage.getItem("rooms");
      if (!raw) throw new AppAPIError("NO_LEGACY_ROOMS", 400);
      if (raw.length > 8 * 1024 * 1024)
        throw new AppAPIError("IMPORT_TOO_LARGE", 413);
      const rooms = JSON.parse(raw);
      if (!Array.isArray(rooms))
        throw new AppAPIError("INVALID_LEGACY_ROOMS", 400);
      const value = {
        schema: "MAP-DATA-1:LEGACY_EXPORT:1",
        sourceId: crypto.randomUUID(),
        rooms,
      };
      accept(value, raw);
      downloadJSON("map-legacy-export.json", value);
    } catch (error) {
      onError(error);
    }
  };
  const choose = async (file?: File) => {
    if (!file) return;
    try {
      if (file.size > 8 * 1024 * 1024)
        throw new AppAPIError("IMPORT_TOO_LARGE", 413);
      const parsed = JSON.parse(await file.text());
      if (
        !parsed ||
        !Array.isArray(parsed.rooms) ||
        typeof parsed.sourceId !== "string"
      )
        throw new AppAPIError("INVALID_LEGACY_EXPORT", 400);
      accept({
        schema: "MAP-DATA-1:LEGACY_EXPORT:1",
        sourceId: parsed.sourceId,
        rooms: parsed.rooms,
      });
    } catch (error) {
      onError(error);
    }
  };
  const execute = async (commit: boolean) => {
    if (!source || busy) return;
    setBusy(true);
    try {
      const body = {
        sourceId: source.sourceId,
        rooms: source.rooms,
        ...(commit ? { requestId } : {}),
      };
      let result = await appRequest<Record<string, unknown>>(
        commit ? "/migrations/import" : "/migrations/dry-run",
        "POST",
        body,
      );
      if (commit && typeof result.batchId === "string")
        result = await appRequest(
          `/migrations/${encodeURIComponent(result.batchId)}`,
        );
      setReport(result);
      setDryRun(!commit);
      if (commit) {
        const status = String(
          result.status ?? result.state ?? "",
        ).toUpperCase();
        const done = ["COMPLETED", "COMPLETE", "RECONCILED"].includes(status);
        setComplete(done);
        if (done) await imported();
      }
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <DataDialog title="Legacy migration" close={close}>
      <div className="space-y-4 text-sm">
        <p className="text-zinc-400">
          Export the known legacy “rooms” key, inspect a dry run, then
          explicitly import. The original browser copy stays intact. Export
          files may contain sensitive content; keep them in a protected
          location.
        </p>
        <div className="flex flex-wrap gap-2">
          <button className="map-button" onClick={exportLegacy} disabled={busy}>
            Export this browser’s legacy rooms
          </button>
          <label className="map-button cursor-pointer">
            Open legacy export
            <input
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(event) => void choose(event.target.files?.[0])}
            />
          </label>
        </div>
        {source && (
          <>
            <p>
              Selected source: <code>{source.sourceId}</code> ·{" "}
              {source.rooms.length} room records
            </p>
            <div className="flex gap-2">
              <button
                className="map-button"
                disabled={busy}
                onClick={() => void execute(false)}
              >
                Dry run
              </button>
              <button
                className="map-button"
                disabled={busy || !dryRun}
                onClick={() => void execute(true)}
              >
                Confirm import
              </button>
            </div>
          </>
        )}
        {report !== undefined && (
          <pre
            className="max-h-72 overflow-auto text-xs whitespace-pre-wrap rounded-lg bg-zinc-950 p-3"
            aria-label="Migration report"
          >
            {JSON.stringify(report, null, 2)}
          </pre>
        )}
        {complete && (
          <p role="status" className="text-green-300">
            Import reconciled. Reopen the rooms to verify the saved content.
          </p>
        )}
        {complete && legacyRaw && (
          <button
            className="map-button"
            onClick={() => {
              if (localStorage.getItem("rooms") !== legacyRaw) {
                onError(new AppAPIError("LEGACY_COPY_CHANGED", 409));
                return;
              }
              if (
                window.confirm(
                  "You have verified the imported rooms. Delete only this browser’s unchanged legacy rooms copy?",
                )
              ) {
                localStorage.removeItem("rooms");
                setLegacyRaw(undefined);
              }
            }}
          >
            Delete verified legacy copy
          </button>
        )}
      </div>
    </DataDialog>
  );
}
