import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { DATABASE_NOW_SQL } from './leaseSchema';
import { DEFAULT_HEARTBEAT_INTERVAL_MS, DEFAULT_LEASE_TTL_MS, runtimeInstanceId } from './runtimeLease';
import type { LeaseInspection, RuntimeLeaseManager, RuntimeLeaseOptions, WorkflowLease } from './runtimeLease';
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

interface LeaseRecord {
  handle: WorkflowLease; capabilityHash: string; valid: boolean;
  expiresAt: number; wall: number; monotonic: number;
}
// Neither a serialized DTO nor knowledge of owner/generation can populate this registry.
const leaseHandles = new WeakMap<WorkflowLease, LeaseRecord>();
type WriteContext = { kind: 'lease'; record: LeaseRecord }
  | { kind: 'management'; workflowRunId: string }
  | { kind: 'bootstrap'; workflowRunId: string; seed: boolean; journal: boolean; audit: boolean };

/** One synchronous transaction owner. SQLite serializes writers across connections. */
export class DurableDatabase {
  #db: DatabaseSync;
  #context?: WriteContext;
  #fencingRejected = false;
  #active?: DurableTransaction;
  #writable = false;
  #closed = false;
  constructor(options: DurableDatabaseOptions) {
    const timeout = options.busyTimeoutMs ?? 5000;
    if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 60000) throw new DurableStoreError('INVALID_CONFIGURATION');
    this.#db = guarded('DATABASE_ERROR', () => { protectPath(options.path); return new DatabaseSync(options.path); });
    try {
      this.#db.exec(`PRAGMA busy_timeout=${timeout}; PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;`);
      requireIntegrity(this.#db.prepare('PRAGMA journal_mode').get()!.journal_mode === 'wal');
      requireIntegrity(this.#db.prepare('PRAGMA synchronous').get()!.synchronous === 2);
      requireIntegrity(this.#db.prepare('PRAGMA foreign_keys').get()!.foreign_keys === 1);
      requireIntegrity(this.#db.prepare('PRAGMA recursive_triggers').get()!.recursive_triggers === 1);
      requireIntegrity(this.#db.prepare('PRAGMA busy_timeout').get()!.timeout === timeout);
      this.#registerFencingFunctions();
      this.#db.exec('BEGIN IMMEDIATE');
      try { migrate(this.#db); this.#db.exec('COMMIT'); }
      catch (error) { this.#db.exec('ROLLBACK'); throw error; }
      requireIntegrity(this.#db.prepare('PRAGMA quick_check').all().every(row => row.quick_check === 'ok'));
      requireIntegrity(this.#db.prepare('PRAGMA foreign_key_check').all().every(row => row.table === 'workflow_checkpoints'));
    } catch (error) { this.#db.close(); throw this.safeError(error); }
  }
  private safeError(error: unknown): DurableStoreError {
    if (error instanceof DurableStoreError) return error;
    if ((error as { message?: string })?.message === 'LEASE_FENCED') return new DurableStoreError('LEASE_FENCED');
    const errno = (error as { errcode?: number })?.errcode;
    return new DurableStoreError(errno !== undefined && [5, 6].includes(errno & 255) ? 'DATABASE_BUSY' : 'DATABASE_ERROR');
  }
  assertTransaction(tx: DurableTransaction, write = false): void {
    if (this.#closed || this.#active !== tx || (write && !this.#writable)) throw new DurableStoreError('INVALID_TRANSACTION');
  }
  #transaction<T>(write: boolean, fn: (tx: DurableTransaction) => T, context?: WriteContext): T {
    if (this.#closed || this.#active) throw new DurableStoreError('INVALID_TRANSACTION');
    const check = (sql: string, mutation: boolean) => {
      this.assertTransaction(tx, mutation);
      // No transaction/DDL/PRAGMA control escapes to participants.
      if (!(mutation ? /^(INSERT|UPDATE|DELETE)\s/i : /^SELECT\s/i).test(sql.trim())) throw new DurableStoreError('INVALID_TRANSACTION');
    };
    const tx: DurableTransaction = {
      get: (sql, ...params) => { check(sql, false); return this.#db.prepare(sql).get(...params); },
      all: (sql, ...params) => { check(sql, false); return this.#db.prepare(sql).all(...params); },
      run: (sql, ...params) => {
        check(sql, true);
        try { this.#db.prepare(sql).run(...params); }
        catch (error) {
          const safe = this.safeError(error);
          if (safe.code === 'LEASE_FENCED') this.#fencingRejected = true;
          throw safe;
        }
      },
    };
    let begun = false;
    try {
      this.#db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN'); begun = true;
      this.#active = tx; this.#writable = write; this.#context = context; this.#fencingRejected = false;
      if (context?.kind === 'lease') this.#assertLease(context.record);
      const result = fn(tx);
      if (result && typeof (result as { then?: unknown }).then === 'function') throw new DurableStoreError('INVALID_TRANSACTION');
      if (this.#fencingRejected) throw new DurableStoreError('LEASE_FENCED');
      if (context?.kind === 'lease') this.#assertLease(context.record);
      if (context?.kind === 'bootstrap' && !(context.seed && context.journal && context.audit)) throw new DurableStoreError('LEASE_FENCED');
      this.#db.exec('COMMIT'); begun = false;
      return result;
    } catch (error) {
      if (begun) {
        try { this.#db.exec('ROLLBACK'); }
        catch { this.#db.close(); this.#closed = true; }
      }
      throw this.safeError(error);
    } finally { this.#active = undefined; this.#writable = false; this.#context = undefined; this.#fencingRejected = false; }
  }
  read<T>(fn: (tx: DurableTransaction) => T): T { return this.#transaction(false, fn); }
  write<T>(fn: (tx: DurableTransaction) => T): T { return this.#transaction(true, fn); }
  assertWorkflowWrite(tx: DurableTransaction, workflowRunId: string): void {
    this.assertTransaction(tx, true);
    const context = this.#context;
    if (context?.kind !== 'lease' || context.record.handle.workflowRunId !== workflowRunId) this.#fenced();
    this.#assertLease(context.record);
  }
  /** Explicit scope, checked at entry, every SQL mutation (triggers), and before COMMIT. */
  writeWithLease<T>(lease: WorkflowLease | undefined, workflowRunId: string, fn: (tx: DurableTransaction) => T): T {
    const record = lease && leaseHandles.get(lease);
    if (!record?.valid || lease!.workflowRunId !== workflowRunId) this.#fenced();
    try { return this.#transaction(true, fn, { kind: 'lease', record }); }
    catch (error) {
      if (error instanceof DurableStoreError && ['LEASE_FENCED','DATABASE_BUSY'].includes(error.code)) record.valid = false;
      throw error;
    }
  }
  /** Only a never-created workflow, one seed, one creation event and its trigger-owned audit. */
  bootstrapWorkflow<T>(workflowRunId: string, fn: (tx: DurableTransaction) => T): T {
    return this.#transaction(true, tx => {
      if (tx.get('SELECT workflow_run_id FROM workflow_seeds WHERE workflow_run_id = ?', workflowRunId)) throw new DurableStoreError('WORKFLOW_EXISTS');
      return fn(tx);
    }, { kind: 'bootstrap', workflowRunId, seed: false, journal: false, audit: false });
  }
  #fenced(): never {
    if (this.#active) this.#fencingRejected = true;
    throw new DurableStoreError('LEASE_FENCED');
  }
  #now(): number { return Number(this.#db.prepare(`SELECT ${DATABASE_NOW_SQL} AS now`).get()!.now); }
  #clockValid(record: LeaseRecord, now: number): boolean {
    const monotonic = performance.now();
    const drift = (now - record.wall) - (monotonic - record.monotonic);
    if (!Number.isSafeInteger(now) || now < 0 || Math.abs(drift) > 2000 || now < record.wall - 1000) {
      record.valid = false; return false;
    }
    record.wall = now; record.monotonic = monotonic;
    return true;
  }
  #matches(record: LeaseRecord, row: Row | undefined, now: number): boolean {
    const handle = record.handle;
    return record.valid && this.#clockValid(record, now) && !!row
      && row.workflow_run_id === handle.workflowRunId && row.owner_instance_id === handle.runtimeInstanceId
      && row.generation === handle.generation && row.lease_capability_hash === record.capabilityHash
      && row.lease_state === 'ACTIVE' && Number(row.expires_at) > now;
  }
  #assertLease(record: LeaseRecord): void {
    if (!this.#matches(record, this.#db.prepare('SELECT * FROM runtime_leases WHERE workflow_run_id = ?').get(record.handle.workflowRunId), this.#now())) {
      record.valid = false; this.#fenced();
    }
  }
  #registerFencingFunctions(): void {
    // Default directOnly=false permits trigger calls. No SQL function sets context.
    this.#db.function('map_fence_valid', (workflow, owner, generation, hash, state, expiry, now) => {
      const context = this.#context;
      if (context?.kind !== 'lease') return 0;
      return this.#matches(context.record, { workflow_run_id: workflow, owner_instance_id: owner,
        generation, lease_capability_hash: hash, lease_state: state, expires_at: expiry }, Number(now)) ? 1 : 0;
    });
    this.#db.function('map_runtime_id', () => this.#context?.kind === 'lease' ? this.#context.record.handle.runtimeInstanceId : null);
    this.#db.function('map_runtime_generation', () => this.#context?.kind === 'lease' ? this.#context.record.handle.generation : null);
    this.#db.function('map_lease_change', workflow => this.#context?.kind === 'management' && this.#context.workflowRunId === workflow ? 1 : 0);
    this.#db.function('map_bootstrap', (workflow, kind) => {
      const context = this.#context;
      if (context?.kind !== 'bootstrap' || context.workflowRunId !== workflow) return 0;
      if (kind === 'SEED' && !context.seed) { context.seed = true; return 1; }
      if (kind === 'JOURNAL' && context.seed && !context.journal) { context.journal = true; return 1; }
      if (kind === 'AUDIT' && context.journal && !context.audit) { context.audit = true; return 1; }
      return 0;
    });
  }
  createLeaseManager(options: RuntimeLeaseOptions = {}): RuntimeLeaseManager {
    const ttl = options.ttlMs ?? DEFAULT_LEASE_TTL_MS;
    const interval = options.heartbeatIntervalMs ?? Math.min(DEFAULT_HEARTBEAT_INTERVAL_MS, Math.max(1, Math.floor(ttl / 6)));
    if (!Number.isSafeInteger(ttl) || ttl < 2 || ttl > 86_400_000
      || !Number.isSafeInteger(interval) || interval < 1 || interval >= ttl) throw new DurableStoreError('INVALID_CONFIGURATION');
    const recordFor = (lease: WorkflowLease): LeaseRecord => {
      const record = leaseHandles.get(lease);
      if (!record?.valid || lease.runtimeInstanceId !== runtimeInstanceId) throw new DurableStoreError('LEASE_FENCED');
      return record;
    };
    const current = (lease: WorkflowLease) => {
      const record = recordFor(lease);
      try { this.read(() => this.#assertLease(record)); }
      catch (error) { record.valid = false; throw error; }
    };
    const renew = (lease: WorkflowLease): WorkflowLease => {
      const record = recordFor(lease);
      try {
        const expiresAt = this.#transaction(true, tx => {
          this.#assertLease(record);
          const now = this.#now(), expiry = Math.max(record.expiresAt, now + ttl);
          tx.run("UPDATE runtime_leases SET heartbeat_at = ?, expires_at = ? WHERE workflow_run_id = ? AND owner_instance_id = ? AND generation = ? AND lease_capability_hash = ? AND lease_state = 'ACTIVE' AND expires_at > ?",
            now, expiry, lease.workflowRunId, lease.runtimeInstanceId, lease.generation, record.capabilityHash, now);
          if (this.#db.prepare('SELECT changes() AS n').get()!.n !== 1) throw new DurableStoreError('LEASE_FENCED');
          this.#assertLease(record);
          return expiry;
        }, { kind: 'management', workflowRunId: lease.workflowRunId });
        record.expiresAt = expiresAt;
        return lease;
      } catch (error) { record.valid = false; throw error; }
    };
    return Object.freeze({
      runtimeInstanceId,
      acquire: (workflowRunId: string): WorkflowLease => {
        if (typeof workflowRunId !== 'string' || !workflowRunId.trim()) throw new DurableStoreError('INVALID_CONFIGURATION');
        const capabilityHash = createHash('sha256').update(randomBytes(32)).digest('hex');
        const metadata = this.#transaction(true, tx => {
          if (!tx.get('SELECT workflow_run_id FROM workflow_seeds WHERE workflow_run_id = ?', workflowRunId)) throw new DurableStoreError('WORKFLOW_NOT_FOUND');
          const now = this.#now();
          const prior = tx.get('SELECT * FROM runtime_leases WHERE workflow_run_id = ?', workflowRunId);
          if (prior?.lease_state === 'ACTIVE' && Number(prior.expires_at) > now) throw new DurableStoreError('LEASE_HELD');
          if (prior && (Number(prior.acquired_at) > now || Number(prior.heartbeat_at) > now)) throw new DurableStoreError('LEASE_FENCED');
          const generation = prior ? Number(prior.generation) + 1 : 1;
          if (!Number.isSafeInteger(generation) || generation < 1) throw new DurableStoreError('LEASE_GENERATION_EXHAUSTED');
          if (prior) tx.run("UPDATE runtime_leases SET owner_instance_id = ?, generation = ?, lease_state = 'ACTIVE', acquired_at = ?, heartbeat_at = ?, expires_at = ?, lease_capability_hash = ? WHERE workflow_run_id = ?",
            runtimeInstanceId, generation, now, now, now + ttl, capabilityHash, workflowRunId);
          else tx.run("INSERT INTO runtime_leases VALUES (?, ?, ?, 'ACTIVE', ?, ?, ?, ?)", workflowRunId, runtimeInstanceId, generation, now, now, now + ttl, capabilityHash);
          return { workflowRunId, runtimeInstanceId, generation, acquiredAt: now, expiresAt: now + ttl };
        }, { kind: 'management', workflowRunId });
        // Registry insertion is deliberately AFTER acknowledged COMMIT. A lost response grants nothing.
        const record: LeaseRecord = { handle: undefined!, capabilityHash, valid: true, expiresAt: metadata.expiresAt,
          wall: metadata.acquiredAt, monotonic: performance.now() };
        const handle = Object.freeze({ ...metadata, get expiresAt() { return record.expiresAt; } });
        record.handle = handle; leaseHandles.set(handle, record);
        return handle;
      },
      renew,
      assertCurrent: current,
      release: (lease: WorkflowLease): void => {
        const record = recordFor(lease);
        try {
          this.#transaction(true, tx => {
            this.#assertLease(record);
            tx.run("UPDATE runtime_leases SET lease_state = 'RELEASED' WHERE workflow_run_id = ? AND owner_instance_id = ? AND generation = ? AND lease_capability_hash = ? AND lease_state = 'ACTIVE' AND expires_at > ?",
              lease.workflowRunId, lease.runtimeInstanceId, lease.generation, record.capabilityHash, this.#now());
            if (this.#db.prepare('SELECT changes() AS n').get()!.n !== 1) throw new DurableStoreError('LEASE_FENCED');
          }, { kind: 'management', workflowRunId: lease.workflowRunId });
        } finally { record.valid = false; }
      },
      inspect: (workflowRunId: string): LeaseInspection | undefined => this.read(tx => {
        const row = tx.get('SELECT * FROM runtime_leases WHERE workflow_run_id = ?', workflowRunId);
        if (!row) return;
        const now = this.#now();
        return { workflowRunId, runtimeInstanceId: String(row.owner_instance_id), generation: Number(row.generation),
          acquiredAt: Number(row.acquired_at), heartbeatAt: Number(row.heartbeat_at), expiresAt: Number(row.expires_at),
          state: row.lease_state === 'RELEASED' ? 'RELEASED' : Number(row.expires_at) <= now ? 'EXPIRED' : 'ACTIVE',
          inspectedAt: now, executionAllowed: false };
      }),
      startHeartbeat: (lease: WorkflowLease, onLost: (code: string) => void): (() => void) => {
        current(lease);
        const timer = setInterval(() => {
          try { renew(lease); }
          catch (error) { clearInterval(timer); onLost(error instanceof DurableStoreError ? error.code : 'LEASE_FENCED'); }
        }, interval);
        timer.unref();
        return () => clearInterval(timer);
      },
    });
  }
  /** Consistent SQLite backup (includes committed WAL data); trusted, new target only. */
  backup(path: string): void {
    if (this.#closed || this.#active) throw new DurableStoreError('INVALID_TRANSACTION');
    guarded('DATABASE_ERROR', () => {
      if (existsSync(path)) throw new DurableStoreError('INVALID_CONFIGURATION');
      protectPath(path);
      this.#db.prepare('VACUUM INTO ?').run(path);
    });
  }
  close(): void {
    if (this.#active) throw new DurableStoreError('INVALID_TRANSACTION');
    if (!this.#closed) { guarded('DATABASE_ERROR', () => this.#db.close()); this.#closed = true; }
  }
}
