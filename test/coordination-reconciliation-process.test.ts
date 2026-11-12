import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reconciliationChild, processResult, ready } from './reconciliation-process-fixture.ts';
import { terminateChild } from './lease-fixture.ts';
function message(child:ChildProcess, field:string):Promise<Record<string,unknown>> {
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error(`Missing process message: ${field}`)),15_000);
    const receive=(value:Record<string,unknown>)=>{if(value[field]){clearTimeout(timer);child.off('message',receive);resolve(value);}};
    child.on('message',receive);child.once('error',error=>{clearTimeout(timer);reject(error);});
  });
}
function request(child:ChildProcess,command:string,field:string){const result=message(child,field);child.send(command);return result;}
for(const first of ['NORMAL','RECONCILED'] as const)test(`CR-09/RT-C17: independent normal and recovery processes ${first} wins with one authority and no duplicate accounting`,async t=>{
  const dir=mkdtempSync(join(tmpdir(),'map-reconciliation-race-')),path=join(dir,'db.sqlite');t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const owner=reconciliationChild([path,'race-owner','','keep']);t.after(()=>{if(owner.connected)terminateChild(owner);});const ownerResult=processResult(owner,40_000);await ready(owner);
  const challenger=reconciliationChild([path,'reconcile-race']);t.after(()=>{if(challenger.connected)terminateChild(challenger);});const challengerResult=processResult(challenger,40_000);await ready(challenger);
  if(first==='NORMAL') {
    const normal=await request(owner,'normal','done');assert.equal(normal.success,true,JSON.stringify(normal));
    await request(owner,'release','released');challenger.send('go');
  } else {
    await request(owner,'release','released');const normal=message(owner,'done');owner.send('normal');challenger.send('go');assert.equal((await normal).success,false);
  }
  const result=await challengerResult;assert.equal(result.timedOut,false,result.stderr);assert.equal(result.code,0,result.stderr);
  const outcome=result.messages.find((value:any)=>'success' in value) as {success:boolean};assert.equal(outcome.success,first==='RECONCILED',JSON.stringify(result.messages));
  owner.send('close');const ended=await ownerResult;assert.equal(ended.code,0,ended.stderr);
  const raw=new DatabaseSync(path);t.after(()=>raw.close());
  const authorities=raw.prepare('SELECT * FROM model_usage_authorities').all();assert.equal(authorities.length,1);assert.equal(authorities[0].authority,first);assert.equal(authorities[0].cost_micros,400);
  assert.equal(raw.prepare('SELECT count(*) n FROM reconciled_model_usages').get()!.n,first==='RECONCILED'?1:0);
  assert.equal(raw.prepare("SELECT count(*) n FROM journal_events WHERE event_type='UsageRecorded'").get()!.n,first==='NORMAL'?1:0);
  assert.equal(raw.prepare("SELECT count(*) n FROM reconciliation_grants WHERE status='CONSUMED'").get()!.n,first==='RECONCILED'?1:0);
  assert.equal(raw.prepare("SELECT count(*) n FROM reconciliation_grants WHERE status='AUTHORIZED'").get()!.n,1);
  assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(),[]);
});
test('CR-10/RT-C18: two process plans race across lease ownership, one succeeds and losing grant remains unconsumed',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'map-reconciliation-plan-race-')),path=join(dir,'db.sqlite');t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const owner=reconciliationChild([path,'race-owner','','keep']);t.after(()=>{if(owner.connected)terminateChild(owner);});const ownerResult=processResult(owner,40_000);await ready(owner);
  const challenger=reconciliationChild([path,'reconcile-race']);t.after(()=>{if(challenger.connected)terminateChild(challenger);});const challengerResult=processResult(challenger,40_000);await ready(challenger);
  await request(owner,'release','released');const rejected=message(owner,'done');owner.send('reconcile');challenger.send('go');assert.equal((await rejected).success,false);
  const result=await challengerResult;assert.equal(result.code,0,result.stderr);assert.equal((result.messages.find((value:any)=>value.success) as any)?.success,true,JSON.stringify(result.messages));
  owner.send('close');assert.equal((await ownerResult).code,0);
  const raw=new DatabaseSync(path);t.after(()=>raw.close());assert.equal(raw.prepare('SELECT count(*) n FROM reconciliation_operations').get()!.n,1);assert.equal(raw.prepare('SELECT count(*) n FROM model_usage_authorities').get()!.n,1);
  const grants=raw.prepare('SELECT status FROM reconciliation_grants ORDER BY rowid').all();assert.deepEqual(grants.map(row=>row.status),['AUTHORIZED','CONSUMED']);
});
test('CR-08: verifier response arriving after a real second process acquires ownership cannot write under old Generation',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'map-reconciliation-verifier-fence-')),path=join(dir,'db.sqlite');t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const owner=reconciliationChild([path,'verify-owner']);t.after(()=>{if(owner.connected)terminateChild(owner);});const ended=processResult(owner,40_000);await message(owner,'verifying');
  const raw=new DatabaseSync(path);t.after(()=>raw.close());const original=raw.prepare('SELECT * FROM model_call_ledger').all(),generation=Number(raw.prepare('SELECT generation FROM runtime_leases').get()!.generation);
  const challenger=reconciliationChild([path,'lease-race']);const other=processResult(challenger);await ready(challenger);
  await request(owner,'release','released');const acquired=message(challenger,'acquired');challenger.send('go');await acquired;assert.equal((await other).code,0);
  const response=await request(owner,'finish','done');assert.equal(response.success,false);assert.equal((await ended).code,0);
  assert.equal(raw.prepare('SELECT generation FROM runtime_leases').get()!.generation,generation+1);assert.deepEqual(raw.prepare('SELECT * FROM model_call_ledger').all(),original);
  for(const table of ['reconciliation_verifications','reconciliation_operations','reconciliation_grants','model_usage_authorities'])assert.equal(raw.prepare(`SELECT count(*) n FROM ${table}`).get()!.n,0,table);
  assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(),[]);
});

const releaseInput=()=>({operation:'RELEASE_RECOVERY_HOLD' as const,origin:'RECOVERY' as const,workflowRunId:'run',requestId:'reconciliation-release-check',
  limits:{maxRounds:0,maxModelCalls:0,maxActionDispatches:0,maxReadCalls:0,maxInputTokens:0,maxOutputTokens:0,maxCostMicros:0}});
async function settleUnknown(context:Awaited<ReturnType<typeof import('./reconciliation-active-process-fixture.ts')['unknownInvocation']>>,responseState:'NOT_APPLICABLE_VERIFIED'|'UNAVAILABLE_REVIEW_REQUIRED') {
  const {ReconciliationPlanner}=await import('../services/coordination/durable/reconciliationPlanner.ts');
  const {ReconciliationAuthorizer,reconciliationScopeOf}=await import('../services/coordination/durable/reconciliationAuthorizer.ts');
  const {ReconciliationExecutor}=await import('../services/coordination/durable/reconciliationExecutor.ts');
  const {completeClaim}=await import('./reconciliation-fixture.ts');
  const {f,target,verify}=context,verification=await verify({...completeClaim(),responseState,usage:{llmCalls:1,inputTokens:2,outputTokens:3,estimatedCost:0}});
  const plan=new ReconciliationPlanner(f.db,f.lease).createPlan({target,operationKind:'SETTLE_VERIFIED_MODEL_USAGE',verificationId:verification.verificationId},f.credential);
  new ReconciliationAuthorizer(f.db,f.lease).authorize(plan.planId,reconciliationScopeOf(plan),f.approver);
  return new ReconciliationExecutor(f.db,f.lease).executeAuthorized(plan.planId,f.credential);
}
test('US-16: late verified Usage updates original Invocation accounting without returning its consumed Model debit or changing its stopped record',async t=>{
  const {unknownInvocation}=await import('./reconciliation-active-process-fixture.ts');
  const context=await unknownInvocation(t),{f,originalPlan}=context;
  const debits=f.raw.prepare('SELECT * FROM recovery_invocation_debits ORDER BY rowid').all(),invocation=f.raw.prepare('SELECT * FROM recovery_invocations').all(),ledger=f.raw.prepare('SELECT * FROM model_call_ledger').all(),journal=f.raw.prepare('SELECT * FROM journal_events').all();
  assert.equal(debits.length,1);assert.equal(debits[0].kind,'MODEL');assert.equal(invocation[0].status,'REVIEW_REQUIRED');
  const initial=f.api().inspect(originalPlan.planId,f.credential);assert.equal(initial.counts.modelCalls,1);assert.equal(initial.usage.outstanding.inputTokens,20);
  await settleUnknown(context,'NOT_APPLICABLE_VERIFIED');
  const inspection=f.api().inspect(originalPlan.planId,f.credential);assert.equal(inspection.counts.modelCalls,1);
  assert.deepEqual(inspection.usage,{committed:{inputTokens:2,outputTokens:3,costMicros:0},outstanding:{inputTokens:0,outputTokens:0,costMicros:0}});
  assert.deepEqual(f.raw.prepare('SELECT * FROM recovery_invocation_debits ORDER BY rowid').all(),debits);assert.deepEqual(f.raw.prepare('SELECT * FROM recovery_invocations').all(),invocation);
  assert.deepEqual(f.raw.prepare('SELECT * FROM model_call_ledger').all(),ledger);assert.deepEqual(f.raw.prepare('SELECT * FROM journal_events').all(),journal);
  assert.equal(f.raw.prepare('SELECT count(*) n FROM model_usage_authorities').get()!.n,1);assert.equal(f.counts.draft,1);assert.equal(f.counts.action,0);
  // A separate valid release plan is possible only after all usage/response obligations are satisfied.
  assert.equal(f.api().createPlan(releaseInput(),f.credential).operation,'RELEASE_RECOVERY_HOLD');
});
for(const obligation of ['PARTIAL_USAGE','RESPONSE_UNAVAILABLE','DISPUTED'] as const)test(`IN-04: Hold Release cannot bypass ${obligation}; refusal preserves Grant, Invocation, accounting, workflow and callbacks`,async t=>{
  const {unknownInvocation}=await import('./reconciliation-active-process-fixture.ts');
  const {completeClaim,reconciliationContents}=await import('./reconciliation-fixture.ts');
  const context=await unknownInvocation(t),f=context.f;
  if(obligation==='DISPUTED') {
    await context.verify({...completeClaim(),usage:{llmCalls:1,inputTokens:2,outputTokens:3,estimatedCost:0}});
    await context.verify({...completeClaim(),usage:{llmCalls:1,inputTokens:3,outputTokens:3,estimatedCost:0}});
    assert.equal(f.raw.prepare('SELECT count(*) n FROM reconciliation_disputes').get()!.n,1);
  } else if(obligation==='PARTIAL_USAGE')await context.verify({...completeClaim(),completeness:'PARTIAL',usage:{llmCalls:1,inputTokens:2,outputTokens:3,estimatedCost:0}},'INCOMPLETE');
  else await settleUnknown(context,'UNAVAILABLE_REVIEW_REQUIRED');
  assert.equal(f.raw.prepare("SELECT count(*) n FROM recovery_invocations WHERE status IN ('ACTIVE','DRAINING')").get()!.n,0);
  const before=reconciliationContents(f.raw),calls={...f.counts},snapshot=f.store.getSnapshot('run');
  assert.throws(()=>f.api().createPlan(releaseInput(),f.credential));
  assert.deepEqual(reconciliationContents(f.raw),before);assert.deepEqual(f.counts,calls);assert.deepEqual(f.store.getSnapshot('run'),snapshot);
  assert.equal(f.raw.prepare('SELECT hold_state FROM recovery_workflow_control').get()!.hold_state,'HELD');
});
