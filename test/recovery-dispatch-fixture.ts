import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import type { TestContext } from 'node:test';
import { DurableDatabase, SqliteCoordinationRunnerStore, DurableExecutionCoordinator } from '../services/coordination/durable/index.ts';
import { SqliteRunnerEvidenceStore } from '../services/coordination/durable/evidenceStore.ts';
import { ControlledRecoveryPlanner, ControlledRecoveryAuthorizer, RecoveryDispatchCoordinator, controlledScopeOf } from '../services/coordination/durable/recoveryDispatchCoordinator.ts';
import { RecoveryDispatchReader } from '../services/coordination/durable/recoveryDispatchReader.ts';
import type { ControlledTiming } from '../services/coordination/durable/controlledRecoveryTypes.ts';
import type { RecoveryAuthorizationPolicy } from '../services/coordination/durable/recoveryDecisionTypes.ts';
import type { ReconciliationOptions } from '../services/coordination/durable/reconciliationTypes.ts';
import type { RunnerExecutionResult, RunnerExecutionContext } from '../services/coordination/runner/types.ts';
import { testIdentityProvider } from './recovery-authorization-fixture.ts';
import { executionSeed, registration, record, clock } from './durable-execution-fixture.ts';
import { recoveryContents } from './recovery-execution-fixture.ts';

export const controlledTables=['recovery_controlled_plans','recovery_controlled_grants','recovery_dispatch_intents','recovery_dispatch_grants','recovery_dispatch_receipts','recovery_dispatch_evidence'];
export const dispatchContents=(raw:DatabaseSync)=>({...recoveryContents(raw),...Object.fromEntries(controlledTables.map(table=>[table,raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))});
export function dispatchFixture(t:Pick<TestContext,'after'>,options:{policy?:RecoveryAuthorizationPolicy;timing?:Partial<ControlledTiming>;risk?:'ALLOW'|'DENY'|'NEEDS_USER';path?:string;dir?:string;maxWallTimeMs?:number;reconciliation?:ReconciliationOptions}={}){
  const dir=options.dir??mkdtempSync(join(tmpdir(),'map-controlled-')),path=options.path??join(dir,'db.sqlite');
  const identity=testIdentityProvider(),credential=identity.credential(),approver=identity.credential('approver',['RECOVERY_APPROVER']);
  const calls={execute:0,plan:0,verify:0};
  let hook:(context:RunnerExecutionContext)=>Promise<RunnerExecutionResult>=async()=>({status:'succeeded',summary:'Synthetic result.'});
  const executor={id:'test',prepare:async()=>record.action,execute:(_action:unknown,context:RunnerExecutionContext)=>{calls.execute++;return hook(context);}};
  const binding={executor,contractVersion:'test:1',implementationDigest:'a'.repeat(64),sideEffectRetries:'disabled' as const};
  const registry={get:(id:string)=>id==='test'?binding:undefined};
  const db=new DurableDatabase({path,recoveryIdentityVerifier:identity.verifier,recoveryAuthorizationPolicy:options.policy,controlledExecutors:registry,controlledTiming:options.timing,reconciliation:options.reconciliation});
  const admin=new SqliteCoordinationRunnerStore(db);admin.createWorkflow(executionSeed(options.risk??'ALLOW','run',{maxWallTimeMs:options.maxWallTimeMs??Number.MAX_SAFE_INTEGER}));
  const manager=db.createLeaseManager({ttlMs:120_000});let lease=manager.acquire('run'),store=admin.withLease(lease);
  const coordinator=new DurableExecutionCoordinator(store,{get:()=>executor},{clock});
  const r=registration(store);coordinator.registerAction(record,r.expected,r.sessionEvent,r.taskEvent);
  const raw=new DatabaseSync(path);raw.exec('PRAGMA foreign_keys=ON');
  t.after(()=>{raw.close();db.close();rmSync(dir,{recursive:true,force:true});});
  const api=()=>({planner:new ControlledRecoveryPlanner(db,lease),authorizer:new ControlledRecoveryAuthorizer(db,lease),coordinator:new RecoveryDispatchCoordinator(db,lease),reader:new RecoveryDispatchReader(db)});
  const plan=()=>api().planner.createPlan({workflowRunId:'run',actionId:'action'},credential);
  const authorize=(p:ReturnType<typeof plan>,token:unknown=approver,ttlMs?:number)=>api().authorizer.authorize(p.planId,controlledScopeOf(p),token,ttlMs);
  const execute=(p:ReturnType<typeof plan>,signal?:AbortSignal)=>api().coordinator.executeAuthorized(p.planId,credential,{signal});
  const reacquire=()=>{manager.release(lease);lease=manager.acquire('run');store=admin.withLease(lease);return lease;};
  const evidence=new SqliteRunnerEvidenceStore(db);
  const put=(content:unknown,owner={workflowRunId:'run',sessionId:'session',taskId:'task',actionId:'action'})=>evidence.withOwner(owner,()=>evidence.put({kind:'test',content,createdAt:Date.now()}),lease);
  return {dir,path,db,raw,identity,credential,approver,binding,registry,calls,manager,get lease(){return lease;},get store(){return store;},coordinator,plan,authorize,execute,api,reacquire,put,
    hook(fn:typeof hook){hook=fn;}};
}
