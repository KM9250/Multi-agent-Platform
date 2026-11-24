import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { AppError } from "../../shared/app-contracts/index.ts";
import { assertSafePath, type AppDatabase } from "../app-data/db.ts";
import { AuthorizationPolicy, type Actor } from "../auth/authorization.ts";

export interface IndexBinding {
  workspaceId: string;
  actorId: string;
  roomId: string;
}
export interface IndexJob {
  binding: IndexBinding;
  root: string;
  appPath: string;
  jobId: string;
  rebuild: boolean;
  external: boolean;
  rollback?: string;
}
export const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function generationPath(dir: string, generationId: string) {
  if (!uuid.test(generationId)) throw new AppError("INVALID_GENERATION");
  return join(dir, generationId + ".sqlite");
}

export function assertAvailable(
  app: AppDatabase,
  policy: AuthorizationPolicy,
  actor: Actor,
  roomId: string,
) {
  policy.assert(actor, "READ_ROOM", { roomId });
  if (
    !app.db
      .prepare(
        "SELECT 1 FROM rooms WHERE workspace_id=? AND room_id=? AND deleted_at IS NULL",
      )
      .get(actor.workspaceId, roomId)
  )
    throw new AppError("ROOM_NOT_FOUND", 404);
  const state = app.db
    .prepare(
      "SELECT maintenance,restored FROM app_operational_state WHERE singleton=1",
    )
    .get();
  if (state?.maintenance !== 0 || state.restored !== 0)
    throw new AppError("MAINTENANCE", 503);
  return policy.revision(actor);
}

function protectDirectory(path: string, create: boolean) {
  assertSafePath(path, "directory");
  if (!existsSync(path)) {
    if (!create) return;
    mkdirSync(path, { mode: 0o700 });
  }
  if (lstatSync(path).mode & 0o077)
    throw new AppError("SEARCH_ROOT_NOT_PRIVATE");
}
export function indexDirectory(
  root: string,
  binding: IndexBinding,
  create = false,
) {
  const base = join(root, "search-index");
  protectDirectory(base, create);
  const dir = join(
    base,
    hash(
      JSON.stringify([binding.workspaceId, binding.actorId, binding.roomId]),
    ),
  );
  protectDirectory(dir, create);
  return dir;
}
export function protectDatabase(path: string) {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const name = path + suffix;
    assertSafePath(name, "file");
    const stat = lstatSync(name, { throwIfNoEntry: false });
    if (stat && stat.mode & 0o077)
      throw new AppError("SEARCH_INDEX_NOT_PRIVATE");
  }
}
const registrySchema = `
  CREATE TABLE control(singleton INTEGER PRIMARY KEY CHECK(singleton=1),paused INTEGER NOT NULL) STRICT;
  INSERT INTO control VALUES (1,0);
  CREATE TABLE generations(
    id TEXT PRIMARY KEY, state TEXT NOT NULL CHECK(state IN
      ('BUILDING','VALIDATING','READY','ACTIVE','RETIRED','FAILED','INTERRUPTED','INVALIDATED')),
    manifest TEXT NOT NULL, created INTEGER NOT NULL, synced INTEGER, reason TEXT
  ) STRICT;
  CREATE UNIQUE INDEX one_active ON generations(state) WHERE state='ACTIVE';
  CREATE TABLE jobs(id TEXT PRIMARY KEY,requester TEXT NOT NULL,generation TEXT,
    state TEXT NOT NULL,created INTEGER NOT NULL,finished INTEGER,reason TEXT) STRICT;
`;
export function openRegistry(dir: string, create = false): DatabaseSync | null {
  const path = join(dir, "generations.sqlite");
  protectDatabase(path);
  const initialize = !existsSync(path);
  if (initialize && !create) return null;
  if (initialize) closeSync(openSync(path, "wx", 0o600));
  const db = new DatabaseSync(path, { readOnly: !create });
  try {
    db.exec("PRAGMA busy_timeout=1000");
    if (initialize) {
      db.exec(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE",
      );
      db.exec(registrySchema);
      db.exec("COMMIT");
    }
    if (!db.prepare("SELECT 1 FROM control WHERE singleton=1").get())
      throw new AppError("SEARCH_CATALOG_INVALID");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
export function inRegistryTransaction<T>(db: DatabaseSync, fn: () => T) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}
export function failJob(
  db: DatabaseSync,
  id: string,
  reason: string,
  interrupted: boolean,
) {
  const state = interrupted ? "INTERRUPTED" : "FAILED";
  inRegistryTransaction(db, () => {
    db.prepare(
      `UPDATE generations SET state=?, reason=? WHERE state IN ('BUILDING','VALIDATING','READY')
      AND id=(SELECT generation FROM jobs WHERE id=?)`,
    ).run(state, reason, id);
    db.prepare(
      "UPDATE jobs SET state=?,reason=?,finished=? WHERE id=? AND state IN ('QUEUED','RUNNING')",
    ).run(state, reason, Date.now(), id);
  });
}
export function errorCode(error: unknown) {
  const code = (error as { code?: string })?.code;
  return typeof code === "string" && /^[A-Z_0-9]+$/.test(code)
    ? code
    : "SEARCH_INDEX_FAILED";
}
