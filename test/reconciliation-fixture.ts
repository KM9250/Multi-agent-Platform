import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { TestContext } from 'node:test';
import { DurableDatabase, type DurableDatabaseOptions } from '../services/coordination/durable/db.ts';
import { SqliteCoordinationRunnerStore } from '../services/coordination/durable/durableCoordinationStore.ts';
import { DurableExecutionCoordinator } from '../services/coordination/durable/executionCoordinator.ts';
import { ModelCallLedger } from '../services/coordination/durable/modelCallLedger.ts';
import { ReconciliationEvidenceService } from '../services/coordination/durable/reconciliationEvidenceStore.ts';
import { readReconciliationTarget } from '../services/coordination/durable/reconciliationVerifier.ts';
import { ReconciliationPlanner } from '../services/coordination/durable/reconciliationPlanner.ts';
import { ReconciliationAuthorizer, reconciliationScopeOf } from '../services/coordination/durable/reconciliationAuthorizer.ts';
import { ReconciliationExecutor } from '../services/coordination/durable/reconciliationExecutor.ts';
import { canonicalJson } from '../services/coordination/durable/integrity.ts';
import type { ReconciliationClaim, ReconciliationOptions, ReconciliationPolicy, ReconciliationTarget, ReconciliationVerifierBinding, ReconciliationVerifierRequest, ReconciliationVerifierResult } from '../services/coordination/durable/reconciliationTypes.ts';
import { testIdentityProvider } from './recovery-authorization-fixture.ts';
import { executionSeed, registration, record, clock } from './durable-execution-fixture.ts';
import { createRunnerEvent } from '../services/coordination/runner/eventFactory.ts';

export const syntheticSource = Object.freeze({ authorityDomain:'synthetic-domain',sourceSystem:'synthetic-receipts',account:'synthetic-account',environment:'test' });
export const completeUsage = Object.freeze({llmCalls:1,inputTokens:200,outputTokens:200,estimatedCost:0.0004});
export const completeClaim = ():ReconciliationClaim => ({kind:'MODEL_USAGE',completeness:'COMPLETE',finality:'FINAL',usage:{...completeUsage},pricingId:'synthetic-price-v1',currency:'USD',responseState:'NOT_APPLICABLE_VERIFIED',requestClosed:true,evidenceFields:['receipt.usage','receipt.target','receipt.finality']});
export const actionClaim = (outcome:ReconciliationClaim['outcome']='EXECUTED_FINAL', result=true):ReconciliationClaim => ({kind:'ACTION_OUTCOME',completeness:'COMPLETE',finality:'FINAL',outcome,requestClosed:true,exhaustive:true,evidenceFields:['receipt.target','receipt.effect','receipt.finality'],...(result?{result:{status:outcome==='EXECUTED_FINAL'?'succeeded' as const:'failed' as const,summary:'Synthetic final outcome'}}:{})});

/** Keys exist only in the fixture/temporary process harness; no production signer is exported. */
export function signedSyntheticVerifier(pair: {privateKey:KeyObject;publicKey:KeyObject}=generateKeyPairSync('ed25519')) {
  const counts={verifier:0,action:0,model:0,lookup:0};
  let hook:((request:ReconciliationVerifierRequest,result:ReconciliationVerifierResult)=>unknown)|undefined;
  const binding:ReconciliationVerifierBinding={verifierId:'synthetic-ed25519',contractVersion:'synthetic-receipt:1',implementationDigest:'c'.repeat(64),...syntheticSource,
    claims:['ACTION_OUTCOME','MODEL_USAGE'],lookup:'NONE',usageDefinition:'inclusive-input-cache-output-reasoning-usd-micros-v1',pricingIds:['synthetic-price-v1'],
    verify(request){counts.verifier++;const body=request.body as {payload:ReconciliationVerifierResult;signature:string};
      if(!body||typeof body.signature!=='string'||!body.payload||!verify(null,Buffer.from(canonicalJson(body.payload)),pair.publicKey,Buffer.from(body.signature,'base64')))throw Error('SYNTHETIC_SIGNATURE_INVALID');
      const p=body.payload;if(Object.entries(syntheticSource).some(([key,value])=>p.source?.[key]!==value))throw Error('SYNTHETIC_SOURCE_INVALID');
      return hook?hook(request,p) as ReconciliationVerifierResult:p;
    }};
  return {pair,counts,binding,sign(payload:ReconciliationVerifierResult){return {payload,signature:sign(null,Buffer.from(canonicalJson(payload)),pair.privateKey).toString('base64')};},hook(fn:typeof hook){hook=fn;}};
}
export function reconciliationContents(raw:DatabaseSync) {
  return Object.fromEntries(raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(row=>{const name=String(row.name);return [name,raw.prepare(`SELECT * FROM "${name.replaceAll('"','""')}" ORDER BY rowid`).all()];}));
}
export const tableCount=(raw:DatabaseSync,table:string)=>Number(raw.prepare(`SELECT count(*) n FROM "${table.replaceAll('"','""')}"`).get()!.n);
export interface ReconciliationFixtureConfig { reconciliation?:Partial<ReconciliationOptions>; keyPair?:{privateKey:KeyObject;publicKey:KeyObject}; limits?:ReconciliationOptions['limits']; policy?:Partial<ReconciliationPolicy>; }
export function reconciliationFixture(t:Pick<TestContext,'after'>,config:ReconciliationFixtureConfig={},location?:{dir:string;path:string;reopen?:boolean}) {
  const dir=location?.dir??mkdtempSync(join(tmpdir(),'map-reconciliation-')),path=location?.path??join(dir,'db.sqlite');
  const identity=testIdentityProvider(),credential=identity.credential('operator',['RECOVERY_OPERATOR']),approver=identity.credential('approver',['RECOVERY_APPROVER']);
  let accessRule:ReconciliationPolicy['canAccess']=config.policy?.canAccess??(()=>true),sendRule:NonNullable<ReconciliationPolicy['canSend']>=config.policy?.canSend??(()=>true),contentRule:ReconciliationPolicy['inspectContent']=config.policy?.inspectContent??(()=>true);
  const synthetic=signedSyntheticVerifier(config.keyPair),policy:ReconciliationPolicy={version:'synthetic-policy:1',authorityDomain:syntheticSource.authorityDomain,
    approvals:{RECORD_VERIFIED_ACTION_OUTCOME:{minimumApprovers:1,forbidSelfApproval:true},SETTLE_VERIFIED_MODEL_USAGE:{minimumApprovers:1,forbidSelfApproval:true},APPLY_RECONCILED_ACTION_RESULT:{minimumApprovers:1,forbidSelfApproval:true}},
    ...config.policy,canAccess:(...args)=>accessRule(...args),canSend:(...args)=>sendRule(...args),inspectContent:(...args)=>contentRule(...args)};
  let registered=true;
  const options:DurableDatabaseOptions={path,recoveryIdentityVerifier:identity.verifier,reconciliation:{policy,verifiers:{get:id=>registered&&id===synthetic.binding.verifierId?synthetic.binding:undefined},limits:config.limits,...config.reconciliation}};
  const db=new DurableDatabase(options),admin=new SqliteCoordinationRunnerStore(db);
  if(!location?.reopen)admin.createWorkflow(executionSeed('ALLOW','run',{maxWallTimeMs:Number.MAX_SAFE_INTEGER,maxLlmCalls:100,maxInputTokens:10000,maxOutputTokens:10000,maxEstimatedCost:1}));
  const manager=db.createLeaseManager({ttlMs:120000});let lease=location?.reopen?undefined!:manager.acquire('run');
  const raw=new DatabaseSync(path);raw.exec('PRAGMA foreign_keys=ON');let serial=0;
  t.after(()=>{raw.close();db.close();if(!location)rmSync(dir,{recursive:true,force:true});});
  const api=()=>({evidence:new ReconciliationEvidenceService(db,lease),planner:new ReconciliationPlanner(db,lease),authorizer:new ReconciliationAuthorizer(db,lease),executor:new ReconciliationExecutor(db,lease)});
  const store=()=>admin.withLease(lease);
  const model=(id='model',state:'RESERVED'|'DISPATCH_INTENT'|'UNKNOWN'|'PARTIAL'|'SETTLED'='DISPATCH_INTENT')=>{
    const snapshot=store().getSnapshot('run'),x={workflowRunId:'run',modelCallId:id,attemptId:`${id}-attempt`,providerId:'test',modelId:'test',roundKey:id,phase:'PLAN' as const,
      requestCursor:snapshot.events.length,requestEventId:snapshot.events.at(-1)!.eventId,quote:{providerId:'test',modelId:'test',maxAttempts:1 as const,inputTokens:500,maxOutputTokens:500,maxEstimatedCost:0.001,pricingId:'synthetic-price-v1',conditions:'synthetic fixed USD price',requestDigest:'a'.repeat(64)}};
    const ledger=new ModelCallLedger(store(),clock);ledger.reserve(x);if(state!=='RESERVED')ledger.markDispatchIntent(x);
    if(state==='UNKNOWN'||state==='PARTIAL')ledger.markReviewRequired(x,state, state==='PARTIAL'?{inputTokens:1}:undefined);
    if(state==='SETTLED')ledger.settle(x,{...completeUsage},false);
    return {target:{workflowRunId:'run',targetKind:'MODEL' as const,targetId:id,attemptId:x.attemptId},x,ledger};
  };
  const action=(state:'DISPATCH_RESERVED'|'UNCERTAIN'|'FAILED'|'PREPARED'='DISPATCH_RESERVED')=>{
    const coordinator=new DurableExecutionCoordinator(store(),{get:()=>({id:'test',prepare:async()=>record.action,execute:async()=>{synthetic.counts.action++;return {status:'succeeded',summary:'Never called by reconciliation'};}})},{clock});
    const request=registration(store());coordinator.registerAction(record,request.expected,request.sessionEvent,request.taskEvent);
    const task=store().getSnapshot('run').tasks.task;
    if(state==='PREPARED')return {target:{workflowRunId:'run',targetKind:'ACTION' as const,targetId:'action',attemptId:'no-attempt'},coordinator,task};
    const {attemptId}=coordinator.reserveDispatch('run',task);
    return {target:{workflowRunId:'run',targetKind:'ACTION' as const,targetId:'action',attemptId},coordinator,task};
  };
  const historicalAction=async(state:'UNCERTAIN'|'FAILED')=>{
    const a=action(),result={status:state==='UNCERTAIN'?'uncertain' as const:'failed' as const,summary:'Historical synthetic result'};
    const resultRef=await a.coordinator.evidenceStore.withOwner({workflowRunId:'run',sessionId:'session',taskId:'task',actionId:'action'},()=>a.coordinator.evidenceStore.put({kind:'runner.execution',content:result,createdAt:clock.now()}),lease);
    a.coordinator.recordResult('run',a.task,a.target.attemptId,{...result,resultRef});
    if(state==='FAILED')a.coordinator.finalizeResult('run',a.task);return a;
  };
  const payload=(target:ReconciliationTarget,claim:ReconciliationClaim=target.targetKind==='MODEL'?completeClaim():actionClaim(),overrides:Partial<ReconciliationVerifierResult>={})=>{
    const state=db.read(tx=>readReconciliationTarget(tx,target));
    return {target,targetDigest:state.targetDigest,source:{...syntheticSource,externalOperationId:`external-${target.targetId}`,effectUnit:target.targetKind==='MODEL'?'model-usage':'action-effect'},claim,status:'VERIFIED' as const,reasonCodes:[],expiresAt:Date.now()+600000,...overrides};
  };
  const submit=(target:ReconciliationTarget,claim?:ReconciliationClaim,overrides?:Partial<ReconciliationVerifierResult>,token:unknown=credential,logicalId?:string)=>api().evidence.submitCandidate({target,body:synthetic.sign(payload(target,claim,overrides)),dataClass:'synthetic',contentType:'application/json',...(logicalId?{logicalId}:{})},token);
  const verified=async(target:ReconciliationTarget,claim?:ReconciliationClaim,overrides?:Partial<ReconciliationVerifierResult>)=>{const evidence=submit(target,claim,overrides);const verification=await api().evidence.verify({evidenceId:evidence.evidenceId,verifierId:synthetic.binding.verifierId},credential);return {evidence,verification};};
  const plan=(target:ReconciliationTarget,verificationId:string,operationKind:Parameters<ReconciliationPlanner['createPlan']>[0]['operationKind']=target.targetKind==='MODEL'?'SETTLE_VERIFIED_MODEL_USAGE':'RECORD_VERIFIED_ACTION_OUTCOME',token:unknown=credential,ttlMs?:number)=>api().planner.createPlan({target,verificationId,operationKind,...(ttlMs===undefined?{}:{ttlMs})},token);
  const authorize=(p:ReturnType<typeof plan>,token:unknown=approver,ttlMs?:number)=>api().authorizer.authorize(p.planId,reconciliationScopeOf(p),token,ttlMs);
  const execute=(p:ReturnType<typeof plan>,token:unknown=credential)=>api().executor.executeAuthorized(p.planId,token);
  const add=(type:Parameters<typeof createRunnerEvent>[1],value:unknown)=>store().append(createRunnerEvent(store().getSnapshot('run'),type,value,clock,{nextId:()=>`synthetic-event-${++serial}`}));
  const held=()=>{try{store().assertRecoveryExecution('run');}catch(error){if((error as {code?:string}).code!=='RECOVERY_HELD')throw error;}};
  return {dir,path,db,raw,admin,identity,credential,approver,options,policy,synthetic,counts:synthetic.counts,manager,api,model,action,historicalAction,payload,submit,verified,plan,authorize,execute,add,held,
    get lease(){return lease;},get store(){return store();},acl(fn:typeof accessRule){accessRule=fn;},sendAcl(fn:typeof sendRule){sendRule=fn;},contentAcl(fn:typeof contentRule){contentRule=fn;},register(value:boolean){registered=value;},reacquire(){if(lease)manager.release(lease);lease=manager.acquire('run');return lease;}};
}
export type ReconciliationFixture=ReturnType<typeof reconciliationFixture>;
export function assertRefusedWithoutEffects(f:ReconciliationFixture,fn:()=>unknown) {
  const before=reconciliationContents(f.raw),calls={...f.counts},snapshot=f.store.getSnapshot('run');
  assert.throws(fn);assert.deepEqual(reconciliationContents(f.raw),before);assert.deepEqual(f.counts,calls);assert.deepEqual(f.store.getSnapshot('run'),snapshot);
}
