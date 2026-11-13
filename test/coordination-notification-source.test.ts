import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { fixture, saveHistory, plain } from './durable-fixture.ts';
import { fresh, event, block, done, cancelled, approvalRef, securityReason, evidenceReason } from './notification-fixture.ts';
import { continuationFixture, content } from './continuation-fixture.ts';
import { executeInput } from './continuation-runner-fixture.ts';
import { executionSeed, registration, record, model } from './durable-execution-fixture.ts';
import { DurableExecutionCoordinator } from '../services/coordination/durable/executionCoordinator.ts';
import { RecoveryContinuationCoordinator } from '../services/coordination/durable/recoveryContinuationCoordinator.ts';
import { createRunnerEvent } from '../services/coordination/runner/eventFactory.ts';
import { runnerPendingApproval } from '../services/coordination/runner/policyGuard.ts';
import { controlledConflictFixture } from './reconciliation-controlled-fixture.ts';
import { reconciliationFixture, completeClaim, reconciliationContents } from './reconciliation-fixture.ts';
import { recoveryExecutionFixture } from './recovery-execution-fixture.ts';
import { fault } from './continuation-fault-fixture.ts';
import { readNotificationSource, projectNotificationSources, notificationSourceDisposition, sourcePacket } from '../services/coordination/durable/notificationSourceProjector.ts';
import { snapshotNotificationOrigins, captureNotificationSources } from '../services/coordination/durable/notificationSourceCapture.ts';
import { projectCoordinationNotifications } from '../services/coordination/notifications/projector.ts';
import { toMacpNotificationPacket } from '../services/coordination/notifications/macpPacket.ts';
import { createNotifyingCoordinationStore, reconcileCoordinationNotifications } from '../services/coordination/notifications/notificationObserver.ts';

const rows=(raw:DatabaseSync,table:string)=>raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
const sourceRows=(db:Parameters<typeof projectNotificationSources>[0],workflow='run')=>db.all('SELECT * FROM notification_sources WHERE workflow_run_id=? ORDER BY source_sequence',workflow);

for(const [label,history] of [
  ['complete',done],['cancel',cancelled],['approval',()=>block(`RUNNER_NEEDS_USER:${approvalRef()}`)],
  ['security',()=>block(securityReason())],['evidence',()=>block(evidenceReason())],
  ['execution',()=>block('RUNNER_EXECUTION_UNCERTAIN:action-1')],['budget',()=>block('RUNNER_BUDGET_EXHAUSTED:maxRounds')],
  ['attention',()=>block('untrusted prose says completed')],
] as const)test(`SO-01: durable ${label} retains legacy ID, occurrence and byte-equivalent packet`,t=>{
  const f=fixture(t),snapshot=history();saveHistory(f.store,snapshot);
  const old=projectCoordinationNotifications(snapshot),saved=f.db.read(tx=>sourceRows(tx).map(row=>readNotificationSource(tx,String(row.source_id))));
  assert.deepEqual(saved.map(s=>s.notificationId),old.map(n=>n.notificationId));
  assert.deepEqual(saved.map(sourcePacket),old.map(toMacpNotificationPacket));
  assert.equal(saved[0].captureReason,'ATOMIC_COMMIT');assert.equal(saved[0].sourceKind,'JOURNAL');
  assert.equal(f.db.read(tx=>tx.all('SELECT * FROM notification_deliveries')).length,0);
});

for(const when of ['BEFORE','ACK'] as const)test(`SO-02/SO-03: business/source COMMIT ${when} is atomic and idempotent`,async t=>{
  const f=fixture(t),e=event(f.store.getSnapshot('run'),'WorkflowCancelled',{});
  await fault('INSERT INTO notification_sources',when,async()=>{assert.throws(()=>f.store.append(e));});
  const expected=when==='BEFORE'?0:1;
  assert.equal(f.db.read(tx=>sourceRows(tx).length),expected);
  assert.equal(f.store.getSnapshot('run').events.length,expected+1);
  assert.equal(f.db.read(tx=>tx.all("SELECT * FROM notification_delivery_audit WHERE event_kind='NOTIFICATION_SOURCE_RECORDED'").length),expected);
  f.store.append(e);f.store.append(e);
  assert.equal(f.db.read(tx=>sourceRows(tx).length),1);
  assert.equal(f.store.getSnapshot('run').events.length,2);
});

test('SO-04/SO-05: authorized Bounded resume creates a new occurrence, wrong-reference plan is rejected before effects',async t=>{
  const f=continuationFixture(t);
  f.verifyHook(async()=>({...model({taskOutcome:'PASS' as const,summary:'This task is complete; workflow acceptance remains open',criteria:[]}),provider:'synthetic'}));
  f.admin.createWorkflow(executionSeed('NEEDS_USER','review',{maxWallTimeMs:Number.MAX_SAFE_INTEGER,maxLlmCalls:10,maxInputTokens:1000,maxOutputTokens:1000,maxEstimatedCost:1}));
  const lease=f.manager.acquire('review'),store=f.admin.withLease(lease),api=new RecoveryContinuationCoordinator(f.db,lease);
  const action={...record,workflowRunId:'review'},coordinator=new DurableExecutionCoordinator(store,{get:id=>f.options.controlledExecutors.get(id)?.executor}),r=registration(store,action);
  coordinator.registerAction(action,r.expected,r.sessionEvent,r.taskEvent);
  const ref=runnerPendingApproval('review',action.action).approvalRef;
  store.append(createRunnerEvent(store.getSnapshot('review'),'WorkflowBlocked',{reason:`RUNNER_NEEDS_USER:${ref}`},{now:Date.now},{nextId:()=> 'needs-user'}));
  assert.throws(()=>store.assertRecoveryExecution('review'));
  const first=f.db.read(tx=>readNotificationSource(tx,String(sourceRows(tx,'review')[0].source_id))),before=rows(f.raw,'notification_sources');
  const input=executeInput(f);input.workflowRunId='review';input.start='RESUME_PREPARED';input.taskId='task';input.actionId='action';input.limits.maxModelCalls=1;input.resume={authorization:{type:'user',reference:'wrong'}};
  assert.throws(()=>api.createPlan(input,f.credential));assert.deepEqual(rows(f.raw,'notification_sources'),before);
  assert.equal(f.counts.action,0);assert.equal(f.counts.plan,0);assert.equal(f.db.read(tx=>notificationSourceDisposition(tx,first)).disposition,'SEND');
  input.resume={authorization:{type:'user',reference:ref}};const p=api.createPlan(input,f.credential);api.authorize(p,f.approver);
  assert.equal((await api.startAuthorized(p.planId,f.credential)).invocation?.status,'COMPLETED');
  const release=api.createPlan({operation:'RELEASE_RECOVERY_HOLD',origin:'RECOVERY',workflowRunId:'review',requestId:'release-review',
    limits:{maxRounds:0,maxModelCalls:0,maxActionDispatches:0,maxReadCalls:0,maxInputTokens:0,maxOutputTokens:0,maxCostMicros:0}},f.credential);
  api.authorize(release,f.approver);await api.startAuthorized(release.planId,f.credential);
  store.append(createRunnerEvent(store.getSnapshot('review'),'WorkflowBlocked',{reason:`RUNNER_NEEDS_USER:${ref}`},{now:Date.now},{nextId:()=> 'needs-user-again'}));
  const sources=f.db.read(tx=>sourceRows(tx,'review').map(row=>readNotificationSource(tx,String(row.source_id))));
  assert.equal(sources.length,2);assert.notEqual(sources[0].notificationId,sources[1].notificationId);
  assert.equal(f.db.read(tx=>notificationSourceDisposition(tx,first)).disposition,'SUPPRESS');
  assert.equal(f.counts.action,1);assert.equal(f.counts.verify,1);
});

test('SO-06/SO-13: artifact, application, FINISH and source are committed together without a business completion',async t=>{
  const f=continuationFixture(t),p=f.api().createPlan(f.input(),f.credential),r=await f.api().startAuthorized(p.planId,f.credential);
  assert.equal(r.invocation?.outcome,'AWAITING_PLAN_REVIEW');
  const sources=f.db.read(tx=>sourceRows(tx).map(row=>readNotificationSource(tx,String(row.source_id))));
  assert.deepEqual(sources.map(s=>s.kind),['planning_review_required']);
  const s=sources[0];assert.equal(s.ownerSubject,r.artifact!.ownerId);assert.equal(s.sourceRef,r.artifact!.artifactId);
  assert.equal(s.sourceVersion,'1');assert.equal(s.sourceDigest,r.artifact!.contentDigest);assert.equal('sourceEventId' in s,false);
  assert.equal(f.db.read(tx=>notificationSourceDisposition(tx,s)).disposition,'SEND');
  const packet=sourcePacket(s);assert.equal(packet.priority,'high');assert.equal(packet.summary,'MAPの計画案ができました。確認が必要です。');
  assert.doesNotMatch(JSON.stringify(packet),/Inspect the proposal|ownerId|sourceRef|invocationId|modelCallId/);
  assert.deepEqual(f.counts,{draft:1,plan:0,verify:0,action:0,prepare:0});
  const before=rows(f.raw,'notification_sources');f.api().inspect(p.planId,f.credential);await f.api().startAuthorized(p.planId,f.credential);
  assert.deepEqual(rows(f.raw,'notification_sources'),before);assert.equal(f.counts.draft,1);
});

for(const when of ['BEFORE','ACK'] as const)test(`SO-02/SO-03/SO-06: planning source COMMIT ${when} preserves atomic publication and never reruns model`,async t=>{
  const f=continuationFixture(t),p=f.api().createPlan(f.input(),f.credential);
  await fault('INSERT INTO notification_sources',when,async()=>{try{await f.api().startAuthorized(p.planId,f.credential);}catch{/* Read canonical outcome after the injected COMMIT fault. */}});
  const artifact=rows(f.raw,'planning_artifacts'),sources=rows(f.raw,'notification_sources').filter(s=>s.kind==='planning_review_required');
  assert.equal(artifact.length,when==='ACK'?1:0);assert.equal(sources.length,artifact.length);
  assert.equal(rows(f.raw,'model_call_ledger')[0].application_status,when==='ACK'?'APPLIED':'PENDING_APPLICATION');
  assert.equal(f.counts.draft,1);await f.api().startAuthorized(p.planId,f.credential);assert.equal(f.counts.draft,1);
  assert.deepEqual(rows(f.raw,'planning_artifacts'),artifact);
  assert.deepEqual(rows(f.raw,'notification_sources').filter(s=>s.kind==='planning_review_required'),sources);
});

test('SO-07: needs_input commits canonical request only and later model activity cannot answer it',async t=>{
  const f=continuationFixture(t);f.hook(async()=>({value:{kind:'needs_input',questions:['Private question text']},usage:{llmCalls:1,inputTokens:1,outputTokens:1,estimatedCost:0},completeness:'COMPLETE'}));
  const p=f.api().createPlan(f.input(),f.credential),r=await f.api().startAuthorized(p.planId,f.credential);
  const s=f.db.read(tx=>readNotificationSource(tx,String(sourceRows(tx)[0].source_id)));
  assert.equal(r.inputRequest?.state,'AWAITING_INPUT');assert.equal(s.kind,'planning_input_required');assert.equal(s.ownerSubject,r.inputRequest!.ownerId);
  assert.doesNotMatch(JSON.stringify(sourcePacket(s)),/Private question|questions|requestId/);
  f.hook(async()=>({value:{kind:'plan',artifact:content},usage:{llmCalls:1,inputTokens:1,outputTokens:1,estimatedCost:0},completeness:'COMPLETE'}));
  const later=f.api().createPlan(f.input(),f.credential);await f.api().startAuthorized(later.planId,f.credential);
  assert.equal(f.db.read(tx=>notificationSourceDisposition(tx,s)).disposition,'SEND');assert.equal(f.counts.action,0);
});

test('SO-08: old Artifact REVIEW is rejected without changing current notification or business tables',async t=>{
  const f=continuationFixture(t),p=f.api().createPlan(f.input(),f.credential),first=await f.api().startAuthorized(p.planId,f.credential);
  const revision=f.api().requestRevision(first.artifact!,f.input(),f.credential),latest=await f.api().startAuthorized(revision.planId,f.credential);
  const sources=f.db.read(tx=>sourceRows(tx).map(row=>readNotificationSource(tx,String(row.source_id)))),before={source:rows(f.raw,'notification_sources'),reviews:rows(f.raw,'planning_reviews'),control:rows(f.raw,'recovery_workflow_control'),calls:{...f.counts}};
  assert.throws(()=>f.api().recordReview(first.artifact!,'REJECTED',f.credential,first.control.revision));
  assert.deepEqual({source:rows(f.raw,'notification_sources'),reviews:rows(f.raw,'planning_reviews'),control:rows(f.raw,'recovery_workflow_control'),calls:{...f.counts}},before);
  assert.equal(f.db.read(tx=>notificationSourceDisposition(tx,sources[0])).disposition,'SUPPRESS');
  assert.equal(f.db.read(tx=>notificationSourceDisposition(tx,sources[1])).disposition,'SEND');
  f.api().recordReview(latest.artifact!,'ACCEPTED_FOR_SCOPE',f.credential,latest.control.revision);
  assert.equal(f.db.read(tx=>notificationSourceDisposition(tx,sources[1])).disposition,'SUPPRESS');
  assert.equal(f.counts.action,0);assert.equal(f.api().inspect(revision.planId,f.credential).control.planningReviewPending,true);
});

for(const outcome of ['failure','needs_input'] as const)test(`SO-09: revision ${outcome} preserves old unresolved review`,async t=>{
  const f=continuationFixture(t),p=f.api().createPlan(f.input(),f.credential),first=await f.api().startAuthorized(p.planId,f.credential);
  const original=f.db.read(tx=>readNotificationSource(tx,String(sourceRows(tx)[0].source_id)));
  f.hook(async()=>({value:outcome==='needs_input'?{kind:'needs_input',questions:['Clarify requirement']}:{kind:'invalid'} as never,
    usage:{llmCalls:1,inputTokens:1,outputTokens:1,estimatedCost:0},completeness:'COMPLETE'}));
  const revision=f.api().requestRevision(first.artifact!,f.input(),f.credential);await f.api().startAuthorized(revision.planId,f.credential);
  assert.equal(f.db.read(tx=>notificationSourceDisposition(tx,original)).disposition,'SEND');assert.equal(f.counts.action,0);
});

test('SO-09: authorized cancellation of a revision preserves the original unresolved review',async t=>{
  const f=continuationFixture(t),p=f.api().createPlan(f.input(),f.credential),first=await f.api().startAuthorized(p.planId,f.credential);
  const original=f.db.read(tx=>readNotificationSource(tx,String(sourceRows(tx)[0].source_id)));
  let entered!:()=>void,finish!:()=>void;const ready=new Promise<void>(r=>entered=r),pending=new Promise<void>(r=>finish=r);
  f.hook(async()=>{entered();await pending;return {value:{kind:'plan',artifact:content},usage:{llmCalls:1,inputTokens:1,outputTokens:1,estimatedCost:0},completeness:'COMPLETE'};});
  const revision=f.api().requestRevision(first.artifact!,f.input(),f.credential),running=f.api().startAuthorized(revision.planId,f.credential);
  await ready;f.api().requestStop(revision.planId,f.credential);finish();const stopped=await running;
  assert.equal(stopped.invocation?.status,'STOPPED');assert.equal(stopped.artifact,undefined);
  assert.equal(f.db.read(tx=>notificationSourceDisposition(tx,original)).disposition,'SEND');assert.equal(f.counts.action,0);
});

test('SO-10/SO-14: finite failed planning emits one Recovery confirmation; heartbeat and inspect emit none',async t=>{
  const f=continuationFixture(t);f.hook(async()=>({value:{kind:'invalid'} as never,usage:{llmCalls:1,inputTokens:1,outputTokens:1,estimatedCost:0},completeness:'COMPLETE'}));
  const p=f.api().createPlan(f.input(),f.credential);await f.api().startAuthorized(p.planId,f.credential);
  const sources=f.db.read(tx=>sourceRows(tx).map(row=>readNotificationSource(tx,String(row.source_id))));
  assert.deepEqual(sources.map(s=>s.kind),['recovery_review_required']);
  const before=rows(f.raw,'notification_sources');for(let i=0;i<8;i++){f.manager.renew(f.lease);f.api().inspect(p.planId,f.credential);}
  assert.deepEqual(rows(f.raw,'notification_sources'),before);assert.equal(f.counts.draft,1);
});

test('SO-10: generation-fenced Bounded invocation captures LEASE_LOST from its canonical lifecycle once',async t=>{
  const f=continuationFixture(t);
  f.hook(async()=>{f.reacquire();return {value:{kind:'plan',artifact:content},usage:{llmCalls:1,inputTokens:1,outputTokens:1,estimatedCost:0},completeness:'COMPLETE'};});
  const p=f.api().createPlan(f.input(),f.credential),r=await f.api().startAuthorized(p.planId,f.credential);
  assert.equal(r.invocation?.status,'REVIEW_REQUIRED');assert.equal(r.invocation?.outcome,'LEASE_LOST');
  const s=f.db.read(tx=>readNotificationSource(tx,String(sourceRows(tx)[0].source_id)));
  assert.equal(s.kind,'recovery_review_required');assert.equal(s.sourceKind,'BOUNDED_INVOCATION');
  assert.equal(f.db.read(tx=>notificationSourceDisposition(tx,s)).disposition,'SEND');
  const before=rows(f.raw,'notification_sources');await f.api().startAuthorized(p.planId,f.credential);
  assert.deepEqual(rows(f.raw,'notification_sources'),before);assert.equal(f.counts.draft,1);assert.equal(f.counts.action,0);
});

test('SO-11/SO-12/SO-13: PR36 Controlled contradictory result, receipt, verified dispute and source share COMMIT',async t=>{
  const c=await controlledConflictFixture(t),{f}=c;
  for(let i=0;i<8;i++){c.submit();f.manager.renew(f.lease);}
  assert.equal(rows(f.raw,'notification_sources').length,0);
  await c.verify();assert.equal(rows(f.raw,'notification_sources').length,0);
  c.release({status:'failed',summary:'Synthetic contradictory result'});const result=await c.pending;
  assert.equal(result.status,'RESULT_RECORDED');assert.equal(rows(f.raw,'execution_results').length,1);
  assert.equal(rows(f.raw,'recovery_dispatch_receipts').length,1);assert.equal(rows(f.raw,'reconciliation_disputes').length,1);
  const s=f.db.read(tx=>readNotificationSource(tx,String(sourceRows(tx)[0].source_id)));
  assert.equal(s.kind,'reconciliation_review_required');assert.equal(s.sourceKind,'RECONCILIATION_DISPUTE');
  assert.equal(f.db.read(tx=>notificationSourceDisposition(tx,s)).disposition,'SEND');
  assert.equal(f.calls.execute,1);assert.equal(c.synthetic.counts.verifier,1);
  await f.execute(c.plan);assert.equal(f.calls.execute,1);assert.equal(rows(f.raw,'notification_sources').length,1);
});

test('SO-20: a verified dispute after terminal cancellation remains an independent required notification',async t=>{
  const f=reconciliationFixture(t),m=f.model();f.add('WorkflowCancelled',{});f.reacquire();
  const terminal=f.store.getSnapshot('run');await f.verified(m.target);
  await f.verified(m.target,{...completeClaim(),usage:{llmCalls:1,inputTokens:201,outputTokens:200,estimatedCost:0.0004}});
  const s=f.db.read(tx=>sourceRows(tx).map(row=>readNotificationSource(tx,String(row.source_id))).find(item=>item.kind==='reconciliation_review_required')!);
  assert.ok(s);assert.equal(s.sourceKind,'RECONCILIATION_DISPUTE');
  assert.equal(f.db.read(tx=>notificationSourceDisposition(tx,s)).disposition,'SEND');
  assert.deepEqual(f.store.getSnapshot('run'),terminal);assert.equal(f.counts.action,0);assert.equal(f.counts.model,0);
});

test('SO-11: reconciled usage keeps independent missing-response confirmation and is never business completion',async t=>{
  const f=reconciliationFixture(t),m=f.model(),v=await f.verified(m.target),p=f.plan(m.target,v.verification.verificationId);
  assert.equal(rows(f.raw,'notification_sources').length,0);f.authorize(p);f.execute(p);
  const s=f.db.read(tx=>readNotificationSource(tx,String(sourceRows(tx)[0].source_id)));
  assert.equal(s.kind,'reconciliation_review_required');assert.equal(s.sourceKind,'RECONCILIATION_OPERATION');
  assert.equal(f.db.read(tx=>notificationSourceDisposition(tx,s)).disposition,'SEND');
  assert.deepEqual(f.counts,{verifier:1,action:0,model:0,lookup:0});
});

for(const operation of ['CANCEL_UNSENT_MODEL','DISCARD_SETTLED_RESPONSE','REFLECT_RECORDED_RESULT'] as const)
test(`SO-13: real SafeRecovery ${operation} retains its scope/receipt and does not invent a notification`,async t=>{
  const f=recoveryExecutionFixture(t);
  if(operation==='CANCEL_UNSENT_MODEL')f.reserve();else if(operation==='DISCARD_SETTLED_RESPONSE')f.settled();else await f.action();
  f.reacquire();const p=f.plan(operation,operation==='REFLECT_RECORDED_RESULT'?'action':'model');f.authorize(p);
  const calls=f.calls.execute,receipt=f.execute(p);assert.equal(receipt.status,'COMMITTED');
  assert.equal(rows(f.raw,'notification_sources').length,0);assert.equal(rows(f.raw,'recovery_execution_operations').length,1);
  const after=reconciliationContents(f.raw);assert.deepEqual(f.execute(p),receipt);assert.deepEqual(reconciliationContents(f.raw),after);assert.equal(f.calls.execute,calls);
});

for(const when of ['NORMAL','BEFORE','ACK'] as const)
test(`SO-02/SO-03/SO-13: real SafeRecovery safety-stop ${when} atomically binds its Journal, receipt, grants and Source`,async t=>{
  const f=recoveryExecutionFixture(t);await f.action('uncertain');f.reacquire();const p=f.plan('COMPLETE_SAFETY_STOP','action');f.authorize(p);
  const before=reconciliationContents(f.raw);
  if(when==='NORMAL')f.execute(p);
  else await fault('INSERT INTO notification_sources',when,async()=>{if(when==='BEFORE')assert.throws(()=>f.execute(p));else f.execute(p);});
  if(when==='BEFORE'){
    assert.deepEqual(reconciliationContents(f.raw),before,'every table including Source/Receipt/Audit rolls back');
    assert.equal(f.calls.execute,1);f.execute(p);
  }
  const s=f.db.read(tx=>readNotificationSource(tx,String(sourceRows(tx)[0].source_id)));
  assert.equal(s.kind,'execution_review_required');assert.equal(s.sourceKind,'JOURNAL');
  assert.equal(f.store.getSnapshot('run').events.at(-1)!.eventId,s.sourceRef);
  assert.equal(f.store.getSnapshot('run').run.status,'BLOCKED');assert.equal(rows(f.raw,'recovery_execution_operations').length,1);
  assert.equal(rows(f.raw,'recovery_execution_grants')[0].status,'CONSUMED');assert.equal(f.calls.execute,1);
  const after=reconciliationContents(f.raw);f.execute(p);assert.deepEqual(reconciliationContents(f.raw),after);assert.equal(f.calls.execute,1);
});

test('SO-14: cheap unchanged origin snapshot avoids replay and cannot manufacture capture',t=>{
  const f=fixture(t);f.db.read(tx=>{
    const before=snapshotNotificationOrigins(tx,'run');let payloadRead=0,writes=0;
    const wrapped={...tx,all(sql:string,...args:Parameters<typeof tx.all> extends [string,...infer P]?P:never){if(/SELECT \* FROM journal_events/i.test(sql))payloadRead++;return tx.all(sql,...args);}};
    assert.deepEqual(captureNotificationSources(wrapped,'run',before,()=>{writes++;}),[]);assert.equal(payloadRead,0);assert.equal(writes,0);
  });
});

test('SO-15/SO-16: unconfigured identity/route does not prevent atomic source, DB/read do not materialize or send',t=>{
  const f=fixture(t);f.store.append(event(f.store.getSnapshot('run'),'WorkflowCancelled',{}));
  const before=plain(f.db.read(tx=>sourceRows(tx)));f.store.getSnapshot('run');const other=f.open();other.store.getSnapshot('run');
  assert.deepEqual(plain(f.db.read(tx=>sourceRows(tx))),before);assert.equal(f.db.read(tx=>tx.all('SELECT * FROM notification_deliveries')).length,0);
});

test('SO-19: source row origin and packet fields are verified against canonical records',t=>{
  const f=fixture(t);f.store.append(event(f.store.getSnapshot('run'),'WorkflowCancelled',{}));
  const s=f.db.read(tx=>readNotificationSource(tx,String(sourceRows(tx)[0].source_id)));
  assert.throws(()=>f.db.read(tx=>notificationSourceDisposition(tx,{...s,sourceRef:'forged'})));
  assert.throws(()=>sourcePacket({...s,kind:'__proto__' as never}));
  assert.equal(f.db.read(tx=>tx.all('SELECT * FROM notification_deliveries')).length,0);
});

test('SO-14/RT-D10: durable legacy Observer double wiring fails before observation or business append',async t=>{
  const f=fixture(t);let observed=0;const observer={observe(){observed++;}};
  const before=f.store.getSnapshot('run');assert.throws(()=>createNotifyingCoordinationStore(f.store,observer),/DURABLE_NOTIFICATION_DOUBLE_WIRING/);
  await assert.rejects(reconcileCoordinationNotifications(f.store,'run',observer),/DURABLE_NOTIFICATION_DOUBLE_WIRING/);
  assert.equal(observed,0);assert.deepEqual(f.store.getSnapshot('run'),before);assert.equal(f.db.read(tx=>sourceRows(tx).length),0);
});
