import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { reconciliationFixture as fixture, reconciliationContents, tableCount, assertRefusedWithoutEffects, completeClaim, completeUsage, actionClaim } from './reconciliation-fixture.ts';
import { BoundedRuntime } from '../services/coordination/durable/recoveryContinuationCoordinator.ts';
import { ReconciliationReader } from '../services/coordination/durable/reconciliationReader.ts';
import { signedSyntheticVerifier } from './reconciliation-fixture.ts';
import { continuationFixture, content } from './continuation-fixture.ts';
import { ReconciliationEvidenceService } from '../services/coordination/durable/reconciliationEvidenceStore.ts';
import { readReconciliationTarget } from '../services/coordination/durable/reconciliationVerifier.ts';
import type { ReconciliationTarget } from '../services/coordination/durable/reconciliationTypes.ts';
import { syntheticSource } from './reconciliation-fixture.ts';

// PR36 audit IDs are distinct from the retained PR35 audit IDs.
test('PR36 F-01: adopted Action Outcome remains applicable with new approval after actual Verification expiry', async t => {
  const f=fixture(t),a=f.action(),{verification:v}=await f.verified(a.target,actionClaim(),{expiresAt:Date.now()+400});
  const p=f.plan(a.target,v.verificationId);f.authorize(p);const outcome=f.execute(p);
  const ledger=f.raw.prepare('SELECT * FROM execution_ledger').all(),old=f.api().evidence.readVerification(v.verificationId,f.credential);
  await delay(Math.max(0,v.expiresAt-Date.now())+30);
  const apply=f.plan(a.target,v.verificationId,'APPLY_RECONCILED_ACTION_RESULT');
  assertRefusedWithoutEffects(f,()=>f.execute(apply));const grant=f.authorize(apply),receipt=f.execute(apply);
  assert.equal(f.store.getSnapshot('run').tasks.task.status,'COMPLETED');
  assert.equal(tableCount(f.raw,'reconciled_action_applications'),1);
  assert.equal(f.raw.prepare('SELECT status FROM reconciliation_grants WHERE grant_id=?').get(grant.grantId)!.status,'CONSUMED');
  assert.deepEqual(f.raw.prepare('SELECT * FROM execution_ledger').all(),ledger);
  assert.deepEqual(f.api().evidence.readVerification(v.verificationId,f.credential),old);
  assert.deepEqual(f.api().executor.inspectReceipt(p.planId,f.credential),outcome);
  const before=reconciliationContents(f.raw);assert.deepEqual(f.execute(apply),receipt);assert.deepEqual(reconciliationContents(f.raw),before);
  assert.equal(f.counts.action,0);assert.equal(f.counts.model,0);
});

test('PR36 RT-01: conflicting normal response commits Usage and Drain before Abort outside parent authority',async t=>{
  const synthetic=signedSyntheticVerifier();synthetic.binding.pricingIds=['test:1'];
  const f=continuationFixture(t,{},undefined,{policy:{version:'synthetic-policy:1',authorityDomain:syntheticSource.authorityDomain,approvals:{},canAccess:()=>true,inspectContent:()=>true},verifiers:{get:()=>synthetic.binding}});
  let aborts=0,notifications=0,notifying=false;
  f.hook(async request=>{
    const row=f.raw.prepare("SELECT * FROM model_call_ledger WHERE state='DISPATCH_INTENT'").get()!;
    const target:ReconciliationTarget={workflowRunId:'run',targetKind:'MODEL',targetId:String(row.model_call_id),attemptId:String(row.attempt_id)};
    const service=new ReconciliationEvidenceService(f.db,f.lease),state=f.db.read(tx=>readReconciliationTarget(tx,target));
    const evidence=service.submitCandidate({target,contentType:'application/json',dataClass:'synthetic',body:synthetic.sign({target,targetDigest:state.targetDigest,
      source:{...syntheticSource,externalOperationId:'normal-active-conflict',effectUnit:'model-usage'},claim:{...completeClaim(),pricingId:'test:1',usage:{llmCalls:1,inputTokens:2,outputTokens:1,estimatedCost:0}},status:'VERIFIED',reasonCodes:[],expiresAt:Date.now()+600000})},f.credential);
    await service.verify({evidenceId:evidence.evidenceId,verifierId:synthetic.binding.verifierId},f.credential);
    return {value:{kind:'plan',artifact:content},usage:{llmCalls:1,inputTokens:1,outputTokens:1,estimatedCost:0},completeness:'COMPLETE'};
  });
  const plan=f.api().createPlan(f.input(),f.credential);
  const notify=BoundedRuntime.prototype.notifyReconciliationDrain,abort=AbortController.prototype.abort;
  BoundedRuntime.prototype.notifyReconciliationDrain=function(ids:readonly string[]) {
    if(ids.length){notifications++;assert.equal(f.raw.prepare('SELECT status FROM recovery_invocations').get()!.status,'DRAINING');
      assert.equal(tableCount(f.raw,'reconciliation_disputes'),1);assert.equal(tableCount(f.raw,'model_usage_authorities'),1);
      assert.equal(f.raw.prepare('SELECT hold_state FROM recovery_workflow_control').get()!.hold_state,'HELD');
      assert.throws(()=>f.store.writeWorkflow('run',()=>{}),{code:'RECOVERY_UNAUTHORIZED'});}
    notifying=ids.length>0;try{return notify.call(this,ids);}finally{notifying=false;}
  };
  // The provider's per-call signal is also aborted during ordinary cleanup. Observe
  // the Invocation controller specifically inside the committed Drain notification.
  AbortController.prototype.abort=function(reason?:unknown){if(notifying)aborts++;return abort.call(this,reason);};
  let result;try{result=await f.api().startAuthorized(plan.planId,f.credential);}finally{BoundedRuntime.prototype.notifyReconciliationDrain=notify;AbortController.prototype.abort=abort;}
  assert.equal(notifications,1);assert.equal(aborts,1);assert.equal(result.artifact,undefined);assert.equal(tableCount(f.raw,'planning_artifacts'),0);
  assert.equal(tableCount(f.raw,'model_usage_authorities'),1);assert.equal(tableCount(f.raw,'reconciliation_disputes'),1);
  assert.equal(JSON.parse(String(f.raw.prepare('SELECT usage_json FROM model_usage_authorities').get()!.usage_json)).inputTokens,1);
  assert.equal(f.counts.draft,1);assert.equal(f.counts.action,0);assert.equal(synthetic.counts.verifier,1);
});

for(const reason of ['UNADOPTED','REVOKED','DISPUTED','OTHER_VERIFICATION','OTHER_ATTEMPT'] as const)
test(`PR36 F-01: expired evidence ${reason} cannot bypass adoption, trust or target checks`,async t=>{
  let revoked=false;const issuer=signedSyntheticVerifier();
  const f=fixture(t,{keyPair:issuer.pair,reconciliation:{verifiers:{get:()=>issuer.binding,isRevoked:()=>revoked}}}),a=f.action();
  const {verification:v}=await f.verified(a.target,actionClaim(),{expiresAt:Date.now()+400});
  if(reason!=='UNADOPTED'){const p=f.plan(a.target,v.verificationId);f.authorize(p);f.execute(p);}
  await delay(Math.max(0,v.expiresAt-Date.now())+20);
  let id=v.verificationId,target=a.target;
  if(reason==='REVOKED')revoked=true;
  if(reason==='DISPUTED')await f.verified(a.target,actionClaim('NOT_EXECUTED_FINAL'));
  if(reason==='OTHER_VERIFICATION')id=(await f.verified(a.target,actionClaim(),{source:{...v.source,externalOperationId:'another-effect'}})).verification.verificationId;
  if(reason==='OTHER_ATTEMPT')target={...target,attemptId:'another-attempt'};
  assertRefusedWithoutEffects(f,()=>f.plan(target,id,reason==='UNADOPTED'?'RECORD_VERIFIED_ACTION_OUTCOME':'APPLY_RECONCILED_ACTION_RESULT'));
  assert.equal(tableCount(f.raw,'reconciled_action_applications'),0);assert.equal(f.counts.action,0);
});

for(const fault of ['BEFORE_COMMIT','LOST_ACK'] as const)
test(`PR36 F-01: expired adopted Outcome application ${fault} preserves atomic grants and task event`,async t=>{
  const f=fixture(t),a=f.action(),{verification:v}=await f.verified(a.target,actionClaim(),{expiresAt:Date.now()+400});
  const outcome=f.plan(a.target,v.verificationId);f.authorize(outcome);f.execute(outcome);
  await delay(Math.max(0,v.expiresAt-Date.now())+20);
  const p=f.plan(a.target,v.verificationId,'APPLY_RECONCILED_ACTION_RESULT');f.authorize(p);const before=reconciliationContents(f.raw);
  if(fault==='BEFORE_COMMIT') {
    f.raw.exec("CREATE TRIGGER pr36_apply_audit_fault BEFORE INSERT ON reconciliation_audit WHEN NEW.event_kind='RECONCILIATION_ACTION_RESULT_APPLIED' BEGIN SELECT RAISE(ABORT,'injected'); END");
    assert.throws(()=>f.execute(p));assert.deepEqual(reconciliationContents(f.raw),before);f.raw.exec('DROP TRIGGER pr36_apply_audit_fault');
  } else {
    const exec=DatabaseSync.prototype.exec;let lost=false;
    DatabaseSync.prototype.exec=function(sql:string){const result=exec.call(this,sql);if(sql==='COMMIT'&&!lost&&Number(this.prepare('SELECT count(*) n FROM reconciled_action_applications').get()!.n)===1){lost=true;throw Error('synthetic ACK loss');}return result;};
    try{assert.equal(f.execute(p).status,'COMMITTED');}finally{DatabaseSync.prototype.exec=exec;}
    assert.equal(lost,true);
  }
  assert.equal(f.execute(p).status,'COMMITTED');assert.equal(tableCount(f.raw,'reconciled_action_applications'),1);
  assert.equal(f.store.getSnapshot('run').events.filter(e=>e.type==='TaskCompleted').length,1);assert.equal(f.counts.action,0);
});

for(const fact of ['CANDIDATE','PARTIAL','OTHER_TARGET'] as const)
test(`PR36 RT-01: ${fact} does not change another Attempt's Hold when normal Usage arrives`,async t=>{
  const f=fixture(t);
  if(fact==='OTHER_TARGET'){const other=f.model('other','SETTLED');await f.verified(other.target);}
  const m=f.model(),claim={...completeClaim(),usage:{...completeUsage,estimatedCost:0.0005}};
  if(fact==='CANDIDATE')f.submit(m.target,claim);
  else if(fact==='PARTIAL')await f.verified(m.target,{...claim,completeness:'PARTIAL'});
  const control=f.raw.prepare('SELECT * FROM recovery_workflow_control').all();m.ledger.settle(m.x,{...completeUsage,estimatedCost:fact==='OTHER_TARGET'?0.0005:0.0004},false);
  assert.equal(tableCount(f.raw,'reconciliation_disputes'),0);assert.deepEqual(f.raw.prepare('SELECT * FROM recovery_workflow_control').all(),control);
  assert.equal(tableCount(f.raw,'model_usage_authorities'),fact==='OTHER_TARGET'?2:1);assert.equal(f.counts.model,0);
});

for(const fault of ['AUDIT_ROLLBACK','LOST_ACK'] as const)
test(`PR36 RT-01: normal Settlement conflict ${fault} keeps accounting and Dispute atomic`,async t=>{
  const f=fixture(t),m=f.model();await f.verified(m.target,{...completeClaim(),usage:{...completeUsage,estimatedCost:0.0005}});
  const before=reconciliationContents(f.raw);
  if(fault==='AUDIT_ROLLBACK') {
    f.raw.exec("CREATE TRIGGER pr36_conflict_fault BEFORE INSERT ON reconciliation_audit WHEN NEW.event_kind='RECONCILIATION_DISPUTE_RECORDED' BEGIN SELECT RAISE(ABORT,'injected'); END");
    assert.throws(()=>m.ledger.settle(m.x,{...completeUsage},false));assert.deepEqual(reconciliationContents(f.raw),before);
    f.raw.exec('DROP TRIGGER pr36_conflict_fault');
  } else {
    const exec=DatabaseSync.prototype.exec;let lost=false;
    DatabaseSync.prototype.exec=function(sql:string){const result=exec.call(this,sql);if(sql==='COMMIT'&&!lost&&Number(this.prepare('SELECT count(*) n FROM reconciliation_disputes').get()!.n)===1){lost=true;throw Error('synthetic normal ACK loss');}return result;};
    try{assert.equal(m.ledger.settle(m.x,{...completeUsage},false).state,'SETTLED');}finally{DatabaseSync.prototype.exec=exec;}
    assert.equal(lost,true);
  }
  m.ledger.settle(m.x,{...completeUsage},false);const settled=reconciliationContents(f.raw);
  m.ledger.settle(m.x,{...completeUsage},false);assert.deepEqual(reconciliationContents(f.raw),settled);
  assert.equal(tableCount(f.raw,'reconciliation_disputes'),1);assert.equal(tableCount(f.raw,'model_usage_authorities'),1);assert.equal(f.counts.model,0);
});

for(const denied of ['OUTPUT','VIEW_CASE','USE_EVIDENCE','OUTPUT_THROW','RECEIPT_METADATA'] as const)for(const ack of [false,true])
test(`PR36 RT-02: ${ack?'lost ACK':'first return'} rechecks current ${denied} after verification commits`,async t=>{
  let deny=false,allowed=false;const f=fixture(t,{policy:{
    canAccess:(_a,_t,p)=>allowed||!deny||!['VIEW_CASE','USE_EVIDENCE'].includes(denied)||p!==denied,
    inspectContent:(value,c)=>{
      if(c.stage==='NORMALIZED')deny=true;
      if(c.stage!=='OUTPUT'||allowed||!deny)return true;
      if(denied==='OUTPUT_THROW')throw Error('synthetic private claim must not escape');
      if(denied==='RECEIPT_METADATA')return !(value as {verificationId?:string}).verificationId;
      return denied!=='OUTPUT';
    },
  }}),m=f.model(),e=f.submit(m.target),input={evidenceId:e.evidenceId,verifierId:f.synthetic.binding.verifierId};
  const exec=DatabaseSync.prototype.exec;let lost=false;
  if(ack)DatabaseSync.prototype.exec=function(sql:string){const result=exec.call(this,sql);if(sql==='COMMIT'&&!lost&&Number(this.prepare('SELECT count(*) n FROM reconciliation_verifications').get()!.n)===1){lost=true;throw Error('synthetic verification ACK loss');}return result;};
  try{await assert.rejects(f.api().evidence.verify(input,f.credential),(error:Error&{code?:string})=>{assert.equal(error.code,'RECOVERY_UNAUTHORIZED');assert.equal(error.message,'RECOVERY_UNAUTHORIZED');return true;});}finally{DatabaseSync.prototype.exec=exec;}
  assert.equal(lost,ack);assert.equal(tableCount(f.raw,'reconciliation_verifications'),1);
  const id=String(f.raw.prepare('SELECT verification_id FROM reconciliation_verifications').get()!.verification_id),before=reconciliationContents(f.raw);
  assert.throws(()=>f.api().evidence.readVerification(id,f.credential),{code:'RECOVERY_UNAUTHORIZED'});
  await assert.rejects(f.api().evidence.verify(input,f.credential),{code:'RECOVERY_UNAUTHORIZED'});
  assert.deepEqual(reconciliationContents(f.raw),before);assert.equal(f.counts.verifier,1);
  allowed=true;assert.equal((await f.api().evidence.verify(input,f.credential)).verificationId,id);
  assert.deepEqual(reconciliationContents(f.raw),before);assert.equal(f.counts.verifier,1);assert.equal(f.counts.model,0);assert.equal(f.counts.action,0);
});

for(const first of ['NORMAL','VERIFIED'] as const)for(const different of [false,true])
test(`PR36 RT-01: ${first} first, ${different?'different':'same'} Model Usage preserves one authority and consistent Dispute`,async t=>{
  const f=fixture(t),m=f.model(),claim={...completeClaim(),usage:{...completeUsage,estimatedCost:different?0.0005:0.0004}};
  let verificationId='';
  const verify=async()=>{verificationId=(await f.verified(m.target,claim)).verification.verificationId;};
  let plan:ReturnType<typeof f.plan>|undefined;
  if(first==='VERIFIED'){await verify();plan=f.plan(m.target,verificationId);f.authorize(plan);}
  m.ledger.settle(m.x,{...completeUsage},false);if(first==='NORMAL')await verify();
  assert.equal(tableCount(f.raw,'reconciliation_disputes'),different?1:0);
  assert.equal(tableCount(f.raw,'model_usage_authorities'),1);assert.equal(tableCount(f.raw,'reconciled_model_usages'),0);
  assert.equal(m.ledger.getBudgetPosition('run').committed.costMicros,400);
  assert.equal(f.store.getSnapshot('run').events.filter(e=>e.type==='UsageRecorded').length,1);
  const reader=new ReconciliationReader(f.db).inspect(m.target,f.credential);
  assert.equal(reader.obligations.some(o=>o.reason==='DISPUTED'),different);assert.equal(reader.executionAllowed,false);
  if(different){assert.equal(reader.holdState,'HELD');assert.throws(()=>f.store.assertRecoveryExecution('run'));}
  if(plan){assertRefusedWithoutEffects(f,()=>f.execute(plan!));assert.equal(f.raw.prepare('SELECT status FROM reconciliation_grants WHERE plan_id=?').get(plan.planId)!.status,'AUTHORIZED');}
  assert.equal(f.counts.action,0);assert.equal(f.counts.model,0);
});

for(const first of ['NORMAL','VERIFIED'] as const)for(const different of [false,true])
test(`PR36 RT-01: ${first} first, ${different?'different':'same'} Action fact detects reverse-order contradictions`,async t=>{
  const f=fixture(t),a=f.action();
  if(first==='VERIFIED')await f.verified(a.target,actionClaim());
  const result={status:different?'failed' as const:'succeeded' as const,summary:'Synthetic normal result'};
  const resultRef=await a.coordinator.evidenceStore.withOwner({workflowRunId:'run',sessionId:'session',taskId:'task',actionId:'action'},()=>a.coordinator.evidenceStore.put({kind:'runner.execution',content:result,createdAt:Date.now()}),f.lease);
  a.coordinator.recordResult('run',a.task,a.target.attemptId,{...result,resultRef});
  if(first==='NORMAL')await f.verified(a.target,actionClaim());
  assert.equal(tableCount(f.raw,'reconciliation_disputes'),different?1:0);
  assert.equal(tableCount(f.raw,'execution_results'),1);assert.equal(tableCount(f.raw,'reconciled_action_outcomes'),0);
  const reader=new ReconciliationReader(f.db).inspect(a.target,f.credential);
  assert.equal(reader.obligations.some(o=>o.reason==='DISPUTED'),different);
  if(different){assert.equal(reader.holdState,'HELD');assert.throws(()=>f.store.assertRecoveryExecution('run'));}
  assert.equal(f.counts.action,0);assert.equal(f.counts.model,0);
});

for(const denied of ['OUTPUT','VIEW_CASE'] as const)
test(`PR36 RT-02: initial verification ${denied} denial preserves stored fact without disclosing it`,async t=>{
  let allow=false;const f=fixture(t,{policy:{canAccess:(_a,_t,p)=>p!=='VIEW_CASE'||denied!=='VIEW_CASE'||allow,inspectContent:(_v,c)=>c.stage!=='OUTPUT'||denied!=='OUTPUT'||allow}});
  const m=f.model(),e=f.submit(m.target),input={evidenceId:e.evidenceId,verifierId:f.synthetic.binding.verifierId};
  await assert.rejects(f.api().evidence.verify(input,f.credential),{code:'RECOVERY_UNAUTHORIZED'});
  assert.equal(tableCount(f.raw,'reconciliation_verifications'),1);const id=String(f.raw.prepare('SELECT verification_id FROM reconciliation_verifications').get()!.verification_id);
  const before=reconciliationContents(f.raw);
  await assert.rejects(f.api().evidence.verify(input,f.credential),{code:'RECOVERY_UNAUTHORIZED'});
  assert.throws(()=>f.api().evidence.readVerification(id,f.credential),{code:'RECOVERY_UNAUTHORIZED'});
  assert.deepEqual(reconciliationContents(f.raw),before);assert.equal(f.counts.verifier,1);
  allow=true;assert.equal(f.api().evidence.readVerification(id,f.credential).verificationId,id);
  assert.equal((await f.api().evidence.verify(input,f.credential)).verificationId,id);
  assert.deepEqual(reconciliationContents(f.raw),before);assert.equal(f.counts.verifier,1);
  assert.equal(f.counts.action,0);assert.equal(f.counts.model,0);
});
