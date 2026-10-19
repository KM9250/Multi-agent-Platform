import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue, SQLOutputValue } from 'node:sqlite';
import { closeSync, chmodSync, existsSync, lstatSync, mkdirSync, openSync, statSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { DurableStoreError, guarded, requireIntegrity } from './integrity';
import { migrate } from './migrations';

export type Row = Record<string, SQLOutputValue>;
export interface DurableTransaction {
  get(sql: string, ...params: SQLInputValue[]): Row | undefined;
  all(sql: string, ...params: SQLInputValue[]): Row[];
  run(sql: string, ...params: SQLInputValue[]): void;
}
export interface DurableDatabaseOptions { path: string; busyTimeoutMs?: number }

function protectPath(path: string): void {
  if (!isAbsolute(path)) throw new DurableStoreError('INVALID_CONFIGURATION');
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32' && (statSync(parent).mode & 0o077) !== 0) throw new DurableStoreError('INVALID_CONFIGURATION');
  if (!existsSync(path)) closeSync(openSync(path, 'wx', 0o600));
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new DurableStoreError('INVALID_CONFIGURATION');
  chmodSync(path, 0o600);
}

/** One synchronous transaction owner. SQLite serializes writers across connections. */
export class DurableDatabase {
  private readonly db: DatabaseSync;
  private active?: DurableTransaction;
  private writable = false;
  private closed = false;
  constructor(options: DurableDatabaseOptions) {
    const timeout = options.busyTimeoutMs ?? 5000;
    if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 60000) throw new DurableStoreError('INVALID_CONFIGURATION');
    this.db = guarded('DATABASE_ERROR', () => { protectPath(options.path); return new DatabaseSync(options.path); });
    try {
      this.db.exec(`PRAGMA busy_timeout=${timeout}; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;`);
      requireIntegrity(this.db.prepare('PRAGMA journal_mode').get()!.journal_mode === 'wal');
      requireIntegrity(this.db.prepare('PRAGMA synchronous').get()!.synchronous === 2);
      requireIntegrity(this.db.prepare('PRAGMA foreign_keys').get()!.foreign_keys === 1);
      requireIntegrity(this.db.prepare('PRAGMA busy_timeout').get()!.timeout === timeout);
      this.db.exec('BEGIN IMMEDIATE');
      try { migrate(this.db); this.db.exec('COMMIT'); }
      catch (error) { this.db.exec('ROLLBACK'); throw error; }
      requireIntegrity(this.db.prepare('PRAGMA quick_check').all().every(row => row.quick_check === 'ok'));
      requireIntegrity(this.db.prepare('PRAGMA foreign_key_check').all().every(row => row.table === 'workflow_checkpoints'));
    } catch (error) { this.db.close(); throw this.safeError(error); }
  }
  private safeError(error: unknown): DurableStoreError {
    if (error instanceof DurableStoreError) return error;
    const errno = (error as { errcode?: number })?.errcode;
    return new DurableStoreError(errno !== undefined && [5, 6].includes(errno & 255) ? 'DATABASE_BUSY' : 'DATABASE_ERROR');
  }
  assertTransaction(tx: DurableTransaction, write = false): void {
    if (this.closed || this.active !== tx || (write && !this.writable)) throw new DurableStoreError('INVALID_TRANSACTION');
  }
  private transaction<T>(write: boolean, fn: (tx: DurableTransaction) => T): T {
    if (this.closed || this.active) throw new DurableStoreError('INVALID_TRANSACTION');
    const check = (sql: string, mutation: boolean) => {
      this.assertTransaction(tx, mutation);
      // No transaction/DDL/PRAGMA control escapes to participants.
      if (!(mutation ? /^(INSERT|UPDATE|DELETE)\s/i : /^SELECT\s/i).test(sql.trim())) throw new DurableStoreError('INVALID_TRANSACTION');
    };
    const tx: DurableTransaction = {
      get: (sql, ...params) => { check(sql, false); return this.db.prepare(sql).get(...params); },
      all: (sql, ...params) => { check(sql, false); return this.db.prepare(sql).all(...params); },
      run: (sql, ...params) => { check(sql, true); this.db.prepare(sql).run(...params); },
    };
    let begun = false;
    try {
      this.db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN'); begun = true;
      this.active = tx; this.writable = write;
      const result = fn(tx);
      if (result && typeof (result as { then?: unknown }).then === 'function') throw new DurableStoreError('INVALID_TRANSACTION');
      this.db.exec('COMMIT'); begun = false;
      return result;
    } catch (error) {
      if (begun) {
        try { this.db.exec('ROLLBACK'); }
        catch { this.db.close(); this.closed = true; }
      }
      throw this.safeError(error);
    } finally { this.active = undefined; this.writable = false; }
  }
  read<T>(fn: (tx: DurableTransaction) => T): T { return this.transaction(false, fn); }
  write<T>(fn: (tx: DurableTransaction) => T): T { return this.transaction(true, fn); }
  /** Consistent SQLite backup (includes committed WAL data); trusted, new target only. */
  backup(path: string): void {
    if (this.closed || this.active) throw new DurableStoreError('INVALID_TRANSACTION');
    guarded('DATABASE_ERROR', () => {
      if (existsSync(path)) throw new DurableStoreError('INVALID_CONFIGURATION');
      protectPath(path);
      this.db.prepare('VACUUM INTO ?').run(path);
    });
  }
  close(): void {
    if (this.active) throw new DurableStoreError('INVALID_TRANSACTION');
    if (!this.closed) { guarded('DATABASE_ERROR', () => this.db.close()); this.closed = true; }
  }
}
