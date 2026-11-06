import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import type { TestContext } from 'node:test';
import { DurableDatabase, SqliteCoordinationRunnerStore, DurableExecutionCoordinator, ModelCallLedger } from '../services/coordination/durable/index.ts';
import { SafeRecoveryPlanner, SafeRecoveryAuthorizer, SafeRecoveryExecutor } from '../services/coordination/durable/safeRecoveryExecutor.ts';
import { executionScopeOf } from '../services/coordination/durable/safeRecoveryStore.ts';
import type { RecoveryAuthorizationPolicy } from '../services/coordination/durable/recoveryDecisionTypes.ts';
import type { WorkflowBudget } from '../services/coordination/types.ts';
import { testIdentityProvider } from './recovery-authorization-fixture.ts';
import { executionSeed, registration, record, clock } from './durable-execution-fixture.ts';
import { createRunnerEvent } from '../services/coordination/runner/eventFactory.ts';

export const recoveryTables = ['workflow_seeds','journal_events','pending_actions','execution_ledger','execution_results','runner_evidence',
  'model_call_ledger','model_call_attempts','recovery_holds','recovery_execution_plans','recovery_execution_grants',
  'recovery_execution_operations','recovery_operation_grants','recovery_hold_transitions','recovery_model_resolutions','runtime_audit_events'] as const;
export const recoveryContents = (raw: DatabaseSync) => Object.fromEntries(recoveryTables.map(table => [table, raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
export function recoveryExecutionFixture(t: TestContext, policy: RecoveryAuthorizationPolicy = {}, location?: {dir:string;path:string}, budgets: Partial<WorkflowBudget> = {}) {
  const dir = location?.dir ?? mkdtempSync(join(tmpdir(), 'map-safe-recovery-')), path = location?.path ?? join(dir, 'db.sqlite');
  const identity = testIdentityProvider(), credential = identity.credential();
  const db = new DurableDatabase({ path, recoveryIdentityVerifier: identity.verifier, recoveryAuthorizationPolicy: policy });
  const admin = new SqliteCoordinationRunnerStore(db); admin.createWorkflow(executionSeed('ALLOW','run',budgets));
  const manager = db.createLeaseManager(); let lease = manager.acquire('run'), store = admin.withLease(lease);
  const raw = new DatabaseSync(path); raw.exec('PRAGMA foreign_keys=ON');
  t.after(() => { raw.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  const calls = { execute: 0 };
  const rebind = () => ({ planner: new SafeRecoveryPlanner(db, lease), authorizer: new SafeRecoveryAuthorizer(db, lease), executor: new SafeRecoveryExecutor(db, lease) });
  const held = () => { try { store.assertRecoveryExecution('run'); } catch (e) { if ((e as {code?:string}).code !== 'RECOVERY_HELD') throw e; } };
  const reacquire = () => { manager.release(lease); lease = manager.acquire('run'); store = admin.withLease(lease); return lease; };
  const modelRequest = (id = 'model') => {
    const s = store.getSnapshot('run');
    return { workflowRunId: 'run', modelCallId: id, attemptId: `${id}-attempt`, providerId: 'test', modelId: 'test', roundKey: id, phase: 'PLAN' as const,
      requestCursor: s.events.length, requestEventId: s.events.at(-1)!.eventId,
      quote: { providerId: 'test', modelId: 'test', maxAttempts: 1 as const, inputTokens: 5, maxOutputTokens: 7, maxEstimatedCost: 0.000011, pricingId: 'test', conditions: 'test', requestDigest: 'a'.repeat(64) } };
  };
  const reserve = (id = 'model') => { const x = modelRequest(id); new ModelCallLedger(store, clock).reserve(x); return x; };
  const settled = () => { const x = reserve(), ledger = new ModelCallLedger(store, clock); ledger.markDispatchIntent(x);
    ledger.settle(x, {llmCalls:1,inputTokens:2,outputTokens:3,estimatedCost:0.000004}, true); return x; };
  const action = async (status: 'succeeded' | 'failed' | 'uncertain' = 'succeeded', prefix = 0) => {
    const coordinator = new DurableExecutionCoordinator(store, { get: () => ({ id: 'test', prepare: async () => record.action,
      execute: async () => { calls.execute++; return { status, summary: 'saved result' }; } }) }, { clock });
    const request = registration(store); coordinator.registerAction(record, request.expected, request.sessionEvent, request.taskEvent);
    const task = store.getSnapshot('run').tasks.task; await coordinator.dispatch('run', task);
    if (prefix >= 1) coordinator.finalizeResult('run', task);
    const append = (type: 'SessionResolved' | 'ProgressRecorded' | 'WorkflowBlocked', payload: unknown, key: string, sessionId?: string) =>
      store.append(createRunnerEvent(store.getSnapshot('run'), type, payload, clock, { nextId: () => `legacy-${type}` }, { sessionId, idempotencyKey: key }));
    if (prefix >= 2) append('SessionResolved', {outcome:'FAILED'}, 'runner:run:round:resolve', 'session');
    if (prefix >= 3) append('ProgressRecorded', {outcome:'ERROR',summary:'Runner round error.'}, 'runner:run:round:progress');
    if (prefix >= 4) append('WorkflowBlocked', {reason:'RUNNER_EXECUTION_UNCERTAIN:action'}, 'runner:run:round:execution-uncertain-block:action');
    return { coordinator, task };
  };
  const plan = (operationKind: 'REFLECT_RECORDED_RESULT'|'CANCEL_UNSENT_MODEL'|'DISCARD_SETTLED_RESPONSE'|'COMPLETE_SAFETY_STOP' = 'CANCEL_UNSENT_MODEL', targetId = 'model', ttlMs?: number) =>
    rebind().planner.createPlan({workflowRunId:'run',operationKind,targetId,ttlMs}, credential);
  const authorize = (p: ReturnType<typeof plan>, token: unknown = credential, ttlMs?: number) => rebind().authorizer.authorize(p.executionPlanId, executionScopeOf(p), token, ttlMs);
  const execute = (p: ReturnType<typeof plan>, token: unknown = credential) => rebind().executor.executeAuthorized(p.executionPlanId, token);
  return {dir,path,db,raw,admin,manager,get lease(){return lease;},get store(){return store;},identity,credential,calls,rebind,held,reacquire,modelRequest,reserve,settled,action,plan,authorize,execute};
}
/** Deliberate offline corruption for integrity-negative tests; never a production capability. */
export function corruptTable(raw: DatabaseSync, table: string, sql: string, ...parameters: (string|number|null)[]) {
  for (const r of raw.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name=?").all(table))
    raw.exec(`DROP TRIGGER "${String(r.name).replaceAll('"','""')}"`);
  raw.exec('PRAGMA foreign_keys=OFF; PRAGMA ignore_check_constraints=ON');
  try { raw.prepare(sql).run(...parameters); } finally { raw.exec('PRAGMA foreign_keys=ON; PRAGMA ignore_check_constraints=OFF'); }
}

/** Simulate a later trusted writer, then restore every guard before recovery validation. */
export function withoutTestTriggers(raw: DatabaseSync, names: string[], run: () => void): void {
  const triggers=names.map(name=>{const row=raw.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name);if(!row)throw Error(`Missing test trigger ${name}`);return row;});
  for(const row of triggers)raw.exec(`DROP TRIGGER "${String(row.name).replaceAll('"','""')}"`);
  try{run();}finally{for(const row of triggers)raw.exec(String(row.sql));}
}
