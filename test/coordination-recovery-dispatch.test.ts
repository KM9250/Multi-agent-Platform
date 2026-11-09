import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { dispatchFixture as fixture,dispatchContents } from './recovery-dispatch-fixture.ts';
import { DurableDatabase, RecoveryReader } from '../services/coordination/durable/index.ts';
import { ControlledRecoveryPlanner, ControlledRecoveryAuthorizer, RecoveryDispatchCoordinator, controlledScopeOf } from '../services/coordination/durable/recoveryDispatchCoordinator.ts';
import { RecoveryDispatchReader } from '../services/coordination/durable/recoveryDispatchReader.ts';
import { SafeRecoveryPlanner, SafeRecoveryAuthorizer, SafeRecoveryExecutor } from '../services/coordination/durable/safeRecoveryExecutor.ts';
import { executionScopeOf } from '../services/coordination/durable/safeRecoveryStore.ts';
import { digest } from '../services/coordination/durable/integrity.ts';
import { corruptTable } from './recovery-execution-fixture.ts';

const count=(f:ReturnType<typeof fixture>,table:string)=>Number(f.raw.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);
test('prepared dispatch atomically spends approval, sends once, stores result, and retains Hold and Task',async t=>{
  const f=fixture(t),before=dispatchContents(f.raw);
  const preview=f.api().planner.preview('run');assert.equal(preview.candidates[0].reason,'HOLD_NOT_ESTABLISHED');assert.deepEqual(dispatchContents(f.raw),before);
  const p=f.plan(),{planDigest,...body}=p;assert.equal(planDigest,digest(body));f.authorize(p);f.plan();f.manager.renew(f.lease);
  const hold=f.raw.prepare('SELECT * FROM recovery_holds').all(),journal=f.raw.prepare('SELECT * FROM journal_events').all();
  const result=await f.execute(p);assert.equal(result.status,'RESULT_RECORDED');assert.equal(f.calls.execute,1);assert.equal(result.taskStatus,'ASSIGNED');assert.equal(result.finalizedEventId,null);
  assert.deepEqual(f.raw.prepare('SELECT * FROM recovery_holds').all(),hold);assert.deepEqual(f.raw.prepare('SELECT * FROM journal_events').all(),journal);
  assert.equal(f.raw.prepare('SELECT status FROM recovery_controlled_grants').get()!.status,'CONSUMED');assert.equal(count(f,'recovery_dispatch_grants'),1);
  const saved=dispatchContents(f.raw);assert.deepEqual(await f.execute(p),result);assert.deepEqual(f.api().reader.inspectDispatch(p.planId,f.credential),result);assert.deepEqual(dispatchContents(f.raw),saved);
  assert.equal(f.calls.execute,1);assert.equal(f.calls.plan,0);assert.equal(f.calls.verify,0);assert.throws(()=>f.store.assertRecoveryExecution('run'));
  assert.notEqual(new RecoveryReader(f.db).inspect('run').disposition,'RECOVERY_FAILED');assert.deepEqual(f.raw.prepare('PRAGMA foreign_key_check').all(),[]);
});
test('unauthenticated createPlan cannot establish a hold or management audit',t=>{
  const f=fixture(t),before=dispatchContents(f.raw);assert.throws(()=>f.api().planner.createPlan({workflowRunId:'run',actionId:'action'},{}),{code:'RECOVERY_UNAUTHENTICATED'});assert.deepEqual(dispatchContents(f.raw),before);
});
test('missing identity verifier fails closed, even with an authentic lease and caller-supplied roles',t=>{
  const f=fixture(t),db=new DurableDatabase({path:f.path,controlledExecutors:f.registry});t.after(()=>db.close());const before=dispatchContents(f.raw);
  assert.throws(()=>new ControlledRecoveryPlanner(db,f.lease).createPlan({workflowRunId:'run',actionId:'action'},{actorId:'admin',roles:['RECOVERY_ADMIN']}));assert.deepEqual(dispatchContents(f.raw),before);
});
test('self-approval, role separation, and distinct two-actor quorum',async t=>{
  const f=fixture(t,{policy:{ALLOW_PREPARED_DISPATCH:{minimumApprovers:2,forbidSelfApproval:true}}}),p=f.plan();
  assert.throws(()=>f.authorize(p,f.credential));assert.throws(()=>f.authorize(p,f.identity.credential('operator2',['RECOVERY_OPERATOR'])));
  f.authorize(p);assert.equal(count(f,'recovery_controlled_grants'),1);f.authorize(p);assert.equal(count(f,'recovery_controlled_grants'),1);
  await assert.rejects(f.execute(p));f.authorize(p,f.identity.credential('second',['RECOVERY_APPROVER']));
  await assert.rejects(new RecoveryDispatchCoordinator(f.db,f.lease).executeAuthorized(p.planId,f.identity.credential('viewer',['RECOVERY_VIEWER'])));
  assert.equal((await f.execute(p)).status,'RESULT_RECORDED');assert.equal(f.calls.execute,1);
});
test('revocation wins before reservation; consumed grants cannot be revoked',async t=>{
  const f=fixture(t),p=f.plan(),g=f.authorize(p);f.api().authorizer.revoke(g.authorizationId,f.approver);const before=dispatchContents(f.raw);
  await assert.rejects(f.execute(p));assert.deepEqual(dispatchContents(f.raw),before);assert.equal(f.calls.execute,0);
  const next=f.plan(),grant=f.authorize(next);await f.execute(next);assert.throws(()=>f.api().authorizer.revoke(grant.authorizationId,f.approver));assert.equal(f.calls.execute,1);
});
for(const risk of ['DENY','NEEDS_USER'] as const)test(`recovery approval cannot override ${risk}`,t=>{
  const f=fixture(t,{risk}),before=dispatchContents(f.raw);assert.throws(()=>f.plan());assert.deepEqual(dispatchContents(f.raw),before);assert.equal(f.calls.execute,0);
});
test('time budget is checked before hold creation',t=>{const f=fixture(t,{maxWallTimeMs:1000}),before=dispatchContents(f.raw);assert.throws(()=>f.plan());assert.deepEqual(dispatchContents(f.raw),before);});
for(const field of ['contractVersion','implementationDigest'] as const)test(`changed executor ${field} invalidates approved Plan`,async t=>{
  const f=fixture(t),p=f.plan();f.authorize(p);f.binding[field]=field==='contractVersion'?'test:2':'b'.repeat(64);const before=dispatchContents(f.raw);
  await assert.rejects(f.execute(p));assert.deepEqual(dispatchContents(f.raw),before);assert.equal(f.calls.execute,0);
});
test('generation change invalidates old approvals',async t=>{const f=fixture(t),p=f.plan();f.authorize(p);f.reacquire();const before=dispatchContents(f.raw);await assert.rejects(f.execute(p));assert.deepEqual(dispatchContents(f.raw),before);assert.equal(f.calls.execute,0);});
for(const field of ['workflowRunId','actionId','planDigest','operationKind','operationContractVersion'])test(`grant scope rejects changed ${field}`,t=>{
  const f=fixture(t),p=f.plan();assert.throws(()=>f.api().authorizer.authorize(p.planId,{...controlledScopeOf(p),[field]:'different'} as never,f.approver));assert.equal(count(f,'recovery_controlled_grants'),0);
});
for(const table of ['execution_ledger','recovery_controlled_grants','recovery_dispatch_intents','recovery_dispatch_grants','runtime_audit_events'])test(`A failure in ${table} rolls back all rows and sends zero times`,async t=>{
  const f=fixture(t),p=f.plan();f.authorize(p);const before=dispatchContents(f.raw);f.raw.exec(`CREATE TRIGGER injected_failure BEFORE ${['execution_ledger','recovery_controlled_grants'].includes(table)?'UPDATE':'INSERT'} ON ${table} BEGIN SELECT RAISE(ABORT,'test fault'); END`);
  await assert.rejects(f.execute(p));assert.deepEqual(dispatchContents(f.raw),before);assert.equal(f.calls.execute,0);
});
for(const table of ['runner_evidence','recovery_dispatch_evidence','execution_results','execution_ledger','recovery_dispatch_receipts','runtime_audit_events'])test(`B failure in ${table} cannot resend and rolls back default Evidence, Result, Receipt`,async t=>{
  const f=fixture(t),p=f.plan();f.authorize(p);f.hook(async()=>{f.raw.exec(`CREATE TRIGGER injected_failure BEFORE ${table==='execution_ledger'?'UPDATE':'INSERT'} ON ${table} BEGIN SELECT RAISE(ABORT,'test fault'); END`);return {status:'succeeded',summary:'Synthetic.'};});
  await assert.rejects(f.execute(p));assert.equal(f.calls.execute,1);assert.equal(count(f,'runner_evidence'),0);assert.equal(count(f,'execution_results'),0);assert.equal(count(f,'recovery_dispatch_receipts'),0);
  assert.equal((await f.execute(p)).status,'INTENT_RECORDED');assert.equal(f.calls.execute,1);
});
test('A commit ACK loss produces no send permit and no executor entry',async t=>{
  const f=fixture(t),p=f.plan();f.authorize(p);const exec=DatabaseSync.prototype.exec;let lost=false;
  DatabaseSync.prototype.exec=function(sql:string){const result=exec.call(this,sql);if(sql==='COMMIT'&&!lost&&f.raw.prepare('SELECT count(*) AS n FROM recovery_dispatch_intents').get()!.n===1){lost=true;throw Error('ACK lost');}return result;};
  try{assert.equal((await f.execute(p)).status,'INTENT_RECORDED');}finally{DatabaseSync.prototype.exec=exec;}
  assert.equal(lost,true);assert.equal(f.calls.execute,0);assert.equal((await f.execute(p)).status,'INTENT_RECORDED');assert.equal(f.calls.execute,0);
});
test('B commit ACK loss reads the saved receipt and never resends',async t=>{
  const f=fixture(t),p=f.plan();f.authorize(p);const exec=DatabaseSync.prototype.exec;let lost=false;
  DatabaseSync.prototype.exec=function(sql:string){const result=exec.call(this,sql);if(sql==='COMMIT'&&!lost&&f.raw.prepare('SELECT count(*) AS n FROM recovery_dispatch_receipts').get()!.n===1){lost=true;throw Error('ACK lost');}return result;};
  try{assert.equal((await f.execute(p)).status,'RESULT_RECORDED');}finally{DatabaseSync.prototype.exec=exec;}
  assert.equal(lost,true);await f.execute(p);assert.equal(f.calls.execute,1);
});
test('synchronous throw and reentrant execution consume one permit only',async t=>{
  const f=fixture(t),p=f.plan();f.authorize(p);let nested:Promise<unknown>|undefined;
  f.hook(()=>{nested=f.execute(p);throw Error('private exception');});const r=await f.execute(p);await nested;
  assert.equal(r.status,'REVIEW_REQUIRED');assert.equal(f.calls.execute,1);assert.equal(JSON.stringify(dispatchContents(f.raw)).includes('private exception'),false);await f.execute(p);assert.equal(f.calls.execute,1);
});
test('two connections and two plans cannot dispatch the same Action twice',async t=>{
  const f=fixture(t),p=f.plan(),q=f.plan();f.authorize(p);f.authorize(q);
  const db=new DurableDatabase({path:f.path,recoveryIdentityVerifier:f.identity.verifier,controlledExecutors:f.registry});t.after(()=>db.close());
  await Promise.allSettled([f.execute(p),new RecoveryDispatchCoordinator(db,f.lease).executeAuthorized(q.planId,f.credential),f.execute(p)]);
  assert.equal(f.calls.execute,1);assert.equal(count(f,'recovery_dispatch_intents'),1);assert.equal(count(f,'recovery_dispatch_receipts'),1);
});
test('prior Evidence uses the Attempt-bound Sink; ordinary owners and other Action IDs fail',async t=>{
  const f=fixture(t),p=f.plan();f.authorize(p);await assert.rejects(f.put({value:'outside'}));
  f.hook(async()=>{await assert.rejects(f.put({value:1},{workflowRunId:'run',sessionId:'session',taskId:'task',actionId:'other'}));const ref=await f.put({value:'synthetic'});return {status:'succeeded',summary:'Synthetic.',evidenceRefs:[ref]};});
  assert.equal((await f.execute(p)).status,'RESULT_RECORDED');assert.equal(count(f,'recovery_dispatch_evidence'),2);
  await assert.rejects(f.put({value:'outside'}));assert.equal(f.calls.execute,1);
});
test('normal recordResult and directly imported result participant cannot bypass Hold',async t=>{
  const f=fixture(t),p=f.plan();f.authorize(p);f.hook(async()=>{const attempt=String(f.raw.prepare('SELECT attempt_id FROM execution_ledger').get()!.attempt_id);
    assert.throws(()=>f.coordinator.recordResult('run',f.store.getSnapshot('run').tasks.task,attempt,{status:'succeeded',summary:'forged'}));
    assert.throws(()=>f.store.writeWorkflow('run',tx=>tx.run("UPDATE execution_ledger SET state='REVIEW_REQUIRED',review_reason='EXECUTION_UNCERTAIN'")));
    return {status:'succeeded',summary:'Synthetic.'};});assert.equal((await f.execute(p)).status,'RESULT_RECORDED');assert.equal(f.calls.execute,1);
});
test('timeout closes sink; a delayed success and Evidence cannot overwrite uncertainty',async t=>{
  const f=fixture(t,{timing:{executionTimeoutMs:25}}),p=f.plan();f.authorize(p);let late!:Promise<unknown>;
  f.hook(async()=>{await delay(80);late=f.put({late:true});await assert.rejects(late);return {status:'succeeded',summary:'late'};});
  assert.equal((await f.execute(p)).status,'REVIEW_REQUIRED');const before=dispatchContents(f.raw);await delay(100);assert.deepEqual(dispatchContents(f.raw),before);assert.equal(f.calls.execute,1);
});
test('grant start expiry does not end a started result collection window',async t=>{
  const f=fixture(t,{timing:{executionTimeoutMs:1000}}),p=f.plan();f.authorize(p,undefined,200);f.hook(async()=>{await delay(240);return {status:'succeeded',summary:'after start expiry'};});
  assert.equal((await f.execute(p)).status,'RESULT_RECORDED');assert.equal(f.calls.execute,1);
});
test('lease loss during execution rejects Evidence and Result with no retry',async t=>{
  const f=fixture(t),p=f.plan();f.authorize(p);f.hook(async()=>{f.reacquire();await assert.rejects(f.put({late:true}));return {status:'succeeded',summary:'late'};});
  await assert.rejects(f.execute(p));assert.equal(count(f,'execution_results'),0);assert.equal((await f.execute(p)).status,'INTENT_RECORDED');assert.equal(f.calls.execute,1);
});
test('Receipt survives 4B-1 finalization, grant expiry and generation changes without a lease',async t=>{
  const f=fixture(t),p=f.plan();f.authorize(p);await f.execute(p);
  const plan=new SafeRecoveryPlanner(f.db,f.lease).createPlan({workflowRunId:'run',operationKind:'REFLECT_RECORDED_RESULT',targetId:'action'},f.credential);
  new SafeRecoveryAuthorizer(f.db,f.lease).authorize(plan.executionPlanId,executionScopeOf(plan),f.approver);
  new SafeRecoveryExecutor(f.db,f.lease).executeAuthorized(plan.executionPlanId,f.credential);f.reacquire();
  const db=new DurableDatabase({path:f.path,recoveryIdentityVerifier:f.identity.verifier});t.after(()=>db.close());
  const r=new RecoveryDispatchReader(db).inspectDispatch(p.planId,f.credential);assert.equal(r.status,'RESULT_RECORDED');assert.equal(r.taskStatus,'COMPLETED');assert.ok(r.finalizedEventId);assert.equal(f.calls.execute,1);
});
for(const column of ['fingerprint','prepared_action_digest','registration_digest'])test(`corrupt ${column} fails closed before management writes`,t=>{
  const f=fixture(t);corruptTable(f.raw,'pending_actions',`UPDATE pending_actions SET ${column}='invalid'`);const before=dispatchContents(f.raw);assert.throws(()=>f.plan());assert.deepEqual(dispatchContents(f.raw),before);
});
