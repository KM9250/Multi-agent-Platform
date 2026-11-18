import { DatabaseSync } from "node:sqlite";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { APP_CONTRACT, AppError } from "../../shared/app-contracts/index.ts";
import { id } from "./validation.ts";
import { STORAGE_SCHEMA } from "./schema.ts";
import { AUTH_SCHEMA } from "../auth/schema.ts";
import { GENERATION_SCHEMA } from "../generation/schema.ts";
import { OPERATIONS_SCHEMA } from "../operations/schema.ts";
export interface AppDatabaseOptions {
  root: string;
  path?: string;
  busyTimeoutMs?: number;
  hooks?: {
    beforeCommit?: (phase: string) => void;
    afterCommit?: (phase: string) => void;
  };
}
export function assertSafePath(path: string, kind: "directory" | "file"): void {
  if (!isAbsolute(path)) throw new AppError("INVALID_DATA_ROOT");
  const absolute = resolve(path);
  let current: string = sep;
  for (const part of absolute.split(sep).filter(Boolean)) {
    current = join(current, part);
    if (existsSync(current)) {
      const st = lstatSync(current);
      if (st.isSymbolicLink()) throw new AppError("UNSAFE_PATH");
      if (
        current === absolute &&
        ((kind === "directory" && !st.isDirectory()) ||
          (kind === "file" && (!st.isFile() || st.nlink !== 1)))
      )
        throw new AppError("UNSAFE_PATH");
    }
  }
}
export class AppDatabase {
  readonly db: DatabaseSync;
  readonly root: string;
  readonly path: string;
  readonly cursorKey: Buffer;
  readonly hooks: AppDatabaseOptions["hooks"];
  #depth = 0;
  #poisoned = false;
  #metrics = {
    transactionCount: 0,
    transactionMs: 0,
    transactionFailures: 0,
    commitAckUncertain: 0,
  };
  constructor(options: AppDatabaseOptions) {
    this.root = resolve(options.root);
    this.path = options.path ?? join(this.root, "app-data.sqlite");
    this.hooks = options.hooks;
    if (
      !isAbsolute(options.root) ||
      !isAbsolute(this.path) ||
      dirname(this.path) !== this.root ||
      /coordination/i.test(this.path)
    )
      throw new AppError("INVALID_DATA_ROOT");
    assertSafePath(this.root, "directory");
    assertSafePath(this.path, "file");
    const marker = join(this.root, ".app-bootstrap");
    const existing = existsSync(this.path);
    const recoverBootstrap = () => {
      try {
        assertSafePath(marker, "file");
        const meta = JSON.parse(readFileSync(marker, "utf8")),
          stat = lstatSync(this.path);
        return (
          meta.path === this.path &&
          meta.dev === stat.dev &&
          meta.ino === stat.ino &&
          meta.contract === APP_CONTRACT
        );
      } catch {
        return false;
      }
    };
    // Identification runs read-only before chmod, journal_mode or migration. Foreign DBs stay byte-identical.
    if (existsSync(this.path) && lstatSync(this.path).size > 0) {
      let probe: DatabaseSync | undefined;
      try {
        probe = new DatabaseSync(this.path, { readOnly: true });
        const tables = probe
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
          )
          .all();
        if (!tables.some((t) => t.name === "app_metadata")) {
          if (tables.length || !recoverBootstrap())
            throw new AppError("WRONG_DATABASE");
        } else {
          const meta = probe
            .prepare(
              "SELECT contract,schema_version FROM app_metadata WHERE singleton=1",
            )
            .get();
          if (
            !meta ||
            meta.contract !== APP_CONTRACT ||
            meta.schema_version !== 1
          )
            throw new AppError("WRONG_DATABASE");
        }
      } catch (e) {
        if (e instanceof AppError) throw e;
        throw new AppError("WRONG_DATABASE");
      } finally {
        probe?.close();
      }
    }
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32" && lstatSync(this.root).mode & 0o077)
      throw new AppError("DATA_ROOT_NOT_PRIVATE");
    for (const directory of ["attachments", "staging", "exports", "backups"]) {
      const path = join(this.root, directory);
      assertSafePath(path, "directory");
      mkdirSync(path, { recursive: true, mode: 0o700 });
      if (process.platform !== "win32" && lstatSync(path).mode & 0o077)
        throw new AppError("DATA_ROOT_NOT_PRIVATE");
    }
    if (existing && lstatSync(this.path).size === 0 && !recoverBootstrap())
      throw new AppError("WRONG_DATABASE");
    if (!existsSync(this.path)) {
      closeSync(openSync(this.path, "wx", 0o600));
      const stat = lstatSync(this.path);
      writeFileSync(
        marker,
        JSON.stringify({
          contract: APP_CONTRACT,
          path: this.path,
          dev: stat.dev,
          ino: stat.ino,
        }),
        { flag: "wx", mode: 0o600 },
      );
    }
    chmodSync(this.path, 0o600);
    this.db = new DatabaseSync(this.path);
    const timeout = options.busyTimeoutMs ?? 2000;
    if (!Number.isInteger(timeout) || timeout < 0 || timeout > 60000) {
      this.db.close();
      throw new AppError("INVALID_CONFIGURATION");
    }
    try {
      this.db.exec(
        `PRAGMA busy_timeout=${timeout}; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;`,
      );
      const exists = this.db
        .prepare("SELECT 1 FROM sqlite_master WHERE name='app_metadata'")
        .get();
      if (!exists) {
        this.db.exec("BEGIN IMMEDIATE");
        try {
          this.db.exec(
            `CREATE TABLE app_metadata(singleton INTEGER PRIMARY KEY CHECK(singleton=1),contract TEXT NOT NULL,schema_version INTEGER NOT NULL,cursor_key TEXT NOT NULL) STRICT; CREATE TABLE app_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at INTEGER NOT NULL) STRICT;`,
          );
          this.db.exec(AUTH_SCHEMA);
          this.db.exec(STORAGE_SCHEMA);
          this.db.exec(GENERATION_SCHEMA);
          this.db.exec(OPERATIONS_SCHEMA);
          this.db
            .prepare("INSERT INTO app_metadata VALUES(1,?,1,?)")
            .run(APP_CONTRACT, randomBytes(32).toString("hex"));
          this.db
            .prepare("INSERT INTO app_migrations VALUES(1,?,?)")
            .run("app_001_conversation_persistence", Date.now());
          this.hooks?.beforeCommit?.("migration");
          this.db.exec("COMMIT");
          this.hooks?.afterCommit?.("migration");
        } catch (e) {
          if (this.db.isTransaction) this.db.exec("ROLLBACK");
          throw e;
        }
      }
      if (existsSync(marker) && recoverBootstrap()) unlinkSync(marker);
      const violations = this.db.prepare("PRAGMA foreign_key_check").all();
      if (violations.length) throw new AppError("DATABASE_INTEGRITY");
      this.cursorKey = Buffer.from(
        String(
          this.db
            .prepare("SELECT cursor_key FROM app_metadata WHERE singleton=1")
            .get()!.cursor_key,
        ),
        "hex",
      );
    } catch (e) {
      this.db.close();
      throw e;
    }
  }
  transaction<T>(fn: () => T, phase = "write"): T {
    return this.#transaction(fn, phase, false);
  }
  maintenanceTransaction<T>(fn: () => T, phase = "maintenance"): T {
    return this.#transaction(fn, phase, true);
  }
  #transaction<T>(fn: () => T, phase: string, maintenance: boolean): T {
    if (this.#depth) {
      this.#depth++;
      try {
        const result = fn();
        if (result && typeof (result as any).then === "function")
          throw new AppError("ASYNC_TRANSACTION");
        return result;
      } catch (e) {
        this.#poisoned = true;
        throw e;
      } finally {
        this.#depth--;
      }
    }
    const started = performance.now();
    let committed = false;
    this.#metrics.transactionCount++;
    try {
      this.db.exec("BEGIN IMMEDIATE");
    } catch (error) {
      this.#metrics.transactionFailures++;
      this.#metrics.transactionMs += performance.now() - started;
      throw error;
    }
    this.#depth = 1;
    this.#poisoned = false;
    try {
      if (!maintenance) {
        const state = this.db
          .prepare(
            "SELECT maintenance FROM app_operational_state WHERE singleton=1",
          )
          .get();
        if (state?.maintenance === 1) throw new AppError("MAINTENANCE", 503);
      }
      const result = fn();
      if (result && typeof (result as any).then === "function")
        throw new AppError("ASYNC_TRANSACTION");
      if (this.#poisoned) throw new AppError("TRANSACTION_ABORTED", 409);
      this.hooks?.beforeCommit?.(phase);
      this.db.exec("COMMIT");
      committed = true;
      this.hooks?.afterCommit?.(phase);
      return result;
    } catch (e) {
      this.#metrics.transactionFailures++;
      if (committed) this.#metrics.commitAckUncertain++;
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw e;
    } finally {
      this.#depth = 0;
      this.#poisoned = false;
      this.#metrics.transactionMs += performance.now() - started;
    }
  }
  audit(
    actorId: string,
    workspaceId: string,
    action: string,
    targetId: string,
    code = "OK",
  ): void {
    this.db
      .prepare("INSERT INTO app_audit_events VALUES(?,?,?,?,?,?,?)")
      .run(id(), workspaceId, actorId, action, targetId, code, Date.now());
  }
  change(
    workspaceId: string,
    roomId: string | null,
    targetType: string,
    targetId: string,
    revision: number | null,
    action: string,
  ): void {
    this.db
      .prepare(
        "INSERT INTO app_changes(workspace_id,room_id,target_type,target_id,revision,action,created_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        workspaceId,
        roomId,
        targetType,
        targetId,
        revision,
        action,
        Date.now(),
      );
  }
  metrics(): Readonly<{
    transactionCount: number;
    transactionMs: number;
    transactionFailures: number;
    commitAckUncertain: number;
  }> {
    return Object.freeze({ ...this.#metrics });
  }
  close(): void {
    this.db.close();
  }
}
