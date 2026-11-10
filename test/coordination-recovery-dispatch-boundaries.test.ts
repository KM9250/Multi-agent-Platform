import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dispatchFixture as fixture,dispatchContents } from './recovery-dispatch-fixture.ts';
import { corruptTable,withoutTestTriggers } from './recovery-execution-fixture.ts';
import { DurableDatabase,RecoveryPlanner,RecoveryAuthorizer,ModelCallLedger } from '../services/coordination/durable/index.ts';
import { ControlledRecoveryAuthorizer,RecoveryDispatchCoordinator,controlledScopeOf } from '../services/coordination/durable/recoveryDispatchCoordinator.ts';
import { SafeRecoveryPlanner,SafeRecoveryAuthorizer,SafeRecoveryExecutor } from '../services/coordination/durable/safeRecoveryExecutor.ts';
import { executionScopeOf } from '../services/coordination/durable/safeRecoveryStore.ts';
import { scopeOf } from '../services/coordination/durable/recoveryDecisionStore.ts';
import { persistDispatchResult } from '../services/coordination/durable/recoveryDispatchStore.ts';
import { ModelCallLedger as Ledger } from '../services/coordination/durable/modelCallLedger.ts';
import { RecoveryReader } from '../services/coordination/durable/recoveryReader.ts';
import { createRunnerEvent } from '../services/coordination/runner/eventFactory.ts';
import { clock } from './durable-execution-fixture.ts';

test('4A Plan/Grant and 4B-1 API cannot authorize controlled dispatch',async t=>{
  const f=fixture(t);f.plan();const p=new RecoveryPlanner(f.db,f.lease).createPlan({workflowRunId:'run',operationKind:'ALLOW_PREPARED_DISPATCH',targetId:'action'},f.credential);
  const g=new RecoveryAuthorizer(f.db,f.lease).authorize(p.recoveryPlanId,scopeOf(p),f.approver);
  const before=dispatchContents(f.raw);await assert.rejects(new RecoveryDispatchCoordinator(f.db,f.lease).executeAuthorized(p.recoveryPlanId,f.credential));
  await assert.rejects(new RecoveryDispatchCoordinator(f.db,f.lease).executeAuthorized(g.authorizationId,f.credential));
  assert.throws(()=>new SafeRecoveryPlanner(f.db,f.lease).createPlan({workflowRunId:'run',operationKind:'ALLOW_PREPARED_DISPATCH',targetId:'action'} as never,f.credential));assert.deepEqual(dispatchContents(f.raw),before);assert.equal(f.calls.execute,0);
});
test('changed recovery policy and an untracked executor fail closed at reservation',async t=>{
  const f=fixture(t),p=f.plan();f.authorize(p);const before=dispatchContents(f.raw);
  const db=new DurableDatabase({path:f.path,recoveryIdentityVerifier:f.identity.verifier,controlledExecutors:f.registry,recoveryAuthorizationPolicy:{ALLOW_PREPARED_DISPATCH:{minimumApprovers:2,forbidSelfApproval:true}}});t.after(()=>db.close());
  await assert.rejects(new RecoveryDispatchCoordinator(db,f.lease).executeAuthorized(p.planId,f.credential));
  const unsupported=new DurableDatabase({path:f.path,recoveryIdentityVerifier:f.identity.verifier});t.after(()=>unsupported.close());
  await assert.rejects(new RecoveryDispatchCoordinator(unsupported,f.lease).executeAuthorized(p.planId,f.credential));assert.deepEqual(dispatchContents(f.raw),before);assert.equal(f.calls.execute,0);
});
test('same-version executor object or function replacement is detected before consumption',async t=>{
  const f=fixture(t),p=f.plan();f.authorize(p);f.binding.executor.execute=async()=>({status:'succeeded',summary:'replacement'});
  await assert.rejects(f.execute(p));assert.equal(f.calls.execute,0);assert.equal(f.raw.prepare('SELECT count(*) AS n FROM recovery_dispatch_intents').get()!.n,0);
});
test('expired grant and plan cannot create an Intent',async t=>{
  const f=fixture(t,{timing:{sendTtlMs:300}}),p=f.plan();f.authorize(p);await delay(330);const before=dispatchContents(f.raw);
  await assert.rejects(f.execute(p));assert.deepEqual(dispatchContents(f.raw),before);assert.equal(f.calls.execute,0);
});
for(const stopped of ['abort','deadline'])test(`after A ${stopped} consumes authorization but starts no executor`,async t=>{
  const f=fixture(t,{timing:{sendTtlMs:400}}),p=f.plan();f.authorize(p);const controller=new AbortController(),exec=DatabaseSync.prototype.exec;let stoppedOnce=false;
  DatabaseSync.prototype.exec=function(sql:string){const value=exec.call(this,sql);if(sql==='COMMIT'&&!stoppedOnce&&f.raw.prepare('SELECT count(*) AS n FROM recovery_dispatch_intents').get()!.n===1){stoppedOnce=true;if(stopped==='abort')controller.abort();else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,430);}return value;};
  let result;try{result=await f.execute(p,controller.signal);}finally{DatabaseSync.prototype.exec=exec;}
  assert.equal(result.status,'REVIEW_REQUIRED');assert.equal(f.calls.execute,0);assert.equal(result.grants[0].status,'CONSUMED');
  await f.execute(p);assert.equal(f.calls.execute,0);assert.equal(f.raw.prepare('SELECT state FROM execution_ledger').get()!.state,'REVIEW_REQUIRED');
});
test('abort during execute records uncertainty and never waits for or overwrites from a late response',async t=>{
  const f=fixture(t),p=f.plan();f.authorize(p);const stop=new AbortController();f.hook(async()=>{stop.abort();await delay(50);return {status:'succeeded',summary:'late'};});
  const result=await f.execute(p,stop.signal);assert.equal(result.status,'REVIEW_REQUIRED');const before=dispatchContents(f.raw);await delay(80);assert.deepEqual(dispatchContents(f.raw),before);assert.equal(f.calls.execute,1);
});
test('result collection expiry rejects B and permanently closes the original sink',async t=>{
  const f=fixture(t,{timing:{sendTtlMs:400,executionTimeoutMs:20,resultGraceMs:20}}),p=f.plan();f.authorize(p);
  const exec=DatabaseSync.prototype.exec;let armed=false;
  f.hook(async()=>{armed=true;return {status:'succeeded',summary:'expired'};});
  DatabaseSync.prototype.exec=function(sql:string){if(armed&&sql==='BEGIN IMMEDIATE'){armed=false;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,470);}return exec.call(this,sql);};
  try{await assert.rejects(f.execute(p));}finally{DatabaseSync.prototype.exec=exec;}
  assert.equal(f.raw.prepare('SELECT count(*) AS n FROM execution_results').get()!.n,0);assert.equal((await f.execute(p)).status,'INTENT_RECORDED');assert.equal(f.calls.execute,1);
});
test('copied DB rows, a Lease DTO, and a copied Intent cannot carry any authority',async t=>{
  const f=fixture(t),p=f.plan();f.authorize(p);const path=join(f.dir,'copy.sqlite');f.db.backup(path);
  const db=new DurableDatabase({path,recoveryIdentityVerifier:f.identity.verifier,controlledExecutors:f.registry});t.after(()=>db.close());
  await assert.rejects(new RecoveryDispatchCoordinator(db,f.lease).executeAuthorized(p.planId,f.credential),{code:'LEASE_FENCED'});
  await assert.rejects(new RecoveryDispatchCoordinator(f.db,{...f.lease}).executeAuthorized(p.planId,f.credential),{code:'LEASE_FENCED'});assert.equal(f.calls.execute,0);
});
test('imported result participant plus normal lease/PLAN application has no Result Sink',async t=>{
  const f=fixture(t),p=f.plan();f.authorize(p);f.hook(async()=>{
    const intent=JSON.parse(String(f.raw.prepare('SELECT intent_json FROM recovery_dispatch_intents').get()!.intent_json));const before=dispatchContents(f.raw);
    assert.throws(()=>f.store.atomicApplication('run',tx=>persistDispatchResult(tx,intent,{status:'succeeded',summary:'forged',resultRef:intent.defaultEvidenceRef},Date.now(),()=>{})));
    assert.deepEqual(dispatchContents(f.raw),before);return {status:'succeeded',summary:'valid'};
  });assert.equal((await f.execute(p)).status,'RESULT_RECORDED');assert.equal(f.calls.execute,1);
});
for(const phase of ['A','B'])test(`${phase}: a swallowed SQL error poisons the complete transaction`,async t=>{
  const f=fixture(t),p=f.plan();f.authorize(p);const before=dispatchContents(f.raw),check=f.db.assertWorkflowWrite.bind(f.db);let injected=false;
  f.db.assertWorkflowWrite=(tx,id)=>{check(tx,id);if(!injected&&f.calls.execute===(phase==='A'?0:1)){injected=true;try{tx.run('INSERT INTO missing_controlled_table VALUES (1)');}catch{}}};
  await assert.rejects(f.execute(p));assert.equal(injected,true);assert.equal(f.calls.execute,phase==='A'?0:1);
  if(phase==='A')assert.deepEqual(dispatchContents(f.raw),before);else{assert.equal(f.raw.prepare('SELECT count(*) AS n FROM runner_evidence').get()!.n,0);assert.equal((await f.execute(p)).status,'INTENT_RECORDED');assert.equal(f.calls.execute,1);}
});
test('deferred foreign keys reject a consumed grant without its Intent link even when a participant omits it',async t=>{
  const f=fixture(t),p=f.plan();f.authorize(p);const before=dispatchContents(f.raw),prepare=DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare=function(sql:string){const stmt=prepare.call(this,sql);if(sql.startsWith('INSERT INTO recovery_dispatch_grants'))stmt.run=()=>({changes:0,lastInsertRowid:0});return stmt;};
  try{await assert.rejects(f.execute(p));}finally{DatabaseSync.prototype.prepare=prepare;}
  assert.deepEqual(dispatchContents(f.raw),before);assert.equal(f.calls.execute,0);
});
test('Result/Evidence saved before B failure remains linked to that Attempt and does not become success',async t=>{
  const f=fixture(t),p=f.plan();f.authorize(p);f.hook(async()=>{await f.put({synthetic:'prior evidence'});f.raw.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON recovery_dispatch_receipts BEGIN SELECT RAISE(ABORT,'fault'); END");return {status:'succeeded',summary:'synthetic'};});
  await assert.rejects(f.execute(p));assert.equal(f.raw.prepare('SELECT count(*) AS n FROM runner_evidence').get()!.n,1);assert.equal(f.raw.prepare('SELECT count(*) AS n FROM recovery_dispatch_evidence').get()!.n,1);
  assert.equal((await f.execute(p)).status,'INTENT_RECORDED');assert.equal(f.calls.execute,1);
});
test('Evidence count/size limits reserve room for the final default Evidence',async t=>{
  const f=fixture(t),p=f.plan();f.authorize(p);f.hook(async()=>{for(let n=0;n<15;n++)await f.put({n});await assert.rejects(f.put({overflow:true}));await assert.rejects(f.put({oversize:'x'.repeat(1024*1024)}));return {status:'succeeded',summary:'bounded'};});
  assert.equal((await f.execute(p)).status,'RESULT_RECORDED');assert.equal(f.raw.prepare('SELECT count(*) AS n FROM recovery_dispatch_evidence').get()!.n,16);assert.equal(f.calls.execute,1);
});
for(const rawResult of [{status:'failed',summary:'known failure'},{status:'uncertain',summary:'unknown'},{status:'invalid'},null])test(`result contract ${JSON.stringify(rawResult)} preserves uncertainty or known failure`,async t=>{
  const f=fixture(t),p=f.plan();f.authorize(p);f.hook(async()=>rawResult as never);const result=await f.execute(p);
  assert.equal(result.status,rawResult?.status==='failed'?'RESULT_RECORDED':'REVIEW_REQUIRED');assert.equal(result.taskStatus,'ASSIGNED');assert.equal(f.calls.execute,1);
});
test('tracked effective cancellation is accepted; unresolved Model reservation is not waived',async t=>{
  const f=fixture(t),s=f.store.getSnapshot('run');const request={workflowRunId:'run',modelCallId:'model',attemptId:'model-attempt',providerId:'test',modelId:'test',roundKey:'model-round',phase:'PLAN' as const,requestCursor:s.events.length,requestEventId:s.events.at(-1)!.eventId,
    quote:{providerId:'test',modelId:'test',maxAttempts:1 as const,inputTokens:1,maxOutputTokens:1,maxEstimatedCost:0,pricingId:'test',conditions:'test',requestDigest:'a'.repeat(64)}};
  new Ledger(f.store,clock).reserve(request);const before=dispatchContents(f.raw);assert.throws(()=>f.plan());assert.deepEqual(dispatchContents(f.raw),before);
  f.reacquire();const p=new SafeRecoveryPlanner(f.db,f.lease).createPlan({workflowRunId:'run',operationKind:'CANCEL_UNSENT_MODEL',targetId:'model'},f.credential);
  new SafeRecoveryAuthorizer(f.db,f.lease).authorize(p.executionPlanId,executionScopeOf(p),f.approver);new SafeRecoveryExecutor(f.db,f.lease).executeAuthorized(p.executionPlanId,f.credential);
  const next=f.plan();f.authorize(next);assert.equal((await f.execute(next)).status,'RESULT_RECORDED');assert.equal(f.calls.execute,1);assert.equal(new ModelCallLedger(f.store,clock).inspectEffective('run')[0].unresolved,false);
});
for(const corruption of ['coverage','intentAudit','resultAudit','grantAudit'])test(`reader/planner rejects damaged ${corruption} without new authority`,async t=>{
  const f=fixture(t);
  if(corruption==='coverage'){corruptTable(f.raw,'model_call_coverage',"UPDATE model_call_coverage SET coverage='LEGACY_UNTRACKED'");assert.throws(()=>f.plan());assert.equal(f.calls.execute,0);return;}
  const p=f.plan();f.authorize(p);await f.execute(p);const kind={intentAudit:'RECOVERY_DISPATCH_INTENT_COMMITTED',resultAudit:'RECOVERY_DISPATCH_RESULT_RECORDED',grantAudit:'RECOVERY_CONTROLLED_GRANT_CONSUMED'}[corruption];
  corruptTable(f.raw,'runtime_audit_events','DELETE FROM runtime_audit_events WHERE event_kind=?',kind);const before=dispatchContents(f.raw);
  assert.throws(()=>f.api().reader.inspectDispatch(p.planId,f.credential));await assert.rejects(f.execute(p));assert.deepEqual(dispatchContents(f.raw),before);assert.equal(f.calls.execute,1);
});
test('a completed result is immutable through direct SQL, normal and safe recovery scopes',async t=>{
  const f=fixture(t),p=f.plan();f.authorize(p);await f.execute(p);const before=dispatchContents(f.raw);
  for(const table of ['execution_results','runner_evidence','recovery_dispatch_receipts','recovery_dispatch_intents'])assert.throws(()=>f.store.writeWorkflow('run',tx=>tx.run(`DELETE FROM ${table}`)));
  assert.throws(()=>f.store.writeWorkflow('run',tx=>tx.run("UPDATE execution_results SET result_digest='different'")));assert.deepEqual(dispatchContents(f.raw),before);assert.equal(f.calls.execute,1);
});
for(const timing of [{sendTtlMs:0},{executionTimeoutMs:Infinity},{resultGraceMs:-1},{executionTimeoutMs:120001},{sendTtlMs:0.5}])test(`unbounded/invalid timing ${JSON.stringify(timing)} is rejected`,t=>{
  assert.throws(()=>fixture(t,{timing}));
});
test('valid Safety Hold result remains REVIEW_REQUIRED without Task reflection, VERIFY or PLAN',async t=>{
  const f=fixture(t),p=f.plan();f.authorize(p);const before=f.store.getSnapshot('run');
  f.hook(async()=>({status:'succeeded',summary:'review',safetyHold:{kind:'untrusted-content',effectState:'applied',reasonCode:'CONTENT_REVIEW_REQUIRED',
    reviewRef:`map.runner.security-review.v1:run:task:sha256%3A${'a'.repeat(64)}`,safeSummary:'Untrusted content requires user review.'}}));
  const result=await f.execute(p);assert.equal(result.status,'REVIEW_REQUIRED');assert.equal(result.receipt!.reasonCode,'SECURITY_REVIEW_REQUIRED');
  assert.deepEqual(f.store.getSnapshot('run'),before);assert.equal(f.calls.execute,1);assert.equal(f.calls.plan,0);assert.equal(f.calls.verify,0);
  const reader=new RecoveryReader(f.db),inspection=reader.inspect('run');assert.equal(inspection.disposition,'REVIEW_REQUIRED');assert.equal(inspection.executionAllowed,false);
  const timeline=reader.getActionHistory('run','action');const controlled=timeline.entries.filter(e=>e.controlledPlanId===p.planId);
  assert.equal(controlled.length,5);assert.ok(controlled.every(e=>e.actionId==='action'&&e.sessionId==='session'&&e.taskId==='task'));
  assert.ok(controlled.filter(e=>e.dispatchOperationId).every(e=>e.attemptId===result.intent!.attemptId));
});
test('saved DISPATCH_RESERVED/Result Actions cannot be replanned, including changed caller IDs',async t=>{
  const f=fixture(t),p=f.plan();f.authorize(p);f.hook(async()=>{assert.throws(()=>f.plan());return {status:'succeeded',summary:'saved'};});
  await f.execute(p);const before=dispatchContents(f.raw);assert.throws(()=>f.plan());
  assert.throws(()=>f.api().planner.createPlan({workflowRunId:'another',actionId:'action'},f.credential));
  assert.throws(()=>f.api().planner.createPlan({workflowRunId:'run',actionId:'replacement'},f.credential));assert.deepEqual(dispatchContents(f.raw),before);assert.equal(f.calls.execute,1);
});
for(const operation of ['plan','authorize','revoke'])test(`controlled ${operation} rejects audit failure atomically`,t=>{
  const f=fixture(t),p=operation==='plan'?undefined:f.plan(),g=operation==='revoke'?f.authorize(p!):undefined,before=dispatchContents(f.raw);
  f.raw.exec("CREATE TRIGGER reject_controlled_audit BEFORE INSERT ON runtime_audit_events WHEN NEW.event_kind LIKE 'RECOVERY_CONTROLLED_%' BEGIN SELECT RAISE(ABORT,'fault'); END");
  assert.throws(()=>operation==='plan'?f.plan():operation==='authorize'?f.authorize(p!):f.api().authorizer.revoke(g!.authorizationId,f.approver));assert.deepEqual(dispatchContents(f.raw),before);
});
test('approved result references cannot borrow Evidence from another Action/Attempt',async t=>{
  const f=fixture(t),p=f.plan();f.authorize(p);f.hook(async()=>({status:'succeeded',summary:'wrong reference',resultRef:'map.runner.evidence.v1:another-attempt'}));
  await assert.rejects(f.execute(p));const before=dispatchContents(f.raw);assert.equal((await f.execute(p)).status,'INTENT_RECORDED');assert.deepEqual(dispatchContents(f.raw),before);assert.equal(f.calls.execute,1);
});
test('current Attempt SQL predicates are observations only; no callable reserve/send or Sink mint exists',t=>{
  const f=fixture(t),p=f.plan();f.authorize(p);const before=dispatchContents(f.raw);
  f.store.writeWorkflow('run',tx=>{assert.equal(tx.get("SELECT map_controlled_write('execution_ledger',NULL,'[]') AS n")!.n,0);
    assert.equal(tx.get('SELECT map_controlled_actor() AS n')!.n,null);});
  const coordinator=f.api().coordinator as unknown as Record<string,unknown>;assert.equal(coordinator.reserve,undefined);assert.equal(coordinator.send,undefined);
  assert.deepEqual(dispatchContents(f.raw),before);
});
test('legacy Task with no execution coverage blocks dispatch despite a valid target Action',t=>{
  const f=fixture(t),s=f.store.getSnapshot('run'),task={...s.tasks.task,taskId:'legacy-task',inputRefs:['legacy-input']};
  f.store.append(createRunnerEvent(s,'TaskAssigned',task,clock,{nextId:()=> 'legacy-assigned'},{sessionId:'session'}));
  const before=dispatchContents(f.raw);assert.throws(()=>f.plan());assert.deepEqual(dispatchContents(f.raw),before);assert.equal(f.calls.execute,0);
});
for(const reason of ['RUNNER_UNTRUSTED_CONTENT:INVALID_METADATA','RUNNER_VERIFY_EVIDENCE_REQUIRED:pending-review'])test(`unresolved review/stop ${reason} is not waived by a new Plan`,t=>{
  const f=fixture(t),s=f.store.getSnapshot('run');f.store.append(createRunnerEvent(s,'WorkflowBlocked',{reason},clock,{nextId:()=> 'review-block'}));
  const before=dispatchContents(f.raw);assert.throws(()=>f.plan());assert.deepEqual(dispatchContents(f.raw),before);assert.equal(f.calls.execute,0);
});
test('replacing the public transaction method cannot fabricate acknowledged reservation success',async t=>{
  const f=fixture(t),p=f.plan();f.authorize(p);f.db.writeWithLease=()=>{throw Error('Public override must not own controlled commits');};
  assert.equal((await f.execute(p)).status,'RESULT_RECORDED');assert.equal(f.calls.execute,1);
});
