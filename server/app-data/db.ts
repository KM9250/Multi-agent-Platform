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
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import {
  APP_CONTRACT,
  APP_SCHEMA,
  SEARCH_CONTRACT,
  MEMORY_CONTRACT,
  AppError,
} from "../../shared/app-contracts/index.ts";
import { id } from "./validation.ts";
import { STORAGE_SCHEMA } from "./schema.ts";
import { AUTH_SCHEMA } from "../auth/schema.ts";
import { GENERATION_SCHEMA } from "../generation/schema.ts";
import { OPERATIONS_SCHEMA } from "../operations/schema.ts";
import { MEMORY_SCHEMA_SQL } from "../memory/schema.ts";
import { LINEAGE_WORK_SCHEMA } from "../memory/lineage-work-schema.ts";
import { enqueueLegacyLineage } from "../memory/lineage-recovery.ts";
import { REVOCATION_SCHEMA } from "../auth/revocations.ts";
import { memoryRecordsDigest } from "../operations/memory-ledger.ts";

import { SEARCH_PROFILE_SCHEMA } from "../search/profile-schema.ts";

const METADATA_SCHEMA = `CREATE TABLE app_metadata(singleton INTEGER PRIMARY KEY CHECK(singleton=1),contract TEXT NOT NULL,schema_version INTEGER NOT NULL,cursor_key TEXT NOT NULL) STRICT; CREATE TABLE app_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at INTEGER NOT NULL) STRICT;`;
const FEATURE_SCHEMA = `CREATE TABLE app_feature_contracts(contract TEXT PRIMARY KEY) STRICT;`;
const migrations = [
  "app_001_conversation_persistence",
  "app_002_memory_vault",
  "app_003_memory_integrity",
  "app_004_resumable_memory_lineage",
  "app_005_search_control",
] as const;
const definitions = [
  [
    METADATA_SCHEMA,
    AUTH_SCHEMA,
    STORAGE_SCHEMA,
    GENERATION_SCHEMA,
    OPERATIONS_SCHEMA,
  ].join("\n"),
  [FEATURE_SCHEMA, MEMORY_SCHEMA_SQL].join("\n"),
  `CREATE INDEX memory_receipt_source ON app_generation_receipts(workspace_id,room_id,message_id,revision)
     WHERE message_id IS NOT NULL;
   CREATE INDEX memory_acl_revocations ON app_changes(workspace_id,target_id,revision)
     WHERE target_type='ACL' AND action='REVOKE';
   CREATE TABLE app_restore_migration_receipt(
     singleton INTEGER PRIMARY KEY CHECK(singleton=1),before_digest TEXT NOT NULL,after_digest TEXT NOT NULL
   ) STRICT;`,
  [
    REVOCATION_SCHEMA,
    LINEAGE_WORK_SCHEMA,
    `
    CREATE TABLE app_restore_lineage_migration(
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), source_schema INTEGER NOT NULL CHECK(source_schema IN (2,3)),
      before_digest TEXT NOT NULL, after_digest TEXT NOT NULL
    ) STRICT;
    CREATE TABLE memory_backup_observed_files(
      note_id TEXT PRIMARY KEY REFERENCES memory_documents(note_id),
      version INTEGER NOT NULL, digest TEXT NOT NULL, relative_path TEXT NOT NULL
    ) STRICT;`,
  ].join("\n"),
  SEARCH_PROFILE_SCHEMA,
];
function schemaObjects(db: DatabaseSync): string {
  return JSON.stringify(
    db
      .prepare(
        "SELECT type,name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name",
      )
      .all(),
  );
}
// Build the canonical catalogue using the same SQLite version as the database
// reader. Only released migration SQL participates in identification.
const knownCatalogues = new Map<number, string>();
function expectedCatalogue(version: number): string {
  let catalogue = knownCatalogues.get(version);
  if (!catalogue) {
    const reference = new DatabaseSync(":memory:");
    try {
      for (const sql of definitions.slice(0, version)) reference.exec(sql);
      catalogue = schemaObjects(reference);
      knownCatalogues.set(version, catalogue);
    } finally {
      reference.close();
    }
  }
  return catalogue;
}
export function identifyAppSchema(db: DatabaseSync): 1 | 2 | 3 | 4 | 5 {
  try {
    const meta = db
      .prepare(
        "SELECT contract,schema_version FROM app_metadata WHERE singleton=1",
      )
      .get();
    const version = meta?.schema_version;
    if (
      meta?.contract !== APP_CONTRACT ||
      (version !== 1 &&
        version !== 2 &&
        version !== 3 &&
        version !== 4 &&
        version !== 5)
    )
      throw new AppError("WRONG_DATABASE");
    const ledger = db
      .prepare("SELECT version,name FROM app_migrations ORDER BY version")
      .all();
    if (
      ledger.length !== version ||
      ledger.some(
        (row, i) => row.version !== i + 1 || row.name !== migrations[i],
      ) ||
      schemaObjects(db) !== expectedCatalogue(version)
    )
      throw new AppError("WRONG_DATABASE");
    if (version >= 2) {
      const contracts = db
        .prepare("SELECT contract FROM app_feature_contracts")
        .all();
      const expected =
        version >= 5 ? [MEMORY_CONTRACT, SEARCH_CONTRACT] : [MEMORY_CONTRACT];
      if (
        contracts.length !== expected.length ||
        !expected.every((contract) =>
          contracts.some((row) => row.contract === contract),
        )
      )
        throw new AppError("WRONG_DATABASE");
    }
    return version;
  } catch {
    throw new AppError("WRONG_DATABASE");
  }
}

/** Old detached restores discarded the evidence of first file exposure. */
function fenceOldRestoredJobs(db: DatabaseSync): void {
  db.exec(`UPDATE memory_candidates SET state='CONFLICT'
    WHERE state IN ('APPROVED','PUBLISHING','FAILED') AND candidate_id IN
      (SELECT candidate_id FROM memory_jobs WHERE status IN ('PENDING','PUBLISHING','FAILED'));
    UPDATE memory_jobs SET status='CONFLICT',error_code='RESTORE_PUBLICATION_UNCERTAIN'
    WHERE status IN ('PENDING','PUBLISHING','FAILED');`);
}

export interface AppDatabaseOptions {
  root: string;
  path?: string;
  readOnly?: boolean;
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
    const st = lstatSync(current, { throwIfNoEntry: false });
    if (st) {
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
function readCursorKey(db: DatabaseSync): Buffer {
  const key = db
    .prepare("SELECT cursor_key FROM app_metadata WHERE singleton=1")
    .get()!.cursor_key;
  return Buffer.from(String(key), "hex");
}

export class AppDatabase {
  readonly db: DatabaseSync;
  readonly root: string;
  readonly path: string;
  readonly cursorKey: Buffer;
  readonly #readOnly: boolean;
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
    this.#readOnly = options.readOnly === true;
    if (
      !isAbsolute(options.root) ||
      !isAbsolute(this.path) ||
      dirname(this.path) !== this.root ||
      /coordination/i.test(this.path)
    )
      throw new AppError("INVALID_DATA_ROOT");
    assertSafePath(this.root, "directory");
    assertSafePath(this.path, "file");
    const timeout = options.busyTimeoutMs ?? 2000;
    if (!Number.isInteger(timeout) || timeout < 0 || timeout > 60000)
      throw new AppError("INVALID_CONFIGURATION");
    if (options.readOnly) {
      // Search workers can inspect an existing installation, never bootstrap or upgrade it.
      if (!existsSync(this.path)) throw new AppError("WRONG_DATABASE");
      if (
        process.platform !== "win32" &&
        (lstatSync(this.root).mode & 0o077 || lstatSync(this.path).mode & 0o077)
      )
        throw new AppError("DATA_ROOT_NOT_PRIVATE");
      for (const suffix of ["-wal", "-shm", "-journal"])
        assertSafePath(this.path + suffix, "file");
      this.db = new DatabaseSync(this.path, { readOnly: true });
      try {
        this.db.exec(
          `PRAGMA query_only=ON; PRAGMA busy_timeout=${timeout}; BEGIN`,
        );
        if (identifyAppSchema(this.db) !== APP_SCHEMA)
          throw new AppError("WRONG_DATABASE");
        this.cursorKey = readCursorKey(this.db);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.close();
        throw error;
      }
      return;
    }
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
    if (existing && lstatSync(this.path).size === 0 && !recoverBootstrap())
      throw new AppError("WRONG_DATABASE");
    // Identification runs read-only before chmod, journal_mode or migration. Foreign DBs stay byte-identical.
    if (existsSync(this.path) && lstatSync(this.path).size > 0) {
      let probe: DatabaseSync | undefined;
      try {
        probe = new DatabaseSync(this.path, { readOnly: true });
        probe.exec("BEGIN");
        const tables = probe
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
          )
          .all();
        if (!tables.some((t) => t.name === "app_metadata")) {
          if (tables.length || !recoverBootstrap())
            throw new AppError("WRONG_DATABASE");
        } else {
          identifyAppSchema(probe);
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
    try {
      this.db.exec(
        `PRAGMA busy_timeout=${timeout}; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;`,
      );
      // Re-read the version after acquiring the SQLite write lock. Independent
      // startup processes may have finished a migration since the probe.
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const exists = this.db
          .prepare("SELECT 1 FROM sqlite_schema WHERE name='app_metadata'")
          .get();
        if (!exists) {
          this.db.exec(definitions[0]);
          this.db
            .prepare("INSERT INTO app_metadata VALUES(1,?,1,?)")
            .run(APP_CONTRACT, randomBytes(32).toString("hex"));
          this.db
            .prepare("INSERT INTO app_migrations VALUES(1,?,?)")
            .run(migrations[0], Date.now());
          this.hooks?.beforeCommit?.("migration");
        }
        this.db.exec("COMMIT");
        if (!exists) this.hooks?.afterCommit?.("migration");
        for (;;) {
          this.db.exec("BEGIN IMMEDIATE");
          const version = identifyAppSchema(this.db);
          if (version === APP_SCHEMA) {
            this.db.exec("COMMIT");
            break;
          }
          const record = (next: 2 | 3 | 4 | 5) => {
            this.db
              .prepare("INSERT INTO app_migrations VALUES(?,?,?)")
              .run(next, migrations[next - 1], Date.now());
            this.db
              .prepare(
                "UPDATE app_metadata SET schema_version=? WHERE singleton=1",
              )
              .run(next);
            this.hooks?.beforeCommit?.(migrations[next - 1]);
          };
          if (version === 1) {
            this.db.exec(definitions[1]);
            this.db
              .prepare("INSERT INTO app_feature_contracts VALUES(?)")
              .run(MEMORY_CONTRACT);
            record(2);
            this.db.exec("COMMIT");
            this.hooks?.afterCommit?.(migrations[1]);
            continue;
          }
          if (version === 4) {
            this.db.exec(definitions[4]);
            this.db
              .prepare("INSERT INTO app_feature_contracts VALUES(?)")
              .run(SEARCH_CONTRACT);
            record(5);
            this.db.exec("COMMIT");
            this.hooks?.afterCommit?.(migrations[4]);
            continue;
          }
          // A direct upgrade retains the original schema-2 state and never exposes an
          // intermediate schema-3 catalogue without its required source validation.
          const pausedRestore =
            this.db
              .prepare(
                "SELECT restored FROM app_operational_state WHERE singleton=1",
              )
              .get()?.restored === 1;
          const before = pausedRestore
            ? memoryRecordsDigest(this.db)
            : undefined;
          if (version === 2) {
            this.db.exec(definitions[2]);
            if (
              pausedRestore ||
              existsSync(join(this.root, "restore-report.json"))
            ) {
              fenceOldRestoredJobs(this.db);
            }
            record(3);
          }
          this.db.exec(definitions[3]);
          enqueueLegacyLineage(this.db, version);
          if (before !== undefined) {
            this.db
              .prepare(
                "INSERT INTO app_restore_lineage_migration VALUES(1,?,?,?)",
              )
              .run(version, before, memoryRecordsDigest(this.db));
          }
          record(4);
          this.db.exec("COMMIT");
          if (version === 2) this.hooks?.afterCommit?.(migrations[2]);
          this.hooks?.afterCommit?.(migrations[3]);
        }
      } catch (e) {
        if (this.db.isTransaction) this.db.exec("ROLLBACK");
        throw e;
      }
      if (existsSync(marker) && recoverBootstrap()) unlinkSync(marker);
      const violations = this.db.prepare("PRAGMA foreign_key_check").all();
      if (violations.length) throw new AppError("DATABASE_INTEGRITY");
      this.cursorKey = readCursorKey(this.db);
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
      // A read-only worker uses the canonical readNote transaction. SQLite query_only
      // still rejects writes, including any live-file change that would mark a note dirty.
      this.db.exec(this.#readOnly ? "BEGIN DEFERRED" : "BEGIN IMMEDIATE");
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
