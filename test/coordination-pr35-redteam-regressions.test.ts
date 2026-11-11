import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { continuationFixture, content } from './continuation-fixture.ts';
import { fault } from './continuation-fault-fixture.ts';
import { DurableDatabase } from '../services/coordination/durable/db.ts';
import { RecoveryContinuationCoordinator } from '../services/coordination/durable/recoveryContinuationCoordinator.ts';
import { executeInput } from './continuation-runner-fixture.ts';
import { executionSeed } from './durable-execution-fixture.ts';
import type { ContinuationInspection, ContinuationPlan, ContinuationPolicy } from '../services/coordination/durable/continuationTypes.ts';

const usage={llmCalls:1,inputTokens:1,outputTokens:1,estimatedCost:0};
function actors(t:TestContext) {
  const f=continuationFixture(t);
  f.policy.planningRoles=['RECOVERY_OPERATOR'] as never;
  return {f,alice:f.identity.credential('alice',['RECOVERY_OPERATOR']),bob:f.identity.credential('bob',['RECOVERY_OPERATOR']),
    admin:f.identity.credential('admin',['RECOVERY_ADMIN'])};
}
type Fixture=ReturnType<typeof continuationFixture>;
function state(f:Fixture) {
  return Object.fromEntries(f.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(r=>[String(r.name),f.raw.prepare(`SELECT * FROM "${String(r.name).replaceAll('"','""')}" ORDER BY rowid`).all()]));
}
async function plan(f:Fixture,credential:unknown) {
  const p=f.api().createPlan(f.input(),credential);return f.api().startAuthorized(p.planId,credential);
}
function review(f:Fixture,r:ContinuationInspection,credential:unknown,decision:'REJECTED'|'ACCEPTED_FOR_SCOPE'|'SUPERSEDED'='REJECTED',revision=r.control.revision) {
  f.api().recordReview(r.artifact!,decision,credential,revision);
}
async function pending(f:Fixture,credential:unknown,p?:ContinuationPlan,reply:unknown={kind:'plan',artifact:content}) {
  let entered!:()=>void,complete!:()=>void,signal!:AbortSignal;
  const ready=new Promise<void>(r=>entered=r),waiting=new Promise<void>(r=>complete=r);
  f.hook(async request=>{signal=request.signal;entered();await waiting;return {value:reply,usage,completeness:'COMPLETE'};});
  const created=p??f.api().createPlan(f.input(),credential),run=f.api().startAuthorized(created.planId,credential);
  await ready;return {p:created,run,complete,signal};
}

for(const differentOwner of [false,true])test(`RT-01: old A cannot clear independent B's review gate; other owner=${differentOwner}`,async t=>{
  const {f,alice,bob}=actors(t),a=await plan(f,alice);review(f,a,alice);
  const owner=differentOwner?bob:alice,b=await plan(f,owner),before=state(f),calls={...f.counts};
  if(differentOwner){assert.throws(()=>f.api().inspect(b.plan.planId,alice));assert.throws(()=>review(f,b,alice));}
  // Even a caller guessing the CURRENT revision cannot use an unrelated old Artifact.
  try{review(f,a,alice,'REJECTED',b.control.revision);}catch{}
  assert.deepEqual(state(f),before);assert.equal(f.api().inspect(b.plan.planId,owner).control.planningReviewPending,true);
  assert.deepEqual(f.counts,calls);assert.throws(()=>f.store.assertRecoveryExecution('run'));
  review(f,b,owner);assert.equal(f.api().inspect(b.plan.planId,owner).control.planningReviewPending,false);
});

test('RT-01: an incomplete revision retains the original unresolved review',async t=>{
  const {f,alice}=actors(t),a=await plan(f,alice);
  f.hook(async()=>({value:{kind:'needs_input',questions:['Which environment?']},usage,completeness:'COMPLETE'}));
  const p=f.api().requestRevision(a.artifact!,f.input(),alice),r=await f.api().startAuthorized(p.planId,alice);
  assert.deepEqual(r.inputRequest?.questions,['Which environment?']);assert.equal(r.control.planningReviewPending,true);
  assert.throws(()=>f.store.assertRecoveryExecution('run'));assert.equal(f.counts.action,0);
});

test('RT-01: a cancelled revision retains the original unresolved review',async t=>{
  const {f,alice}=actors(t),a=await plan(f,alice),p=f.api().requestRevision(a.artifact!,f.input(),alice),running=await pending(f,alice,p);
  let r:ContinuationInspection;
  try{f.api().requestStop(p.planId,alice);}finally{running.complete();r=await running.run;}
  assert.equal(r.invocation?.outcome,'USER_STOP');assert.equal(r.control.planningReviewPending,true);
  assert.throws(()=>f.store.assertRecoveryExecution('run'));assert.equal(f.counts.action,0);
});

test('RT-02: PLAN-only Alice cannot stop Bob or affect his signal, receipt or audit',async t=>{
  const {f,alice,bob}=actors(t);
  f.policy.canAccess=((who,_workflow,operation)=>who.actorId!=='alice'||operation!=='EXECUTE') as ContinuationPolicy['canAccess'] as typeof f.policy.canAccess;
  const running=await pending(f,bob),before=state(f);
  try{
    assert.throws(()=>f.api().inspect(running.p.planId,alice));
    assert.throws(()=>f.api().requestStop(running.p.planId,alice));
    assert.equal(running.signal.aborted,false);assert.deepEqual(state(f),before);
  }finally{running.complete();await running.run;}
  assert.equal(f.counts.draft,1);assert.equal(f.counts.action,0);
});

test('RT-02: rolled-back STOP cannot fire the Provider abort signal',async t=>{
  const {f,bob}=actors(t),running=await pending(f,bob),before=state(f);
  try{
    await fault('INSERT INTO recovery_continuation_receipts','BEFORE',async()=>assert.throws(()=>f.api().requestStop(running.p.planId,bob)));
    assert.equal(running.signal.aborted,false);assert.deepEqual(state(f),before);
  }finally{running.complete();await running.run;}
});

for(const decision of ['ACCEPTED_FOR_SCOPE','REJECTED','SUPERSEDED'] as const)test(`RT-01: current owner may ${decision}, consuming exactly the observed revision`,async t=>{
  const {f,alice}=actors(t),r=await plan(f,alice),a=r.artifact!,grants=f.raw.prepare('SELECT * FROM recovery_continuation_grants').all();
  assert.deepEqual(r.review.target,{artifactId:a.artifactId,version:a.version,contentDigest:a.contentDigest,ownerId:'alice',controlRevision:r.control.revision});
  review(f,r,alice,decision);const after=f.api().inspect(r.plan.planId,alice),saved=state(f);
  assert.equal(after.review.state,decision);assert.equal(after.control.revision,r.control.revision+1);
  assert.equal(after.control.planningReviewPending,decision==='ACCEPTED_FOR_SCOPE');
  assert.deepEqual(f.raw.prepare('SELECT * FROM recovery_continuation_grants').all(),grants);
  assert.throws(()=>review(f,r,alice,decision));assert.deepEqual(state(f),saved);
  if(decision==='ACCEPTED_FOR_SCOPE')assert.throws(()=>f.store.assertRecoveryExecution('run'));else f.store.assertRecoveryExecution('run');
  assert.equal(f.counts.action,0);assert.equal(f.counts.draft,1);assert.equal(after.executionAllowed,false);
});

for(const mismatch of ['version','digest','revision','missing-revision'] as const)test(`RT-01: ${mismatch} mismatch cannot partially write review, control or audit`,async t=>{
  const {f,alice}=actors(t),r=await plan(f,alice),before=state(f),ref={...r.artifact!};
  if(mismatch==='version')ref.version++;if(mismatch==='digest')ref.contentDigest='0'.repeat(64);
  const revision=mismatch==='revision'?r.control.revision+1:mismatch==='missing-revision'?undefined as never:r.control.revision;
  assert.throws(()=>f.api().recordReview(ref,'REJECTED',alice,revision));assert.deepEqual(state(f),before);
});

test('RT-01: stale Artifact cannot be used to revise or adopt while a different target is pending',async t=>{
  const {f,alice}=actors(t),a=await plan(f,alice);review(f,a,alice);const b=await plan(f,alice),before=state(f);
  assert.equal(f.api().inspect(a.plan.planId,alice).review.target,undefined);
  assert.throws(()=>f.api().requestRevision(a.artifact!,f.input(),alice));
  const x=executeInput(f);x.origin='USER_REQUEST';delete x.resume;x.artifact=a.artifact;
  assert.throws(()=>f.api().createPlan(x,alice));x.artifact=b.artifact;x.previousArtifact=b.artifact;
  assert.throws(()=>f.api().createPlan(x,alice));assert.deepEqual(state(f),before);assert.equal(f.counts.action,0);
});

test('RT-01: successful revision atomically supersedes A and binds the pending gate to B',async t=>{
  const {f,alice}=actors(t),a=await plan(f,alice),p=f.api().requestRevision(a.artifact!,f.input(),alice),b=await f.api().startAuthorized(p.planId,alice);
  assert.equal(b.artifact?.version,a.artifact!.version+1);assert.equal(b.artifact?.previousArtifact?.artifactId,a.artifact!.artifactId);
  assert.equal(f.api().inspect(a.plan.planId,alice).review.state,'SUPERSEDED');assert.equal(b.review.target?.artifactId,b.artifact!.artifactId);
  const before=state(f);assert.throws(()=>review(f,a,alice,'REJECTED',b.control.revision));assert.deepEqual(state(f),before);
  review(f,b,alice);f.store.assertRecoveryExecution('run');assert.equal(f.counts.action,0);
});

for(const failure of ['invalid-response','unknown'] as const)test(`RT-01: ${failure} during revision retains A's unresolved gate`,async t=>{
  const {f,alice}=actors(t),a=await plan(f,alice);
  f.hook(async()=>{if(failure==='unknown')throw Error('synthetic failure');return {value:{kind:'plan',artifact:{}},usage,completeness:'COMPLETE'};});
  const p=f.api().requestRevision(a.artifact!,f.input(),alice),r=await f.api().startAuthorized(p.planId,alice);
  assert.equal(r.control.planningReviewPending,true);assert.equal(r.artifact,undefined);
  assert.equal(f.api().inspect(a.plan.planId,alice).review.target?.artifactId,a.artifact!.artifactId);
  assert.throws(()=>f.store.assertRecoveryExecution('run'));assert.equal(f.counts.action,0);
});

for(const when of ['BEFORE','ACK'] as const)test(`RT-01: review COMMIT ${when} is atomic; retry cannot overwrite a consumed revision`,async t=>{
  const {f,alice}=actors(t),r=await plan(f,alice),before=state(f);
  await fault('INSERT INTO planning_reviews',when,async()=>assert.throws(()=>review(f,r,alice)));
  const observed=f.api().inspect(r.plan.planId,alice);
  if(when==='BEFORE'){assert.deepEqual(state(f),before);assert.equal(observed.control.planningReviewPending,true);review(f,r,alice);}
  else {assert.equal(observed.control.planningReviewPending,false);assert.equal(observed.review.state,'REJECTED');const saved=state(f);assert.throws(()=>review(f,r,alice));assert.deepEqual(state(f),saved);}
  assert.equal(f.raw.prepare('SELECT count(*) n FROM planning_reviews').get()!.n,1);assert.equal(f.counts.action,0);
});

test('RT-01: review Audit failure rolls back the decision and Control update',async t=>{
  const {f,alice}=actors(t),r=await plan(f,alice),before=state(f);
  f.raw.exec("CREATE TRIGGER fail_review_audit BEFORE INSERT ON bounded_audit WHEN NEW.entity_table='planning_reviews' BEGIN SELECT RAISE(ABORT,'injected'); END");
  try{assert.throws(()=>review(f,r,alice));assert.deepEqual(state(f),before);}finally{f.raw.exec('DROP TRIGGER fail_review_audit');}
  review(f,r,alice);assert.equal(f.counts.action,0);
});

test('RT-01: competing connections using one Control revision commit only one review',async t=>{
  const {f,alice}=actors(t),r=await plan(f,alice),db=new DurableDatabase(f.options),other=new RecoveryContinuationCoordinator(db,f.lease);
  try{
    const results=await Promise.allSettled([Promise.resolve().then(()=>review(f,r,alice,'ACCEPTED_FOR_SCOPE')),
      Promise.resolve().then(()=>other.recordReview(r.artifact!,'REJECTED',alice,r.control.revision))]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    assert.equal(f.raw.prepare('SELECT count(*) n FROM planning_reviews').get()!.n,1);
    const current=f.api().inspect(r.plan.planId,alice);assert.equal(current.control.revision,r.control.revision+1);
    assert.equal(current.control.planningReviewPending,true);assert.equal(f.counts.action,0);
  }finally{db.close();}
});

for(const caller of ['owner','revoked-owner','admin'] as const)test(`RT-02: ${caller} can stop, collect started Usage and prevent new calls`,async t=>{
  const {f,bob,admin}=actors(t),running=await pending(f,bob);
  if(caller==='revoked-owner')f.policy.canAccess=((who,_workflow,operation)=>who.actorId!=='bob'||operation==='VIEW') as ContinuationPolicy['canAccess'] as typeof f.policy.canAccess;
  try{
    f.api().requestStop(running.p.planId,caller==='admin'?admin:bob);
    assert.equal(running.signal.aborted,true);assert.equal(f.raw.prepare('SELECT status FROM recovery_invocations').get()!.status,'DRAINING');
    const receipt=JSON.parse(String(f.raw.prepare("SELECT receipt_json FROM recovery_continuation_receipts WHERE kind='STOP'").get()!.receipt_json));
    assert.equal(receipt.owner,'bob');assert.equal(receipt.actor,caller==='admin'?'admin':'bob');assert.equal(receipt.authorization,caller==='admin'?'RECOVERY_ADMIN':'OWNER');
    const before=state(f);f.api().requestStop(running.p.planId,bob);assert.deepEqual(state(f),before);
  }finally{running.complete();}
  const r=await running.run;assert.equal(r.invocation?.outcome,'USER_STOP');assert.equal(r.invocation?.status,'STOPPED');
  assert.equal(r.usage.committed.inputTokens,1);assert.equal(r.usage.outstanding.inputTokens,0);assert.equal(r.artifact,undefined);
  assert.equal(f.counts.draft,1);assert.equal(f.counts.action,0);assert.equal(r.control.planningReviewPending,false);
});

for(const invalid of ['unauthenticated','forged-admin','viewer','no-view','other-workflow','missing-plan','no-lease'] as const)test(`RT-02: ${invalid} STOP changes neither DB nor Provider signal`,async t=>{
  const {f,alice,bob,admin}=actors(t);
  let api=f.api(),credential:unknown=alice;
  if(invalid==='unauthenticated')credential={};if(invalid==='forged-admin')credential={actorId:'admin',roles:['RECOVERY_ADMIN']};
  if(invalid==='viewer')credential=f.identity.credential('viewer',['RECOVERY_VIEWER']);
  if(invalid==='no-view'){credential=admin;f.policy.canAccess=((who)=>who.actorId!=='admin') as ContinuationPolicy['canAccess'] as typeof f.policy.canAccess;}
  if(invalid==='other-workflow'){f.admin.createWorkflow(executionSeed('ALLOW','other'));api=new RecoveryContinuationCoordinator(f.db,f.manager.acquire('other'));credential=bob;}
  if(invalid==='no-lease'){api=new RecoveryContinuationCoordinator(f.db);credential=bob;}
  const running=await pending(f,bob),before=state(f);
  try{assert.throws(()=>api.requestStop(invalid==='missing-plan'?'missing':running.p.planId,credential));assert.equal(running.signal.aborted,false);assert.deepEqual(state(f),before);}
  finally{running.complete();await running.run;}
});

test('RT-02: STOP Audit failure rolls back and cannot emit abort',async t=>{
  const {f,bob}=actors(t),running=await pending(f,bob),before=state(f);
  f.raw.exec("CREATE TRIGGER fail_stop_audit BEFORE INSERT ON bounded_audit WHEN NEW.entity_table='recovery_continuation_receipts' BEGIN SELECT RAISE(ABORT,'injected'); END");
  try{assert.throws(()=>f.api().requestStop(running.p.planId,bob));assert.deepEqual(state(f),before);assert.equal(running.signal.aborted,false);}
  finally{f.raw.exec('DROP TRIGGER fail_stop_audit');running.complete();await running.run;}
});

test('RT-02: lost STOP COMMIT ACK aborts only after re-reading the exact committed receipt',async t=>{
  const {f,bob}=actors(t),running=await pending(f,bob);let observed=false;
  running.signal.addEventListener('abort',()=>{
    assert.equal(f.raw.prepare('SELECT status FROM recovery_invocations').get()!.status,'DRAINING');
    assert.equal(f.raw.prepare("SELECT count(*) n FROM recovery_continuation_receipts WHERE kind='STOP'").get()!.n,1);
    // Observer callbacks receive no SQL authority from the committing coordinator.
    assert.throws(()=>f.db.writeWithLease(f.lease,'run',tx=>tx.run("UPDATE recovery_invocations SET outcome='forged',revision=revision+1")));
    observed=true;
  },{once:true});
  try{
    await fault('INSERT INTO recovery_continuation_receipts','ACK',async()=>f.api().requestStop(running.p.planId,bob));
    assert.equal(observed,true);const saved=state(f);f.api().requestStop(running.p.planId,bob);assert.deepEqual(state(f),saved);
  }finally{running.complete();await running.run;}
  assert.equal(f.counts.draft,1);assert.equal(f.counts.action,0);
});

test('RT-02: a committed STOP on another connection prevents late revision publication and further calls',async t=>{
  const {f,bob}=actors(t),a=await plan(f,bob),p=f.api().requestRevision(a.artifact!,f.input('PLAN_READ_ONLY'),bob),running=await pending(f,bob,p,
    {kind:'read_requests',requests:[{resourceId:'source',digest:f.reads.describe('source')!.digest}]});
  const db=new DurableDatabase(f.options),other=new RecoveryContinuationCoordinator(db,f.lease);
  try{
    other.requestStop(p.planId,bob);assert.equal(running.signal.aborted,false);
    const saved=state(f);other.requestStop(p.planId,bob);assert.deepEqual(state(f),saved);
  }finally{db.close();running.complete();}
  const r=await running.run;assert.equal(r.invocation?.outcome,'USER_STOP');assert.equal(r.control.planningReviewPending,true);
  assert.equal(r.artifact,undefined);assert.equal(r.usage.committed.inputTokens,1);assert.equal(r.usage.outstanding.inputTokens,0);
  assert.equal(r.counts.readCalls,0);assert.equal(r.counts.modelCalls,1);
  assert.equal(f.raw.prepare('SELECT count(*) n FROM planning_artifacts').get()!.n,1);assert.equal(f.counts.draft,2);assert.equal(f.counts.action,0);
});

test('RT-01/RT-02: STOP after Usage settlement still prevents publication and preserves the prior gate',async t=>{
  const {f,bob}=actors(t),a=await plan(f,bob),p=f.api().requestRevision(a.artifact!,f.input(),bob);let stopped=false;
  f.policy.inspectContent=((text:string)=>{
    if(!stopped&&text.includes('"objective"')){stopped=true;f.api().requestStop(p.planId,bob);}return true;
  }) as typeof f.policy.inspectContent;
  const r=await f.api().startAuthorized(p.planId,bob);
  assert.equal(stopped,true);assert.equal(r.artifact,undefined);assert.equal(r.control.planningReviewPending,true);
  assert.equal(f.raw.prepare('SELECT count(*) n FROM planning_artifacts').get()!.n,1);
  assert.equal(f.raw.prepare('SELECT count(*) n FROM planning_reviews').get()!.n,0);
  assert.equal(r.usage.committed.inputTokens,1);assert.equal(f.counts.draft,2);assert.equal(f.counts.action,0);
  assert.throws(()=>f.store.assertRecoveryExecution('run'));
});

test('RT-01: timed-out revision with complete late Usage retains the original review',async t=>{
  const f=continuationFixture(t,{modelTimeoutMs:1000}),a=await plan(f,f.credential);
  f.hook(async request=>{await new Promise<void>(resolve=>request.signal.addEventListener('abort',()=>resolve(),{once:true}));
    return {value:{kind:'plan',artifact:content},usage,completeness:'COMPLETE'};});
  const p=f.api().requestRevision(a.artifact!,f.input(),f.credential),r=await f.api().startAuthorized(p.planId,f.credential);
  assert.equal(r.invocation?.outcome,'MODEL_TIMEOUT');assert.equal(r.artifact,undefined);assert.equal(r.control.planningReviewPending,true);
  assert.equal(r.usage.committed.inputTokens,1);assert.equal(r.usage.outstanding.inputTokens,0);
  assert.equal(f.api().inspect(a.plan.planId,f.credential).review.target?.artifactId,a.artifact!.artifactId);
  assert.throws(()=>f.store.assertRecoveryExecution('run'));assert.equal(f.counts.action,0);
});

test('RT-02: concurrent owner/admin STOPs produce one receipt and one abort',async t=>{
  const {f,bob,admin}=actors(t),running=await pending(f,bob),db=new DurableDatabase(f.options),other=new RecoveryContinuationCoordinator(db,f.lease);let aborts=0;
  running.signal.addEventListener('abort',()=>aborts++);
  try{
    await Promise.all([Promise.resolve().then(()=>other.requestStop(running.p.planId,admin)),Promise.resolve().then(()=>f.api().requestStop(running.p.planId,bob))]);
    assert.equal(aborts,1);assert.equal(f.raw.prepare("SELECT count(*) n FROM recovery_continuation_receipts WHERE kind='STOP'").get()!.n,1);
    assert.equal(JSON.parse(String(f.raw.prepare("SELECT receipt_json FROM recovery_continuation_receipts WHERE kind='STOP'").get()!.receipt_json)).actor,'admin');
  }finally{db.close();running.complete();await running.run;}
  assert.equal(f.counts.draft,1);assert.equal(f.counts.action,0);
});
