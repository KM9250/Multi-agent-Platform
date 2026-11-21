import {
  ASSERTION_TYPES,
  MEMORY_KINDS,
  MEMORY_SCOPES,
} from "../../shared/memory-contracts.ts";
import type { DatabaseSync } from "node:sqlite";
import { lstatSync, opendirSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { setImmediate as yieldLoop } from "node:timers/promises";
import { AppError } from "../../shared/app-contracts/index.ts";
import type { AppDatabase } from "../app-data/db.ts";
import {
  bool,
  canonical,
  digest,
  integer,
  object,
  string,
} from "../app-data/validation.ts";
import {
  type Actor,
  type ResourceScope,
  AuthorizationPolicy,
} from "../auth/authorization.ts";
import { parseMemoryMarkdown } from "./markdown.ts";
import {
  assertDocumentSources,
  setDocumentState,
  type DocumentRow,
} from "./notes.ts";
import {
  assertPublicationCapacity,
  MAX_LIVE_NOTES,
  LIVE_NOTE_PREDICATE,
  MAX_INVENTORY_ENTRIES,
} from "./limits.ts";
import {
  readVaultFile,
  readVersion,
  saveVersion,
  validVaultPath,
  vaultRoot,
  withVaultDirectory,
} from "./vault.ts";

/** One complete inventory supplies duplicate detection. Exceeding a budget never authorizes a partial inventory. */
const BYTE_SLICE = 1024 * 1024;
export const MEMORY_SETTLE_MS = 500;
const PERIOD_MS = 10_000;
const active = new WeakMap<AppDatabase, Promise<{ status: string }>>();
const terminal = (state: string) =>
  ["LINEAGE_PENDING", "NEEDS_REVIEW", "RETRACTED"].includes(state);
function running(app: AppDatabase) {
  return !!app.db
    .prepare(
      `SELECT 1 FROM memory_vault,app_operational_state WHERE paused=0 AND maintenance=0 AND restored=0`,
    )
    .get();
}

interface Stamp {
  key: string;
  noteId: string;
  digest: string;
}
const previousFiles = new WeakMap<AppDatabase, Map<string, Stamp>>();
function fileStamp(app: AppDatabase, dir: string, name: string): string {
  return withVaultDirectory(app, dir, (base) => {
    const st = lstatSync(join(base, name), { bigint: true });
    if (!st.isFile() || st.nlink !== 1n) throw new AppError("UNSAFE_NOTE", 409);
    return [st.dev, st.ino, st.size, st.mtimeNs, st.ctimeNs].join("/");
  });
}

async function inventory(
  app: AppDatabase,
  cancelled: () => boolean,
  byteSlice = BYTE_SLICE,
) {
  const dirs = [""],
    paths = new Map<string, string | null>(),
    ids = new Map<string, string[]>();
  const cached = previousFiles.get(app) ?? new Map<string, Stamp>(),
    current = new Map<string, Stamp>();
  let count = 0,
    bytesRead = 0;
  while (dirs.length) {
    const dir = dirs.pop()!;
    const handle = withVaultDirectory(app, dir, (path) => opendirSync(path));
    try {
      let entry;
      while ((entry = handle.readSync())) {
        if (++count > MAX_INVENTORY_ENTRIES)
          throw new AppError("VAULT_SCAN_LIMIT", 409);
        if (count % 8 === 0) {
          await yieldLoop();
          if (cancelled()) throw new AppError("VAULT_PAUSED", 409);
        }
        if (entry.name.startsWith(".")) continue;
        const path = dir ? dir + "/" + entry.name : entry.name;
        if (!validVaultPath(path)) continue;
        if (entry.isDirectory()) {
          dirs.push(path);
          continue;
        }
        if (!entry.name.toLowerCase().endsWith(".md")) continue;
        paths.set(path, null);
        if (!entry.isFile()) continue;
        try {
          const key = fileStamp(app, dir, entry.name);
          let item = cached.get(path);
          if (!item || item.key !== key) {
            const bytes = readVaultFile(app, path);
            bytesRead += bytes.length;
            const { noteId } = parseMemoryMarkdown(bytes);
            if (key !== fileStamp(app, dir, entry.name)) continue;
            item = { key, noteId, digest: digest(bytes) };
          }
          current.set(path, item);
          const { noteId } = item;
          paths.set(path, noteId);
          const matches = ids.get(noteId);
          if (matches) matches.push(path);
          else ids.set(noteId, [path]);
        } catch {
          // Keep the path occupied. A malformed/replaced tracked file is a conflict, not a deletion.
        }
        if (bytesRead >= byteSlice) {
          bytesRead = 0;
          await yieldLoop();
          if (cancelled()) throw new AppError("VAULT_PAUSED", 409);
        }
      }
    } finally {
      handle.closeSync();
    }
  }
  previousFiles.set(app, current);
  return { paths, ids, current };
}

/** Duplicate IDs are positive evidence even when a note is temporarily excluded from normal reconciliation. */
export function holdDuplicateLineage(
  db: DatabaseSync,
  ids: ReadonlyMap<string, string[]>,
): void {
  const ambiguous = Array.from(ids)
    .filter(([, paths]) => paths.length > 1)
    .map(([note]) => note);
  if (!ambiguous.length) return;
  db.prepare(
    `UPDATE memory_lineage_work SET invalidated=1 WHERE mode='LEGACY' AND status='PENDING' AND invalidated=0
    AND candidate_id IN (SELECT d.candidate_id FROM json_each(?) seen JOIN memory_documents d ON d.note_id=seen.value)`,
  ).run(JSON.stringify(ambiguous));
}

/** Read the registered Vault once, with the same limits and yields as the watcher.
 * Backup holds the exclusive Host maintenance lock, which intentionally pauses normal scans. */
export async function inventoryForBackup(app: AppDatabase) {
  const maintained = () =>
    app.db
      .prepare(
        "SELECT maintenance,restored FROM app_operational_state WHERE singleton=1",
      )
      .get();
  const allowed = () => {
    const op = maintained();
    return op?.maintenance === 1 && op.restored === 0;
  };
  if (!allowed()) throw new AppError("MAINTENANCE_REQUIRED", 409);
  return inventory(app, () => !allowed());
}

function reconcile(
  app: AppDatabase,
  policy: AuthorizationPolicy,
  noteId: string,
  files: Awaited<ReturnType<typeof inventory>>,
) {
  const row = app.db
    .prepare("SELECT * FROM memory_documents WHERE note_id=?")
    .get(noteId) as unknown as DocumentRow;
  if (!row || terminal(row.state)) return;
  const resetObservation = () =>
    app.db
      .prepare("DELETE FROM memory_observations WHERE note_id=?")
      .run(noteId);
  try {
    assertDocumentSources(
      app,
      policy,
      { actorId: "", workspaceId: row.workspace_id },
      row,
    );
  } catch {
    resetObservation();
    setDocumentState(app, row, "NEEDS_REVIEW");
    return;
  }
  const matches = files.ids.get(noteId) ?? [];
  if (
    matches.length > 1 ||
    (files.paths.has(row.relative_path) &&
      files.paths.get(row.relative_path) !== noteId)
  ) {
    resetObservation();
    setDocumentState(app, row, "CONFLICT");
    return;
  }
  if (!matches.length) {
    resetObservation();
    // A rename/create can race directory enumeration. Never accept a new location from a partial read.
    try {
      readVaultFile(app, row.relative_path);
      setDocumentState(app, row, "DIRTY");
    } catch (e) {
      setDocumentState(
        app,
        row,
        (e as NodeJS.ErrnoException).code === "ENOENT" ? "DELETED" : "CONFLICT",
      );
    }
    return;
  }
  const path = matches[0];
  // Stable unchanged entries need no body reread. Ordinary reads still independently verify the live digest.
  if (
    row.state === "PUBLISHED" &&
    row.relative_path === path &&
    files.current.get(path)?.digest === row.digest
  )
    return;
  let bytes: Buffer, parsed: ReturnType<typeof parseMemoryMarkdown>;
  try {
    bytes = readVaultFile(app, path);
    parsed = parseMemoryMarkdown(bytes);
  } catch {
    resetObservation();
    setDocumentState(app, row, "DIRTY");
    return;
  }
  if (parsed.noteId !== row.note_id) {
    resetObservation();
    setDocumentState(app, row, "CONFLICT");
    return;
  }
  const fileDigest = digest(bytes);
  if (fileDigest === row.digest) {
    resetObservation();
    if (row.relative_path !== path || row.state !== "PUBLISHED")
      app.db
        .prepare(
          "UPDATE memory_documents SET state='PUBLISHED',relative_path=? WHERE note_id=?",
        )
        .run(path, noteId);
    return;
  }
  const old = parseMemoryMarkdown(readVersion(app, row.digest));
  if (!row.trusted || parsed.metadata !== old.metadata || !parsed.body.trim()) {
    resetObservation();
    setDocumentState(app, row, "CONFLICT");
    return;
  }
  const prior = app.db
    .prepare("SELECT * FROM memory_observations WHERE note_id=?")
    .get(noteId);
  const now = Date.now();
  if (prior?.relative_path !== path || prior?.digest !== fileDigest) {
    app.db
      .prepare("INSERT OR REPLACE INTO memory_observations VALUES(?,?,?,?)")
      .run(noteId, path, fileDigest, now);
    setDocumentState(app, row, "DIRTY");
    return;
  }
  if (now - Number(prior.first_seen_at) < MEMORY_SETTLE_MS) return;
  saveVersion(app, bytes);
  const version = row.version + 1,
    bodyDigest = digest(parsed.body);
  app.db
    .prepare(
      "INSERT INTO memory_versions(note_id,version,digest,body_digest,relative_path,created_at) VALUES(?,?,?,?,?,?)",
    )
    .run(noteId, version, fileDigest, bodyDigest, path, now);
  app.db
    .prepare(
      "UPDATE memory_documents SET version=?,digest=?,body_digest=?,relative_path=?,state='PUBLISHED' WHERE note_id=?",
    )
    .run(version, fileDigest, bodyDigest, path, noteId);
  resetObservation();
}

async function scan(
  app: AppDatabase,
  cancelled: () => boolean,
  byteSlice = BYTE_SLICE,
) {
  if (!running(app) || cancelled()) return { status: "PAUSED" };
  // Limit to rows already published when inventory starts, avoiding false deletions during concurrent publication.
  const documents = app.db
    .prepare(
      `SELECT note_id FROM memory_documents WHERE ${LIVE_NOTE_PREDICATE}
    ORDER BY note_id LIMIT ?`,
    )
    .all(MAX_LIVE_NOTES + 1);
  try {
    if (documents.length > MAX_LIVE_NOTES)
      throw new AppError("VAULT_SCAN_LIMIT", 409);
    const files = await inventory(
        app,
        () => cancelled() || !running(app),
        byteSlice,
      ),
      policy = new AuthorizationPolicy(app);
    if (running(app) && !cancelled())
      app.transaction(
        () => holdDuplicateLineage(app.db, files.ids),
        "memory_lineage_scan_conflicts",
      );
    for (let n = 0; n < documents.length; n++) {
      if (!running(app) || cancelled()) return { status: "PAUSED" };
      app.transaction(() => {
        if (running(app))
          reconcile(app, policy, String(documents[n].note_id), files);
      }, "memory_import");
      if ((n + 1) % 16 === 0) await yieldLoop();
    }
    if (running(app))
      app.transaction(() =>
        app.db
          .prepare(
            "UPDATE memory_scan_state SET incomplete=0 WHERE incomplete=1",
          )
          .run(),
      );
    return { status: "COMPLETE" };
  } catch (error) {
    if (cancelled() || !running(app)) return { status: "PAUSED" };
    app.transaction(() =>
      app.db
        .prepare("UPDATE memory_scan_state SET incomplete=1 WHERE incomplete=0")
        .run(),
    );
    if (error instanceof AppError && error.code === "VAULT_SCAN_LIMIT")
      return { status: "LIMIT_REACHED" };
    return { status: "SCAN_FAILED" };
  }
}

function requestScan(
  app: AppDatabase,
  cancelled: () => boolean,
  byteSlice = BYTE_SLICE,
) {
  const pending = active.get(app);
  if (pending) return pending;
  const work = scan(app, cancelled, byteSlice).finally(() =>
    active.delete(app),
  );
  active.set(app, work);
  return work;
}
export const scanVault = (app: AppDatabase, byteSlice = BYTE_SLICE) =>
  requestScan(app, () => false, integer(byteSlice, 1, BYTE_SLICE));

/** Watch events accelerate complete passes. The periodic scan repairs missed events and observes registration/resume. */
export function startVaultWatcher(app: AppDatabase): () => Promise<void> {
  let watcher: FSWatcher | undefined,
    timer: NodeJS.Timeout | undefined,
    stopped = false;
  const schedule = () => {
    if (stopped || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void tick().catch(() => {
        /* Periodic pass retries a temporarily unavailable DB/Vault. */
      });
    }, 200);
    timer.unref();
  };
  const tick = async () => {
    if (stopped) return;
    if (!running(app)) {
      watcher?.close();
      watcher = undefined;
      return;
    }
    if (!watcher) {
      try {
        // A non-recursive watcher only accelerates top-level changes; all nested paths are included by the scan.
        watcher = watch(vaultRoot(app), { persistent: false }, schedule);
        watcher.on("error", () => {
          watcher?.close();
          watcher = undefined;
        });
      } catch {
        /* Filesystem event support is optional. */
      }
    }
    await requestScan(app, () => stopped);
    if (
      !stopped &&
      app.db.prepare("SELECT 1 FROM memory_observations LIMIT 1").get() &&
      !timer
    ) {
      timer = setTimeout(() => {
        timer = undefined;
        schedule();
      }, MEMORY_SETTLE_MS);
      timer.unref();
    }
  };
  const periodic = setInterval(schedule, PERIOD_MS);
  periodic.unref();
  schedule();
  return async () => {
    stopped = true;
    clearInterval(periodic);
    if (timer) clearTimeout(timer);
    watcher?.close();
    await active.get(app);
  };
}

/** A Host registers a reviewed existing file. No write to the editable Vault or invention of conversation sources. */
export async function registerHandwrittenNote(
  app: AppDatabase,
  policy: AuthorizationPolicy,
  actor: Actor,
  input: unknown,
) {
  const v = object(input, [
    "roomId",
    "personaId",
    "scope",
    "noteId",
    "relativePath",
    "expectedDigest",
    "requestId",
    "trusted",
  ]);
  const roomId = string(v.roomId, 100),
    personaId = string(v.personaId, 100),
    visibility = string(v.scope, 50),
    noteId = string(v.noteId, 100),
    path = string(v.relativePath, 1024),
    fileDigest = string(v.expectedDigest, 64),
    requestId = string(v.requestId, 128),
    trusted = bool(v.trusted);
  if (
    !MEMORY_SCOPES.includes(visibility as (typeof MEMORY_SCOPES)[number]) ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(noteId) ||
    !validVaultPath(path) ||
    !path.toLowerCase().endsWith(".md") ||
    !/^[a-f0-9]{64}$/.test(fileDigest)
  )
    throw new AppError("INVALID_INPUT");
  const binding = digest(canonical(v));
  const receipt = {
    noteId,
    version: 1,
    digest: fileDigest,
    state: "PUBLISHED",
  };
  const required: [string, ResourceScope][] = [
    ["MANAGE_VAULT", {}],
    ["READ_ROOM", { roomId }],
  ];
  const scope = { roomId, personaId, visibility };
  for (const op of ["READ_MEMORY", "REVIEW_MEMORY", "PUBLISH_MEMORY"])
    required.push([op, scope]);
  if (visibility === "room_shared")
    required.push(["CHANGE_MEMORY_SCOPE", scope]);
  function check() {
    for (const [op, scope] of required) policy.assert(actor, op, scope);
    if (
      !app.db
        .prepare(
          `SELECT 1 FROM room_personas rp JOIN rooms r USING(workspace_id,room_id)
      JOIN personas p USING(workspace_id,persona_id) WHERE rp.workspace_id=? AND rp.room_id=? AND rp.persona_id=?
      AND r.deleted_at IS NULL AND p.deleted_at IS NULL`,
        )
        .get(actor.workspaceId, roomId, personaId)
    )
      throw new AppError("NOT_FOUND", 404);
    const prior = app.db
      .prepare(
        "SELECT request_digest FROM memory_handwritten WHERE workspace_id=? AND registrar_id=? AND request_id=?",
      )
      .get(actor.workspaceId, actor.actorId, requestId);
    if (prior && prior.request_digest !== binding)
      throw new AppError("REQUEST_CONFLICT", 409);
    return !!prior;
  }
  if (check()) return receipt;
  if (!running(app)) throw new AppError("VAULT_PAUSED", 409);
  const files = await inventory(app, () => !running(app));
  return app.transaction(() => {
    if (check()) return receipt;
    if (!running(app)) throw new AppError("VAULT_PAUSED", 409);
    const found = files.ids.get(noteId);
    if (
      found?.length !== 1 ||
      found[0] !== path ||
      app.db
        .prepare(
          "SELECT 1 FROM memory_candidates WHERE target_note_id=? UNION ALL SELECT 1 FROM memory_documents WHERE note_id=? OR relative_path=? LIMIT 1",
        )
        .get(noteId, noteId, path)
    )
      throw new AppError("REGISTRATION_CONFLICT", 409);
    assertPublicationCapacity(app);
    const bytes = readVaultFile(app, path),
      doc = parseMemoryMarkdown(bytes);
    if (
      digest(bytes) !== fileDigest ||
      doc.noteId !== noteId ||
      doc.operationId !== undefined ||
      doc.sourceRefs.length ||
      (doc.scopeHint !== undefined && doc.scopeHint !== visibility) ||
      !doc.body.trim() ||
      !MEMORY_KINDS.includes(doc.kind as (typeof MEMORY_KINDS)[number]) ||
      !ASSERTION_TYPES.includes(
        doc.assertionType as (typeof ASSERTION_TYPES)[number],
      )
    )
      throw new AppError("REGISTRATION_CONFLICT", 409);
    const now = Date.now(),
      bodyDigest = digest(doc.body);
    saveVersion(app, bytes);
    app.db
      .prepare(
        `INSERT INTO memory_documents(note_id,workspace_id,room_id,owner_persona_id,scope,candidate_id,state,
      relative_path,version,digest,body_digest,trusted) VALUES(?,?,?,?,?,NULL,'PUBLISHED',?,1,?,?,?)`,
      )
      .run(
        noteId,
        actor.workspaceId,
        roomId,
        personaId,
        visibility,
        path,
        fileDigest,
        bodyDigest,
        Number(trusted),
      );
    app.db
      .prepare(
        "INSERT INTO memory_versions(note_id,version,digest,body_digest,relative_path,created_at) VALUES(?,1,?,?,?,?)",
      )
      .run(noteId, fileDigest, bodyDigest, path, now);
    app.db
      .prepare("INSERT INTO memory_handwritten VALUES(?,?,?,?,?,?,?,?)")
      .run(
        noteId,
        actor.workspaceId,
        actor.actorId,
        requestId,
        binding,
        path,
        fileDigest,
        now,
      );
    for (const [op, grantScope] of required) {
      const grant = app.db
        .prepare(
          `SELECT grant_id FROM access_grants WHERE workspace_id=? AND actor_id=? AND operation=?
        AND revoked_at IS NULL AND (room_id='*' OR room_id=?) AND (persona_id='*' OR persona_id=?)
        AND (visibility='*' OR visibility=?) AND provider='*'
        ORDER BY (room_id<>'*')+(persona_id<>'*')+(visibility<>'*') DESC,grant_id LIMIT 1`,
        )
        .get(
          actor.workspaceId,
          actor.actorId,
          op,
          grantScope.roomId ?? "",
          grantScope.personaId ?? "",
          grantScope.visibility ?? "",
        );
      if (!grant) throw new AppError("FORBIDDEN", 403);
      app.db
        .prepare("INSERT INTO memory_handwritten_grants VALUES(?,?)")
        .run(noteId, grant.grant_id);
    }
    if (!readVaultFile(app, path).equals(bytes))
      throw new AppError("REGISTRATION_CONFLICT", 409);
    app.audit(
      actor.actorId,
      actor.workspaceId,
      "REGISTER_HANDWRITTEN_MEMORY",
      noteId,
    );
    return receipt;
  }, "memory_handwritten_register");
}
