import { readWorkflowControl } from './recoveryHoldLifecycle';
import { effectiveModelRows } from './safeRecoveryModelState';
import { BoundedRuntime } from './recoveryContinuationCoordinator';
import type { BoundedRuntimeOptions } from './recoveryContinuationCoordinator';
import type { ContinuationCommand, ContinuationPlan, ContinuationPlanInput } from './continuationTypes';
import type { RunnerExecutorRegistry } from '../runner/types';
import { DatabaseSync } from 'node:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import { DATABASE_NOW_SQL } from './leaseSchema';
import { DEFAULT_HEARTBEAT_INTERVAL_MS, DEFAULT_LEASE_TTL_MS, runtimeInstanceId } from './runtimeLease';
import type { LeaseInspection, RuntimeLeaseManager, RuntimeLeaseOptions, WorkflowLease } from './runtimeLease';
import type { SQLInputValue, SQLOutputValue } from 'node:sqlite';
import { closeSync, chmodSync, existsSync, lstatSync, mkdirSync, openSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { digest, DurableStoreError, guarded, requireIntegrity } from './integrity';
import { migrate } from './migrations';
import { nextAnchor, readJournal } from './restore';
import { validateAuditRow } from './recoveryAudit';
import { verifyRecoveryIdentity } from './recoveryAuthorization';
import { persistRecoveryDecision, inspectGrant, recoveryDecisionSummary } from './recoveryDecisionStore';
import { recoveryGateReason, recoveryStartAllowed } from './recoveryExecutionGate';
import { recoveryTime } from './recoveryPlanner';
import { canonicalJson, jsonCopy, parseJson } from './integrity';
import { persistSafeRecoveryDecision, readSafeRecoveryReceipt } from './safeRecoveryStore';
import type { SafeRecoveryCommand, SafeRecoveryIntent } from './safeRecoveryTypes';
import type { RecoveryAuthorizationPolicy, RecoveryDecisionCommand, RecoveryGrantScope, RecoveryIdentityVerifier } from './recoveryDecisionTypes';
import type { ModelCallIdentity } from './modelCallLedger';
import type { RunnerModelApplicationResult } from '../runner/types';
import type { CoordinationEvent } from '../types';
import type { RunnerEvidence } from '../runner/types';
import type { EvidenceOwner } from './evidenceStore';
import type { ControlledCommand, ControlledExecutorRegistry, ControlledTiming, DispatchInspection, DispatchIntent } from './controlledRecoveryTypes';
import { controlledBinding, controlledTiming, preparedEligibility, dispatchPostState, assertControlledBudget } from './controlledRecoveryPlanner';
import { assertDispatchSink, controlledVector, persistControlledDecision, persistDispatchEvidence, persistDispatchResult, readControlledPlan, reserveControlledDispatch } from './recoveryDispatchStore';
import type { ControlledWriter } from './recoveryDispatchStore';
import { inspectDispatchInTransaction } from './recoveryDispatchReader';
import { collectControlledResult, unknownDispatchResult } from './recoveryDispatchCoordinator';
import type { ControlledExecutionWindow } from './recoveryDispatchCoordinator';

export type Row = Record<string, SQLOutputValue>;
export interface DurableTransaction {
  get(sql: string, ...params: SQLInputValue[]): Row | undefined;
  all(sql: string, ...params: SQLInputValue[]): Row[];
  run(sql: string, ...params: SQLInputValue[]): void;
}
export interface DurableDatabaseOptions {
  path: string; busyTimeoutMs?: number;
  bounded?: BoundedRuntimeOptions;
  /** Trusted host startup dependency. Never populate from an HTTP request or saved DTO. */
  recoveryIdentityVerifier?: RecoveryIdentityVerifier;
  recoveryAuthorizationPolicy?: RecoveryAuthorizationPolicy;
  controlledExecutors?: ControlledExecutorRegistry;
  controlledTiming?: Partial<ControlledTiming>;
}

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
  databaseIdentity: string;
  expiresAt: number; wall: number; monotonic: number;
}
// Neither a serialized DTO nor knowledge of owner/generation can populate this registry.
const leaseHandles = new WeakMap<WorkflowLease, LeaseRecord>();
type WriteContext = { kind: 'lease'; record: LeaseRecord }
  | { kind: 'management'; workflowRunId: string }
  | { kind: 'bootstrap'; workflowRunId: string; seed: boolean; journal: boolean; audit: boolean };
interface ModelApplicationScope {
  tx: DurableTransaction; identity: ModelCallIdentity; phase: string; roundKey: string;
  requestCursor: number; requestEventId: string; startCursor: number; usageEventId: string;
  runtimeInstanceId: string; generation: number;
}
interface SafeRecoveryScope {
  tx: DurableTransaction; intent: SafeRecoveryIntent;
  seedUpdates: string[]; ledgerBefore?: Row;
}
interface ControlledSqlScope { tx: DurableTransaction; table: string; row: Row; old?: Row; actorId: string }
interface DispatchSink { intent: DispatchIntent; lease: WorkflowLease; valid: boolean; collecting: boolean; execution: ControlledExecutionWindow }

/** One synchronous transaction owner. SQLite serializes writers across connections. */
export class DurableDatabase {
  #db: DatabaseSync;
  readonly #bounded: BoundedRuntime;
  readonly #databaseIdentity: string;
  #context?: WriteContext;
  #fencingRejected = false;
  #active?: DurableTransaction;
  #writable = false;
  #closed = false;
  readonly #recoveryVerifier?: RecoveryIdentityVerifier;
  readonly #recoveryPolicy: RecoveryAuthorizationPolicy;
  #recoveryIntent?: { workflowRunId: string; kind: string; id: string; planId?: string; actorId?: string };
  #recoveryRejected = false;
  #modelApplication?: ModelApplicationScope;
  #safeRecovery?: SafeRecoveryScope;
  #safeRecoveryCommand = false;
  readonly #controlledExecutors?: ControlledExecutorRegistry;
  readonly #controlledTiming: ControlledTiming;
  #controlledCommand = false;
  #controlledScope?: ControlledSqlScope;
  readonly #sendPermits = new WeakSet<object>();
  readonly #resultSinks = new WeakSet<DispatchSink>();
  readonly #dispatchEvidence = new AsyncLocalStorage<DispatchSink>();
  #timeAnchor = { wall: Date.now(), monotonic: performance.now() };
  constructor(options: DurableDatabaseOptions) {
    const observedBindings = new Map<string,{executor:object;execute:unknown;prepare:unknown}>();
    const registryGet = options.controlledExecutors?.get.bind(options.controlledExecutors);
    this.#controlledExecutors = registryGet
      ? Object.freeze({get: (id:string) => {
        const binding = registryGet(id);
        if (binding) {
          const key = canonicalJson([id,binding.contractVersion,binding.implementationDigest]);
          const prior = observedBindings.get(key);
          requireIntegrity(!prior || prior.executor === binding.executor && prior.execute === binding.executor.execute && prior.prepare === binding.executor.prepare);
          observedBindings.set(key,{executor:binding.executor,execute:binding.executor.execute,prepare:binding.executor.prepare});
        }
        return binding;
      }}) : undefined;
    this.#bounded = new BoundedRuntime({db:this,verifier:options.recoveryIdentityVerifier,executorBinding:input=>(input.actions??[]).map(a=>{
      const b=this.#controlledExecutors?.get(a.executorId);requireIntegrity(b&&b.sideEffectRetries==='disabled');
      return {executorId:a.executorId,contractVersion:b.contractVersion,implementationDigest:b.implementationDigest};
    }),write:(lease,fn)=>this.#writeFenced(lease,lease.workflowRunId,fn)},options.bounded);
    this.#controlledTiming = controlledTiming(options.controlledTiming);
    this.#recoveryVerifier = options.recoveryIdentityVerifier
      ? Object.freeze({ verify: options.recoveryIdentityVerifier.verify.bind(options.recoveryIdentityVerifier) }) : undefined;
    this.#recoveryPolicy = jsonCopy(options.recoveryAuthorizationPolicy ?? {});
    for (const p of Object.values(this.#recoveryPolicy)) requireIntegrity(Number.isSafeInteger(p.minimumApprovers)
      && p.minimumApprovers >= 1 && p.minimumApprovers <= 100 && typeof p.forbidSelfApproval === 'boolean');
    const timeout = options.busyTimeoutMs ?? 5000;
    if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 60000) throw new DurableStoreError('INVALID_CONFIGURATION');
    this.#db = guarded('DATABASE_ERROR', () => { protectPath(options.path); return new DatabaseSync(options.path); });
    try {
      // Process-local authority is tied to a canonical file, never to a copied DB row.
      // File identity also distinguishes a replacement at the same path. These values
      // are not persisted, so VACUUM INTO / filesystem copies cannot clone authority.
      const file = statSync(options.path, { bigint: true });
      this.#databaseIdentity = JSON.stringify([realpathSync.native(options.path), String(file.dev), String(file.ino)]);
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
    const code = (error as { message?: string })?.message;
    if (['RECOVERY_HELD','RECOVERY_UNAUTHORIZED','RECOVERY_IMMUTABLE','RECOVERY_EXECUTION_DISABLED'].includes(code ?? ''))
      return new DurableStoreError(code as 'RECOVERY_HELD');
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
      if (!(mutation ? /^(INSERT|UPDATE|DELETE)\s/i : /^SELECT\s/i).test(sql.trim())) {
        if (this.#safeRecoveryCommand || this.#controlledCommand || this.#bounded.protecting) this.#recoveryRejected = true;
        throw new DurableStoreError('INVALID_TRANSACTION');
      }
    };
    const tx: DurableTransaction = {
      get: (sql, ...params) => { try { check(sql, false); return this.#db.prepare(sql).get(...params); }
        catch (error) { if (this.#safeRecoveryCommand || this.#controlledCommand || this.#bounded.protecting) this.#recoveryRejected = true; throw error; } },
      all: (sql, ...params) => { try { check(sql, false); return this.#db.prepare(sql).all(...params); }
        catch (error) { if (this.#safeRecoveryCommand || this.#controlledCommand || this.#bounded.protecting) this.#recoveryRejected = true; throw error; } },
      run: (sql, ...params) => {
        check(sql, true);
        try { this.#db.prepare(sql).run(...params); }
        catch (error) {
          const safe = this.safeError(error);
          if (safe.code === 'LEASE_FENCED') this.#fencingRejected = true;
          if (safe.code.startsWith('RECOVERY_') || this.#modelApplication || this.#safeRecoveryCommand || this.#controlledCommand || this.#bounded.protecting) this.#recoveryRejected = true;
          throw safe;
        }
      },
    };
    let begun = false, commitAttempted = false;
    try {
      this.#db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN'); begun = true;
      this.#active = tx; this.#writable = write; this.#context = context; this.#fencingRejected = false;
      if (context?.kind === 'lease') { this.#assertLease(context.record); this.#bounded.before(tx,context.record.handle.workflowRunId); }
      const result = fn(tx);
      if (context?.kind === 'lease') this.#bounded.after(tx);
      if (result && typeof (result as { then?: unknown }).then === 'function') throw new DurableStoreError('INVALID_TRANSACTION');
      if (this.#fencingRejected) throw new DurableStoreError('LEASE_FENCED');
      if (this.#recoveryRejected) throw new DurableStoreError('RECOVERY_UNAUTHORIZED');
      if (context?.kind === 'lease') this.#assertLease(context.record);
      if (context?.kind === 'bootstrap') this.#assertBootstrap(tx, context);
      commitAttempted = true; this.#db.exec('COMMIT'); begun = false;
      return result;
    } catch (error) {
      // A successful COMMIT can lose its acknowledgement. Keep a usable connection
      // only when SQLite confirms the transaction ended; the receipt reader decides
      // the outcome. Older runtimes without this observation keep the closed fallback.
      const endedAfterCommit = (this.#safeRecoveryCommand || this.#controlledCommand || this.#bounded.protecting) && commitAttempted
        && (this.#db as DatabaseSync & { isTransaction?: boolean }).isTransaction === false;
      if (begun && !endedAfterCommit) {
        try { this.#db.exec('ROLLBACK'); }
        catch { this.#db.close(); this.#closed = true; }
      }
      throw this.safeError(error);
    } finally { this.#bounded.clear(); this.#active = undefined; this.#writable = false; this.#context = undefined; this.#fencingRejected = false;
      this.#recoveryIntent = undefined; this.#recoveryRejected = false; this.#modelApplication = undefined;
      this.#safeRecovery = undefined; this.#safeRecoveryCommand = false;
      this.#controlledScope = undefined; this.#controlledCommand = false; }
  }
  previewContinuation(input:ContinuationPlanInput,credential:unknown) {return this.#bounded.preview(input,credential);}
  continuationDecision(lease: WorkflowLease | undefined, credential: unknown, command: ContinuationCommand): unknown {
    return this.#bounded.command(lease,credential,command);
  }
  startContinuation(lease:WorkflowLease|undefined,planId:string,credential:unknown,signal?:AbortSignal) {
    return this.#bounded.start(lease,planId,credential,signal);
  }
  validateInvocationAction(action:import('../runner/types').PreparedRunnerAction):void {this.#bounded.validateAction(action);}
  putBoundedEvidence(owner:EvidenceOwner,evidence:RunnerEvidence):string|undefined {return this.#bounded.putEvidence(owner,evidence);}
  collectInvocationModel<T>(invoke:()=>Promise<T>,signal?:AbortSignal) {return this.#bounded.collectModel(invoke,signal);}
  get boundedInvocationActive(): boolean { return this.#bounded.active; }
  outsideInvocation<T>(fn:()=>T):T { return this.#bounded.withoutAuthority(fn); }
  participateInvocation(tx:DurableTransaction,kind:'MODEL'|'ACTION',target:string,amounts:{inputTokens:number;outputTokens:number;costMicros:number},roundKey?:string):void {
    this.assertTransaction(tx,true);this.#bounded.participate(tx,kind,target,amounts,roundKey);
  }
  boundedExecutorRegistry(plan:ContinuationPlan):RunnerExecutorRegistry {
    requireIntegrity(this.#bounded.active && plan.operation==='BOUNDED_CONTINUATION');
    return {get:(id:string)=>{
      const binding=this.#controlledExecutors?.get(id); if(!binding)return;
      requireIntegrity(binding.sideEffectRetries==='disabled');
      return {id,prepare:proposal=>this.outsideInvocation(async()=>jsonCopy(await binding.executor.prepare(proposal))),
        execute:(action,context)=>this.#bounded.executeAction(binding.executor.execute.bind(binding.executor),action,context)};
    }};
  }
  read<T>(fn: (tx: DurableTransaction) => T): T { return this.#transaction(false, fn); }
  get recoveryPolicy(): RecoveryAuthorizationPolicy { return jsonCopy(this.#recoveryPolicy); }
  #controlledWriter(tx: DurableTransaction, lease: WorkflowLease, actorId: string, phase: 'MANAGE'|'RESERVE'|'RESULT'): ControlledWriter {
    this.#controlledCommand = true;
    const tables = phase === 'MANAGE' ? ['recovery_controlled_plans','recovery_controlled_grants']
      : phase === 'RESERVE' ? ['execution_ledger','recovery_controlled_grants','recovery_dispatch_intents','recovery_dispatch_grants']
      : ['runner_evidence','recovery_dispatch_evidence','execution_results','execution_ledger','recovery_dispatch_receipts'];
    return (table,row,old) => {
      this.assertWorkflowWrite(tx,lease.workflowRunId);
      requireIntegrity(tables.includes(table) && row.workflow_run_id === lease.workflowRunId && (!old || old.workflow_run_id === lease.workflowRunId)
        && !this.#modelApplication && !this.#safeRecovery);
      this.#controlledScope = {tx,table,row:jsonCopy(row),old:old && jsonCopy(old),actorId};
    };
  }
  previewControlledDispatch(workflowRunId: string) {
    return this.read(tx => {
      readJournal(tx,workflowRunId);
      const held = !!tx.get('SELECT workflow_run_id FROM recovery_effective_holds WHERE workflow_run_id=?',workflowRunId);
      const candidates = tx.all("SELECT action_id FROM execution_ledger WHERE workflow_run_id=? AND state='PREPARED'",workflowRunId).map(row => {
        let reason: string | null = held ? null : 'HOLD_NOT_ESTABLISHED';
        if (held) try { controlledBinding(this,tx,{workflowRunId,actionId:String(row.action_id)},this.#controlledExecutors,this.#controlledTiming); }
        catch (error) { if (!(error instanceof DurableStoreError) || ['DATABASE_ERROR','DATABASE_BUSY'].includes(error.code)) throw error; reason = error.code; }
        return {actionId:String(row.action_id),eligible:reason === null,reason,executable:false as const};
      });
      return {workflowRunId,candidates,executionAllowed:false as const};
    });
  }
  /** Authenticated closed management API. DTOs never carry authority or callbacks. */
  controlledRecoveryDecision(lease: WorkflowLease | undefined, credential: unknown, input: ControlledCommand) {
    const command = jsonCopy(input);
    if (command.kind === 'INSPECT') return this.read(tx => {
      verifyRecoveryIdentity(this.#recoveryVerifier,credential,recoveryTime(tx),'VIEW');
      return inspectDispatchInTransaction(tx,command.planId);
    });
    if (!lease) throw new DurableStoreError('LEASE_FENCED');
    if (!['CREATE_PLAN','AUTHORIZE','REVOKE'].includes(command.kind)) throw new DurableStoreError('RECOVERY_UNAUTHORIZED');
    return this.#writeFenced(lease,lease.workflowRunId,tx => {
      this.#controlledCommand = true;
      const identity = verifyRecoveryIdentity(this.#recoveryVerifier,credential,recoveryTime(tx),command.kind);
      const workflow = command.kind === 'CREATE_PLAN' ? command.input.workflowRunId : command.kind === 'REVOKE'
        ? tx.get('SELECT workflow_run_id FROM recovery_controlled_grants WHERE authorization_id=?',command.authorizationId)?.workflow_run_id
        : tx.get('SELECT workflow_run_id FROM recovery_controlled_plans WHERE plan_id=?',command.planId)?.workflow_run_id;
      if (workflow !== lease.workflowRunId) throw new DurableStoreError('RECOVERY_UNAUTHORIZED');
      if (command.kind === 'CREATE_PLAN' && !tx.get('SELECT workflow_run_id FROM recovery_effective_holds WHERE workflow_run_id=?',workflow)) {
        // Identity and eligibility precede the first management write. Same transaction as the plan.
        preparedEligibility(this,tx,command.input);
        this.#recoveryIntent = {workflowRunId:workflow,kind:'HOLD',id:workflow};
        const now = recoveryTime(tx);
        const control=readWorkflowControl(tx,workflow);requireIntegrity(!control.active_invocation_id&&!control.planning_review_pending);
        if(tx.get('SELECT workflow_run_id FROM recovery_holds WHERE workflow_run_id=?',workflow)) {
          tx.run("INSERT INTO recovery_hold_lifecycle SELECT NULL,workflow_run_id,hold_epoch+1,control_revision+1,'HELD',NULL,planning_review_pending,'GATE_REHOLD',?,? FROM recovery_workflow_control WHERE workflow_run_id=?",lease.generation,now,workflow);
        } else {
        tx.run("INSERT INTO recovery_holds VALUES (?,1,'STATE_CHANGED',?,?,'GATE',1)",workflow,lease.generation,now);
        tx.run(`INSERT INTO runtime_audit_events (audit_event_id,workflow_run_id,event_kind,entity_kind,entity_id,
          recovery_hold_revision,next_state,reason_code,occurred_at,recorded_at,schema_version,runtime_instance_id,runtime_generation)
          VALUES (lower(hex(randomblob(16))),?,'RECOVERY_HOLD_CREATED','WORKFLOW',?,1,'HELD','STATE_CHANGED',?,?,1,?,?)`,workflow,workflow,now,now,lease.runtimeInstanceId,lease.generation);
        }
        this.#recoveryIntent = undefined;
      }
      return persistControlledDecision(this,tx,command,identity,lease,this.#controlledExecutors,this.#controlledTiming,
        this.#controlledWriter(tx,lease,identity.actorId,'MANAGE'));
    });
  }
  /** A saved Intent is a read result; only the private branch observing A's normal return can mint a permit. */
  async executeControlledDispatch(lease: WorkflowLease | undefined, planId: string, credential: unknown, signal?: AbortSignal): Promise<DispatchInspection> {
    const prior = this.read(tx => {
      verifyRecoveryIdentity(this.#recoveryVerifier,credential,recoveryTime(tx),'CREATE_PLAN');
      const inspection = inspectDispatchInTransaction(tx,planId);
      return inspection.intent ? inspection : undefined;
    });
    if (prior) return prior;
    if (!lease) throw new DurableStoreError('LEASE_FENCED');
    if (signal?.aborted) throw new DurableStoreError('RECOVERY_UNAUTHORIZED');
    let reserved: ReturnType<typeof reserveControlledDispatch> | undefined;
    try {
      const committed = this.#writeFenced(lease,lease.workflowRunId,tx => {
        this.#controlledCommand = true;
        const identity = verifyRecoveryIdentity(this.#recoveryVerifier,credential,recoveryTime(tx),'CREATE_PLAN');
        const plan = readControlledPlan(tx,planId);
        if (plan.workflowRunId !== lease.workflowRunId) throw new DurableStoreError('RECOVERY_UNAUTHORIZED');
        if (tx.get('SELECT operation_id FROM recovery_dispatch_intents WHERE plan_id=?',planId)) return undefined;
        const reserved = reserveControlledDispatch(this,tx,plan,identity,lease,this.#controlledExecutors,this.#controlledTiming,
          this.#controlledWriter(tx,lease,identity.actorId,'RESERVE'));
        requireIntegrity(canonicalJson(inspectDispatchInTransaction(tx,planId).intent) === canonicalJson(reserved.intent)
          && recoveryTime(tx) < reserved.intent.sendDeadline);
        return reserved;
      });
      reserved = committed;
    } catch (error) {
      // COMMIT ACK loss is never inferred to be a successful reservation for sending.
      try { const saved = this.controlledRecoveryDecision(undefined,credential,{kind:'INSPECT',planId}) as DispatchInspection; if (saved.intent) return saved; } catch { /* Original fixed error. */ }
      throw error;
    }
    if (!reserved) return this.controlledRecoveryDecision(undefined,credential,{kind:'INSPECT',planId}) as DispatchInspection;
    const permit = Object.freeze({}); this.#sendPermits.add(permit);
    const {intent,record,executor} = reserved;
    const sink: DispatchSink = {intent:jsonCopy(intent),lease,valid:true,collecting:true,execution:{}}; this.#resultSinks.add(sink);
    // Synchronous consumption before any await, adapter callback, or re-entrant request.
    requireIntegrity(this.#sendPermits.delete(permit));
    try {
      const canSend = this.#writeFenced(lease,intent.workflowRunId,tx => {
        assertDispatchSink(tx,intent); assertControlledBudget(tx,intent.workflowRunId);
        requireIntegrity(dispatchPostState(tx,intent.workflowRunId) === intent.expectedStateDigest);
        return recoveryTime(tx) < intent.sendDeadline && !signal?.aborted;
      });
      const result = canSend ? await this.#dispatchEvidence.run(sink,() => collectControlledResult(executor.execute,record.action,
        {workflowRunId:intent.workflowRunId,sessionId:intent.sessionId,taskId:intent.taskId,signal},intent.executionTimeoutMs,sink.execution))
        : unknownDispatchResult('RUNNER_DISPATCH_NOT_STARTED');
      sink.collecting = false;
      const normalized = jsonCopy({...result,resultRef:result.resultRef ?? intent.defaultEvidenceRef});
      const recordedAt = this.read(tx => recoveryTime(tx));
      // Only this captured, normalized Result can be saved. No public resume/save capability.
      // B uses the collection deadline, so an expired execution can still record Timeout.
      try {
        this.#writeFenced(lease,intent.workflowRunId,tx => {
          requireIntegrity(sink.valid && this.#resultSinks.has(sink));
          const receipt = persistDispatchResult(tx,intent,normalized,recordedAt,this.#controlledWriter(tx,lease,intent.actorId,'RESULT'));
          requireIntegrity(canonicalJson(inspectDispatchInTransaction(tx,planId).receipt) === canonicalJson(receipt)
            && recoveryTime(tx) < intent.resultCollectionDeadline);
          return receipt;
        });
      } catch (error) {
        const saved = this.controlledRecoveryDecision(undefined,credential,{kind:'INSPECT',planId}) as DispatchInspection;
        if (!saved.receipt) throw error; // B ACK loss: read, never rerun the executor.
        requireIntegrity(saved.receipt.resultDigest === digest(normalized));
      }
      return this.controlledRecoveryDecision(undefined,credential,{kind:'INSPECT',planId}) as DispatchInspection;
    } finally { sink.valid = false; sink.collecting = false; this.#resultSinks.delete(sink); }
  }
  /** Evidence Store participant: ordinary withOwner/IDs cannot populate this private async context. */
  putControlledEvidence(owner: EvidenceOwner, evidence: RunnerEvidence): string | undefined {
    const sink = this.#dispatchEvidence.getStore(); if (!sink) return undefined;
    requireIntegrity(sink.valid && sink.collecting && this.#resultSinks.has(sink));
    const executionDeadline = sink.execution.deadline;
    requireIntegrity(executionDeadline !== undefined && performance.now() < executionDeadline);
    const i = sink.intent;
    requireIntegrity(owner.workflowRunId === i.workflowRunId && owner.sessionId === i.sessionId && owner.taskId === i.taskId && owner.actionId === i.actionId);
    const ref = `map.runner.evidence.v1:${randomBytes(16).toString('hex')}`;
    return this.#writeFenced(sink.lease,i.workflowRunId,tx => {
      requireIntegrity(performance.now() < executionDeadline);
      const saved = persistDispatchEvidence(tx,i,ref,jsonCopy(evidence),this.#controlledWriter(tx,sink.lease,i.actorId,'RESULT'));
      requireIntegrity(performance.now() < executionDeadline);
      return saved;
    });
  }
  /** Closed 4B dispatcher. No caller-supplied callback or authority token is accepted. */
  safeRecoveryDecision(lease: WorkflowLease | undefined, credential: unknown, input: SafeRecoveryCommand) {
    const command = jsonCopy(input);
    if (command.kind === 'RECEIPT') return this.read(tx => {
      verifyRecoveryIdentity(this.#recoveryVerifier, credential, recoveryTime(tx), 'VIEW');
      return readSafeRecoveryReceipt(tx, command.executionPlanId);
    });
    if (!lease) throw new DurableStoreError('LEASE_FENCED');
    if (!['CREATE_PLAN','AUTHORIZE','REVOKE','EXECUTE','RECEIPT'].includes(command.kind)) throw new DurableStoreError('RECOVERY_UNAUTHORIZED');
    return this.writeWithLease(lease, lease.workflowRunId, tx => {
      this.#safeRecoveryCommand = true;
      const identity = verifyRecoveryIdentity(this.#recoveryVerifier, credential, recoveryTime(tx),
        command.kind === 'EXECUTE' ? 'CREATE_PLAN' : command.kind === 'RECEIPT' ? 'VIEW' : command.kind);
      const workflow = command.kind === 'CREATE_PLAN' ? command.input.workflowRunId
        : command.kind === 'REVOKE' ? tx.get('SELECT workflow_run_id FROM recovery_execution_grants WHERE authorization_id=?', command.authorizationId)?.workflow_run_id
        : tx.get('SELECT workflow_run_id FROM recovery_execution_plans WHERE execution_plan_id=?', command.executionPlanId)?.workflow_run_id;
      if (workflow !== lease.workflowRunId) throw new DurableStoreError('RECOVERY_UNAUTHORIZED');
      const result = persistSafeRecoveryDecision(this, tx, command, identity, lease, intent => {
        requireIntegrity(!this.#safeRecovery && !this.#modelApplication && !this.#recoveryIntent);
        const saved = jsonCopy(intent), seedUpdates: string[] = [];
        requireIntegrity(saved.workflowRunId === lease.workflowRunId && saved.actorId === identity.actorId);
        let ledgerBefore: Row | undefined;
        if (saved.kind === 'EXECUTE') {
          const plan = saved.plan!;
          requireIntegrity(plan && plan.runtimeInstanceId === lease.runtimeInstanceId && plan.runtimeGeneration === lease.generation
            && plan.executionPlanId === saved.executionPlanId && saved.operationId && saved.grantIds?.length);
          const journal = readJournal(tx, lease.workflowRunId);
          let anchor = journal.anchors.at(-1)!;
          for (const event of saved.journalEvents ?? []) {
            requireIntegrity(event.workflowRunId === lease.workflowRunId);
            anchor = nextAnchor(anchor, event); seedUpdates.push(canonicalJson([event.sequence, anchor]));
          }
          if (['REFLECT_RECORDED_RESULT','COMPLETE_SAFETY_STOP'].includes(plan.operationKind))
            ledgerBefore = tx.get('SELECT * FROM execution_ledger WHERE workflow_run_id=? AND action_id=?', lease.workflowRunId, plan.targetId);
        }
        this.#safeRecovery = { tx, intent: saved, seedUpdates, ledgerBefore };
      });
      const scope = this.#safeRecovery;
      if (scope?.intent.kind === 'EXECUTE') {
        const plan = scope.intent.plan!, expected = scope.intent.journalEvents ?? [];
        requireIntegrity(canonicalJson(readJournal(tx, lease.workflowRunId).events.slice(plan.journalCursor)) === canonicalJson(expected));
        requireIntegrity(tx.get('SELECT operation_id FROM recovery_execution_operations WHERE operation_id=? AND execution_plan_id=?',
          scope.intent.operationId!, plan.executionPlanId));
      }
      return result;
    });
  }
  /** Only this closed command dispatcher can establish recovery-management context. */
  recoveryDecision(lease: WorkflowLease | undefined, credential: unknown, command: RecoveryDecisionCommand) {
    command = jsonCopy(command);
    if (!lease) throw new DurableStoreError('LEASE_FENCED');
    return this.writeWithLease(lease, lease.workflowRunId, tx => {
      const identity = verifyRecoveryIdentity(this.#recoveryVerifier, credential, recoveryTime(tx), command.kind);
      const workflow = command.kind === 'CREATE_PLAN' ? command.input.workflowRunId
        : command.kind === 'REVOKE' ? tx.get('SELECT workflow_run_id FROM recovery_authorizations WHERE authorization_id=?', command.authorizationId)?.workflow_run_id
        : tx.get('SELECT workflow_run_id FROM recovery_plans WHERE recovery_plan_id=?', command.recoveryPlanId)?.workflow_run_id;
      if (workflow !== lease.workflowRunId) throw new DurableStoreError('RECOVERY_UNAUTHORIZED');
      if (!['CREATE_PLAN','AUTHORIZE','REVOKE','INVALIDATE'].includes(command.kind)) throw new DurableStoreError('RECOVERY_UNAUTHORIZED');
      return persistRecoveryDecision(this, tx, command, identity, (kind, id, planId) => {
        this.#recoveryIntent = { workflowRunId: lease.workflowRunId, kind, id, planId, actorId: identity.actorId };
      });
    });
  }
  inspectRecoveryAuthorization(id: string, scope: RecoveryGrantScope) { return this.read(tx => inspectGrant(this, tx, id, scope)); }
  viewRecoveryDecisions(credential: unknown, id: string) {
    return this.read(tx => {
      verifyRecoveryIdentity(this.#recoveryVerifier, credential, recoveryTime(tx), 'VIEW');
      readJournal(tx, id);
      return recoveryDecisionSummary(tx, id);
    });
  }
  assertRecoveryExecution(lease: WorkflowLease | undefined, id: string, reservedModelId?: string): void {
    const reason = this.writeWithLease(lease, id, tx => {
      if (this.#bounded.startAllowed(tx,id,'RUNNER')) return undefined;
      let reason;
      try { reason = recoveryGateReason(tx, id, reservedModelId); }
      catch (error) {
        if (!(error instanceof DurableStoreError) || ['DATABASE_ERROR','DATABASE_BUSY'].includes(error.code)) throw error;
        reason = 'INTEGRITY_UNVERIFIED' as const;
      }
      const control = tx.get('SELECT hold_state,active_invocation_id,planning_review_pending FROM recovery_workflow_control WHERE workflow_run_id=?',id);
      if (control?.active_invocation_id || control?.planning_review_pending) return reason;
      if (reason && !tx.get('SELECT workflow_run_id FROM recovery_holds WHERE workflow_run_id=?', id)) {
        this.#recoveryIntent = { workflowRunId: id, kind: 'HOLD', id };
        const now = recoveryTime(tx);
        tx.run("INSERT INTO recovery_holds VALUES (?,1,?,?,?,'GATE',1)", id, reason, lease!.generation, now);
        tx.run(`INSERT INTO runtime_audit_events (audit_event_id,workflow_run_id,event_kind,entity_kind,entity_id,
          recovery_hold_revision,next_state,reason_code,occurred_at,recorded_at,schema_version,runtime_instance_id,runtime_generation)
          VALUES (lower(hex(randomblob(16))),?,'RECOVERY_HOLD_CREATED','WORKFLOW',?,1,'HELD',?,?,?,1,?,?)`, id, id, reason, now, now, lease!.runtimeInstanceId, lease!.generation);
      }
      if(reason && control?.hold_state==='RELEASED') {
        this.#recoveryIntent={workflowRunId:id,kind:'HOLD',id};
        tx.run("INSERT INTO recovery_hold_lifecycle SELECT NULL,workflow_run_id,hold_epoch+1,control_revision+1,'HELD',NULL,planning_review_pending,'GATE_REHOLD',?,? FROM recovery_workflow_control WHERE workflow_run_id=?",lease!.generation,recoveryTime(tx),id);
      }
      return reason;
    });
    // Throw after acknowledged COMMIT so the durable hold is not rolled back.
    if (reason) throw new DurableStoreError('RECOVERY_HELD');
  }
  /** An existing writer gets no blanket exception. Only registration may use the private PLAN scope. */
  assertRecoveryStartInTransaction(tx: DurableTransaction, id: string, registration: boolean): void {
    this.assertWorkflowWrite(tx, id);
    if (this.#bounded.startAllowed(tx,id,registration?'REGISTER':'RUNNER')) return;
    const reason = recoveryGateReason(tx, id);
    if (reason && !(reason === 'PENDING_RESPONSE' && registration && this.#planApplicationCurrent(tx, id))) {
      this.#recoveryRejected = true;
      throw new DurableStoreError('RECOVERY_HELD');
    }
  }
  /** Closed application participant used by markApplied. No scope token or setter escapes.
   * The callback and APPLIED receipt must both succeed inside the existing fenced writer. */
  commitModelApplication<T>(tx: DurableTransaction, input: ModelCallIdentity, expectedCursor: number, apply: () => T): RunnerModelApplicationResult<T> {
    this.assertWorkflowWrite(tx, input.workflowRunId);
    try {
      if (this.#modelApplication) throw new DurableStoreError('INVALID_TRANSACTION');
      const identity = jsonCopy(input), id = identity.workflowRunId;
      const r = tx.get('SELECT * FROM model_call_ledger WHERE workflow_run_id=? AND model_call_id=?', id, identity.modelCallId);
      requireIntegrity(r && r.attempt_id === identity.attemptId && r.provider_id === identity.providerId && r.model_id === identity.modelId);
      const lease = this.#context!.kind === 'lease' ? this.#context!.record.handle : undefined;
      if (r.runtime_instance_id !== lease?.runtimeInstanceId || r.generation !== lease?.generation) this.#fenced();
      requireIntegrity(!tx.get('SELECT model_call_id FROM recovery_model_resolutions WHERE workflow_run_id=? AND model_call_id=?', id, identity.modelCallId));
      const before = readJournal(tx, id).snapshot;
      if (r.application_status === 'APPLIED') {
        const end = before.events.findIndex(e => e.eventId === r.application_event_id) + 1;
        requireIntegrity(expectedCursor === r.application_start_cursor && end > expectedCursor && digest(before.events.slice(expectedCursor, end)) === r.application_digest);
        return { status: 'ALREADY_APPLIED', receipt: { modelCallId: identity.modelCallId, startCursor: expectedCursor,
          eventId: String(r.application_event_id), digest: String(r.application_digest) } };
      }
      requireIntegrity(r.state === 'SETTLED' && r.application_status === 'PENDING_APPLICATION' && r.completeness === 'COMPLETE'
        && !r.budget_violation && ['PLAN','VERIFY'].includes(String(r.phase)) && typeof r.round_key === 'string' && !!r.round_key);
      requireIntegrity(Number.isSafeInteger(expectedCursor) && expectedCursor === Number(r.request_cursor) + 1
        && before.events.length === expectedCursor && before.events.at(-1)!.eventId === r.usage_event_id
        && before.events[Number(r.request_cursor) - 1]?.eventId === r.request_event_id);
      if (!this.#bounded.businessApplicationAllowed(tx,id,identity.modelCallId) && (recoveryGateReason(tx, id) !== 'PENDING_RESPONSE' || tx.get('SELECT workflow_run_id FROM recovery_effective_holds WHERE workflow_run_id=?', id)))
        throw new DurableStoreError('RECOVERY_HELD');
      requireIntegrity(!effectiveModelRows(tx,id).some(row=>row.historical.model_call_id!==identity.modelCallId&&(row.pendingApplication||['DISPATCH_INTENT','REVIEW_REQUIRED'].includes(String(row.historical.state))||row.historical.budget_violation===1)));
      const priorActions = new Set(tx.all('SELECT action_id FROM pending_actions WHERE workflow_run_id=?', id).map(a => a.action_id));
      const scope: ModelApplicationScope = { tx, identity, phase: String(r.phase), roundKey: String(r.round_key),
        requestCursor: Number(r.request_cursor), requestEventId: String(r.request_event_id), startCursor: expectedCursor,
        usageEventId: String(r.usage_event_id), runtimeInstanceId: lease!.runtimeInstanceId, generation: lease!.generation };
      this.#modelApplication = scope;
      const value = apply();
      if (value && typeof (value as { then?: unknown }).then === 'function') throw new DurableStoreError('INVALID_TRANSACTION');
      this.#assertModelApplicationCurrent(scope);
      const events = readJournal(tx, id).snapshot.events.slice(expectedCursor);
      requireIntegrity(events.length > 0 && events.every(e => e.type !== 'UsageRecorded'));
      this.#assertApplicationRegistration(scope, events, priorActions);
      const receipt = { modelCallId: identity.modelCallId, startCursor: expectedCursor, eventId: events.at(-1)!.eventId, digest: digest(events) };
      tx.run("UPDATE model_call_ledger SET application_status='APPLIED',application_event_id=?,application_digest=?,application_start_cursor=?,updated_at=? WHERE model_call_id=?",
        receipt.eventId, receipt.digest, expectedCursor, Date.now(), identity.modelCallId);
      return { status: 'APPLIED', value, receipt };
    } catch (error) {
      // Even a caller catching an application failure cannot commit a partial callback.
      this.#recoveryRejected = true;
      throw error;
    } finally { this.#modelApplication = undefined; }
  }
  #assertModelApplicationCurrent(scope: ModelApplicationScope): void {
    const { tx, identity, startCursor } = scope, id = identity.workflowRunId;
    this.assertWorkflowWrite(tx, id);
    requireIntegrity(this.#modelApplication === scope && this.#context?.kind === 'lease'
      && this.#context.record.handle.runtimeInstanceId === scope.runtimeInstanceId && this.#context.record.handle.generation === scope.generation);
    if (!this.#bounded.businessApplicationAllowed(tx,id,identity.modelCallId) && tx.get('SELECT workflow_run_id FROM recovery_effective_holds WHERE workflow_run_id=?', id)) throw new DurableStoreError('RECOVERY_HELD');
    const r = tx.get('SELECT * FROM model_call_ledger WHERE workflow_run_id=? AND model_call_id=?', id, identity.modelCallId);
    requireIntegrity(r && r.state === 'SETTLED' && r.application_status === 'PENDING_APPLICATION' && !r.budget_violation
      && r.phase === scope.phase && r.round_key === scope.roundKey && r.request_cursor === scope.requestCursor && r.request_event_id === scope.requestEventId
      && r.usage_event_id === scope.usageEventId && r.runtime_instance_id === scope.runtimeInstanceId && r.generation === scope.generation
      && r.attempt_id === identity.attemptId && r.provider_id === identity.providerId && r.model_id === identity.modelId);
    const events = readJournal(tx, id).snapshot.events;
    requireIntegrity(events[scope.requestCursor - 1]?.eventId === scope.requestEventId
      && events[startCursor - 1]?.eventId === scope.usageEventId && events[startCursor - 1]?.type === 'UsageRecorded');
  }
  #planApplicationCurrent(tx: DurableTransaction, id: string): boolean {
    const scope = this.#modelApplication;
    if (!scope || scope.tx !== tx || scope.identity.workflowRunId !== id || scope.phase !== 'PLAN') return false;
    this.#assertModelApplicationCurrent(scope);
    return true;
  }
  #assertApplicationRegistration(scope: ModelApplicationScope, events: CoordinationEvent[], priorActions: Set<SQLOutputValue>): void {
    const sessions = events.filter(e => e.type === 'SessionStarted'), tasks = events.filter(e => e.type === 'TaskAssigned');
    const actions = scope.tx.all('SELECT * FROM pending_actions WHERE workflow_run_id=?', scope.identity.workflowRunId).filter(a => !priorActions.has(a.action_id));
    if (!sessions.length && !tasks.length && !actions.length) return;
    requireIntegrity(scope.phase === 'PLAN' && sessions.length === 1 && tasks.length === 1 && actions.length === 1);
    const action = actions[0], session = sessions[0], task = tasks[0];
    const sessionPayload = session.payload as { sessionId: string; contextRef: string }, taskPayload = task.payload as { taskId: string; sessionId: string };
    const businessRoundKey = scope.tx.get("SELECT business_round_key FROM recovery_invocation_steps WHERE workflow_run_id=? AND kind='MODEL' AND target_id=?",scope.identity.workflowRunId,scope.identity.modelCallId)?.business_round_key ?? scope.roundKey;
    requireIntegrity(action.round_key === `map.runner.v1:${businessRoundKey}` && sessionPayload.contextRef === action.round_key
      && session.sessionId === action.session_id && sessionPayload.sessionId === action.session_id
      && task.sessionId === action.session_id && taskPayload.sessionId === action.session_id && taskPayload.taskId === action.task_id);
    requireIntegrity(scope.tx.get(`SELECT action_id FROM execution_ledger WHERE workflow_run_id=? AND action_id=?
      AND session_id=? AND task_id=? AND fingerprint=? AND executor_id=? AND state='PREPARED'`,
      scope.identity.workflowRunId, action.action_id, action.session_id, action.task_id, action.fingerprint, action.executor_id));
  }
  write<T>(fn: (tx: DurableTransaction) => T): T { return this.#transaction(true, fn); }
  assertWorkflowWrite(tx: DurableTransaction, workflowRunId: string): void {
    this.assertTransaction(tx, true);
    const context = this.#context;
    if (context?.kind !== 'lease' || context.record.handle.workflowRunId !== workflowRunId) this.#fenced();
    this.#assertLease(context.record);
  }
  /** Explicit scope, checked at entry, every SQL mutation (triggers), and before COMMIT. */
  writeWithLease<T>(lease: WorkflowLease | undefined, workflowRunId: string, fn: (tx: DurableTransaction) => T): T {
    return this.#writeFenced(lease,workflowRunId,fn);
  }
  #writeFenced<T>(lease: WorkflowLease | undefined, workflowRunId: string, fn: (tx: DurableTransaction) => T): T {
    const record = lease && leaseHandles.get(lease);
    if (!record?.valid || record.databaseIdentity !== this.#databaseIdentity || lease!.workflowRunId !== workflowRunId) this.#fenced();
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
  #assertBootstrap(tx: DurableTransaction, context: Extract<WriteContext, { kind: 'bootstrap' }>): void {
    if (!(context.seed && context.journal && context.audit)) this.#fenced();
    try {
      // Reuse canonical Seed/Journal validation, including digests, ownership,
      // creation-event equality, sequence/head and anchor. Phase calls alone
      // provide no evidence that the corresponding SQL statements survived.
      const journal = readJournal(tx, context.workflowRunId);
      const creation = journal.events[0];
      requireIntegrity(journal.events.length === 1 && creation.type === 'WorkflowRunCreated');
      const audits = tx.all('SELECT * FROM runtime_audit_events WHERE workflow_run_id = ? ORDER BY audit_sequence LIMIT 2', context.workflowRunId);
      requireIntegrity(audits.length === 1);
      const audit = audits[0];
      requireIntegrity(audit.event_kind === 'JOURNAL_APPENDED' && audit.entity_kind === 'WORKFLOW'
        && audit.entity_id === context.workflowRunId && audit.journal_event_id === creation.eventId
        && audit.journal_sequence === 1 && audit.session_id === null && audit.task_id === null
        && audit.action_id === null && audit.attempt_id === null && audit.subject_agent_id === null
        && audit.runtime_instance_id === null && audit.runtime_generation === null);
      validateAuditRow(tx, audit);
    } catch (error) {
      if (error instanceof DurableStoreError && ['DATABASE_ERROR','DATABASE_BUSY'].includes(error.code)) throw error;
      this.#fenced();
    }
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
    return record.valid && record.databaseIdentity === this.#databaseIdentity && this.#clockValid(record, now) && !!row
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
    this.#db.function('map_bounded_write', (workflow, table, op, target, detail) =>
      ((table === 'recovery_invocations' && op === 'UPDATE' || table === 'bounded_audit' && op === 'INSERT') && this.#context?.kind === 'management' && this.#context.workflowRunId === workflow) || this.#bounded.allows(workflow,table,op,target,detail) ? 1 : 0);
    this.#db.function('map_bounded_event', (workflow,type,payload)=>this.#bounded.eventAllowed(workflow,type,payload)?1:0);
    this.#db.function('map_bounded_legacy_binding', (workflow, table, plan) => {
      if (this.#context?.kind !== 'lease' || this.#context.record.handle.workflowRunId !== workflow) return 0;
      if (table === 'recovery_execution_plans') return this.#safeRecovery?.intent.kind === 'CREATE_PLAN' && this.#safeRecovery.intent.executionPlanId === plan ? 1 : 0;
      return table === 'recovery_controlled_plans' && this.#controlledScope?.table === table && this.#controlledScope.row.plan_id === plan ? 1 : 0;
    });
    this.#db.function('map_controlled_actor', () => this.#controlledScope?.actorId ?? null);
    this.#db.function('map_controlled_write', (table, before, after) => {
      const s = this.#controlledScope;
      if (!s || s.tx !== this.#active || this.#context?.kind !== 'lease' || !this.#controlledCommand
        || s.table !== table || s.row.workflow_run_id !== this.#context.record.handle.workflowRunId) return 0;
      try { return canonicalJson(before === null ? null : parseJson(before)) === canonicalJson(s.old ? parseJson(controlledVector(s.table,s.old)) : null)
        && canonicalJson(parseJson(after)) === canonicalJson(parseJson(controlledVector(s.table,s.row))) ? 1 : 0; } catch { return 0; }
    });
    this.#db.function('map_controlled_audit', (workflow,event,plan,grant,operation,hash,actor) => {
      const s = this.#controlledScope;
      if (!s || s.tx !== this.#active || this.#context?.kind !== 'lease' || !this.#controlledCommand
        || s.row.workflow_run_id !== workflow || workflow !== this.#context.record.handle.workflowRunId || actor !== s.actorId || s.row.plan_id !== plan) return 0;
      const r = s.row;
      if (s.table === 'recovery_controlled_plans') return event === 'RECOVERY_CONTROLLED_PLAN_CREATED' && grant === null && operation === null && hash === r.plan_digest ? 1 : 0;
      if (s.table === 'recovery_controlled_grants') {
        const kind = !s.old ? 'RECOVERY_CONTROLLED_AUTHORIZED' : r.status === 'CONSUMED' ? 'RECOVERY_CONTROLLED_GRANT_CONSUMED' : 'RECOVERY_CONTROLLED_REVOKED';
        return event === kind && grant === r.authorization_id && operation === r.consumed_operation_id && hash === r.grant_digest ? 1 : 0;
      }
      if (s.table === 'recovery_dispatch_intents') return event === 'RECOVERY_DISPATCH_INTENT_COMMITTED' && grant === null && operation === r.operation_id && hash === r.intent_digest ? 1 : 0;
      if (s.table === 'recovery_dispatch_receipts') {
        const receipt = parseJson<{status:string}>(r.receipt_json);
        return event === (receipt.status === 'REVIEW_REQUIRED' ? 'RECOVERY_DISPATCH_REVIEW_REQUIRED' : 'RECOVERY_DISPATCH_RESULT_RECORDED')
          && grant === null && operation === r.operation_id && hash === r.receipt_digest ? 1 : 0;
      }
      return 0;
    });
    // Read-only predicates: SQL can inspect an installed scope, never create one.
    this.#db.function('map_safe_recovery_actor', () => this.#safeRecovery?.intent.actorId ?? null);
    this.#db.function('map_safe_recovery_management', (workflow, kind, id) => {
      const scope = this.#safeRecovery, intent = scope?.intent;
      return scope?.tx === this.#active && this.#context?.kind === 'lease'
        && this.#context.record.handle.workflowRunId === workflow && intent?.workflowRunId === workflow
        && intent.kind === kind && intent.kind !== 'EXECUTE' && intent.id === id ? 1 : 0;
    });
    this.#db.function('map_safe_recovery_write', (workflow, table, operation, target, detail) => {
      const scope = this.#safeRecovery, intent = scope?.intent, plan = intent?.plan;
      if (!scope || scope.tx !== this.#active || this.#context?.kind !== 'lease' || !plan
        || intent!.kind !== 'EXECUTE' || intent!.workflowRunId !== workflow || plan.workflowRunId !== workflow
        || this.#context.record.handle.workflowRunId !== workflow
        || plan.runtimeInstanceId !== this.#context.record.handle.runtimeInstanceId
        || plan.runtimeGeneration !== this.#context.record.handle.generation) return 0;
      try {
        if (table === 'journal_events') return operation === 'INSERT'
          && (intent!.journalEvents ?? []).some(e => e.eventId === target && canonicalJson(e) === detail) ? 1 : 0;
        if (table === 'workflow_seeds') return operation === 'UPDATE' && target === workflow
          && scope.seedUpdates.includes(canonicalJson(parseJson(detail))) ? 1 : 0;
        if (table === 'execution_ledger') {
          const old = scope.ledgerBefore;
          if (operation !== 'UPDATE' || target !== plan.targetId || !old || old.finalized_event_id
            || !['REFLECT_RECORDED_RESULT','COMPLETE_SAFETY_STOP'].includes(plan.operationKind)) return 0;
          const event = intent!.journalEvents?.find(e => ['TaskCompleted','TaskFailed'].includes(e.type));
          if (!event) return 0;
          const keys = ['state','review_reason','finalized_event_id','result_ref','result_digest','attempt_id','reserved_at','updated_at'];
          const next = { ...old, state: plan.operationKind === 'REFLECT_RECORDED_RESULT' ? 'FINALIZED' : 'REVIEW_REQUIRED',
            finalized_event_id: event.eventId, updated_at: event.timestamp };
          return canonicalJson(parseJson(detail)) === canonicalJson({ old: keys.map(k => old[k]), next: keys.map(k => next[k as keyof typeof next]) }) ? 1 : 0;
        }
        if (table === 'recovery_execution_grants') return operation === 'UPDATE' && detail === 'CONSUMED'
          && intent!.grantIds?.includes(String(target)) ? 1 : 0;
        if (table === 'recovery_execution_operations') return operation === 'INSERT'
          && target === intent!.operationId && detail === plan.executionPlanId ? 1 : 0;
        if (table === 'recovery_operation_grants') return operation === 'INSERT' && detail === intent!.operationId
          && intent!.grantIds?.includes(String(target)) ? 1 : 0;
        if (table === 'recovery_hold_transitions') {
          const value = parseJson<unknown[]>(detail);
          return operation === 'INSERT' && target === intent!.operationId && value.length === 3
            && value[0] === plan.recoveryHoldRevision && value[1] === plan.recoveryHoldRevision + 1
            && ['RECOVERY_STEP_APPLIED','READY_FOR_CONTINUATION_REVIEW'].includes(String(value[2])) ? 1 : 0;
        }
        if (table === 'recovery_model_resolutions') return operation === 'INSERT' && target === plan.targetId
          && (plan.operationKind === 'CANCEL_UNSENT_MODEL' && detail === 'CANCELLED_UNSENT'
            || plan.operationKind === 'DISCARD_SETTLED_RESPONSE' && detail === 'DISCARDED_BY_RECOVERY') ? 1 : 0;
      } catch { return 0; }
      return 0;
    });
    this.#db.function('map_safe_recovery_audit', (workflow, event, plan, grant, operation, revision) => {
      const scope = this.#safeRecovery, intent = scope?.intent;
      if (!scope || scope.tx !== this.#active || this.#context?.kind !== 'lease' || !intent
        || this.#context.record.handle.workflowRunId !== workflow || intent.workflowRunId !== workflow
        || intent.executionPlanId !== plan) return 0;
      if (intent.kind !== 'EXECUTE') {
        const expected = { CREATE_PLAN: 'RECOVERY_EXECUTION_PLAN_CREATED', AUTHORIZE: 'RECOVERY_EXECUTION_AUTHORIZED', REVOKE: 'RECOVERY_EXECUTION_REVOKED' }[intent.kind];
        return event === expected && operation === null && revision === null
          && grant === (intent.kind === 'CREATE_PLAN' ? null : intent.id) ? 1 : 0;
      }
      if (operation !== intent.operationId) return 0;
      if (event === 'RECOVERY_GRANT_CONSUMED') return intent.grantIds?.includes(String(grant)) && revision === null ? 1 : 0;
      if (grant !== null) return 0;
      if (event === 'RECOVERY_HOLD_STEP_APPLIED') return revision === intent.plan!.recoveryHoldRevision + 1 ? 1 : 0;
      if (revision !== null) return 0;
      if (event === 'RECOVERY_OPERATION_COMMITTED') return 1;
      const expected = { CANCEL_UNSENT_MODEL: 'RECOVERY_MODEL_CANCELLED_UNSENT', DISCARD_SETTLED_RESPONSE: 'RECOVERY_MODEL_RESPONSE_DISCARDED',
        COMPLETE_SAFETY_STOP: 'RECOVERY_SAFETY_STOP_COMPLETED', REFLECT_RECORDED_RESULT: 'RECOVERY_RESULT_REFLECTED' }[intent.plan!.operationKind];
      return event === expected ? 1 : 0;
    });
    this.#db.function('map_recovery_start', (workflow, route, target) => {
      if (this.#context?.kind !== 'lease' || !this.#active || this.#context.record.handle.workflowRunId !== workflow) return -1;
      try { if(this.#bounded.startAllowed(this.#active,String(workflow),String(route))) return 1;
        return recoveryStartAllowed(this.#active, String(workflow), String(route), String(target),
        route === 'REGISTER' && this.#planApplicationCurrent(this.#active, String(workflow))) ? 1 : 0; }
      catch { return 0; }
    });
    this.#db.function('map_recovery_now', () => {
      const now = this.#now(), monotonic = performance.now();
      if (!Number.isSafeInteger(now) || now < this.#timeAnchor.wall - 1000
        || Math.abs((now - this.#timeAnchor.wall) - (monotonic - this.#timeAnchor.monotonic)) > 2000) return -1;
      this.#timeAnchor = { wall: now, monotonic }; return now;
    });
    this.#db.function('map_recovery_actor', () => this.#recoveryIntent?.actorId ?? null);
    this.#db.function('map_recovery_management', (workflow, kind, id) => {
      const intent = this.#recoveryIntent;
      return this.#context?.kind === 'lease' && intent?.workflowRunId === workflow && intent.kind === kind && intent.id === id ? 1 : 0;
    });
    this.#db.function('map_recovery_audit', (workflow, event, plan, authorization, revision) => {
      const intent = this.#recoveryIntent;
      if (this.#context?.kind !== 'lease' || !intent || intent.workflowRunId !== workflow) return 0;
      if (intent.kind === 'HOLD') return event === 'RECOVERY_HOLD_CREATED' && revision === 1 && plan === null && authorization === null ? 1 : 0;
      const kind = { CREATE_PLAN: 'RECOVERY_PLAN_CREATED', INVALIDATE: 'RECOVERY_PLAN_INVALIDATED', AUTHORIZE: 'RECOVERY_AUTHORIZED', REVOKE: 'RECOVERY_REVOKED' }[intent.kind];
      return event === kind && plan === intent.planId && revision === null
        && authorization === (['AUTHORIZE','REVOKE'].includes(intent.kind) ? intent.id : null) ? 1 : 0;
    });
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
      if (!record?.valid || record.databaseIdentity !== this.#databaseIdentity || lease.runtimeInstanceId !== runtimeInstanceId) this.#fenced();
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
        const record: LeaseRecord = { handle: undefined!, capabilityHash, valid: true, databaseIdentity: this.#databaseIdentity, expiresAt: metadata.expiresAt,
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
