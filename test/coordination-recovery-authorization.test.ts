import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { DurableDatabase, SqliteCoordinationRunnerStore, RecoveryPlanner, RecoveryAuthorizer, RecoveryReader, DurableExecutionCoordinator, ModelCallLedger, DurableModelCallCoordinator, createDurableCoordinationRunner } from '../services/coordination/durable/index.ts';
import { digest } from '../services/coordination/durable/integrity.ts';
import { scopeOf } from '../services/coordination/durable/recoveryDecisionStore.ts';
import { authorizationFixture } from './recovery-authorization-fixture.ts';
import { registration, record, clock, model } from './durable-execution-fixture.ts';
import { testModel } from './model-call-fixture.ts';
import { createRunnerEvent } from '../services/coordination/runner/eventFactory.ts';
import { usage } from './durable-fixture.ts';

test('preview and reader are read-only; canonical plan survives its own audit and a second plan',t=>{
  const f=authorizationFixture(t),changes=()=>f.db.read(tx=>tx.get('SELECT total_changes() AS n')!.n),before=changes();
  assert.equal(f.planner.preview('run').candidates.length,1);
  assert.equal(new RecoveryReader(f.db).inspect('run').executionAllowed,false);
  assert.equal(changes(),before);
  const p=f.plan(),{planDigest,...body}=p;assert.equal(planDigest,digest(body));f.plan();
  const g=f.authorize(p);assert.equal(f.authorizer.inspect(g.authorizationId,scopeOf(p)).valid,true);
  assert.equal(f.authorizer.inspect(g.authorizationId,scopeOf(p)).executionAllowed,false);
  assert.equal(new RecoveryReader(f.db).inspect('run').recoveryDecisions?.authorizations[0].status,'AUTHORIZED');
});
test('production default has no issuer; a self-declared actor, role and approved flag cannot authenticate',t=>{
  const f=authorizationFixture(t),db=new DurableDatabase({path:f.path});t.after(()=>db.close());
  const planner=new RecoveryPlanner(db,f.lease);
  assert.throws(()=>planner.createPlan({workflowRunId:'run',operationKind:'BOUNDED_CONTINUATION',targetId:'run'},{actorId:'admin',role:'RECOVERY_ADMIN',approved:true}),{code:'RECOVERY_UNAUTHENTICATED'});
  assert.throws(()=>f.plan(0));
  const p=f.plan();assert.throws(()=>f.authorize(p,{actorId:'operator',roles:['RECOVERY_ADMIN']}),{code:'RECOVERY_UNAUTHENTICATED'});
});
for(const role of ['RECOVERY_VIEWER','RECOVERY_OPERATOR'] as const)test(`${role} cannot approve`,t=>{
  const f=authorizationFixture(t),p=f.plan();assert.throws(()=>f.authorize(p,f.identity.credential('actor',[role])),{code:'RECOVERY_UNAUTHORIZED'});
});
test('approver cannot register plans; operator can register but not approve; admin may revoke others',t=>{
  const f=authorizationFixture(t),operator=f.identity.credential('author',['RECOVERY_OPERATOR']),approver=f.identity.credential('reviewer',['RECOVERY_APPROVER']);
  const input={workflowRunId:'run',operationKind:'BOUNDED_CONTINUATION' as const,targetId:'run'};
  assert.throws(()=>f.planner.createPlan(input,approver),{code:'RECOVERY_UNAUTHORIZED'});
  const p=f.planner.createPlan(input,operator),g=f.authorize(p,approver);
  assert.throws(()=>f.authorizer.revoke(g.authorizationId,f.identity.credential('other',['RECOVERY_APPROVER'])),{code:'RECOVERY_UNAUTHORIZED'});
  assert.equal(f.authorizer.revoke(g.authorizationId,f.credential).status,'REVOKED');
});
test('viewer may use authenticated read boundary but cannot plan, approve or revoke',t=>{
  const f=authorizationFixture(t),viewer=f.identity.credential('viewer',['RECOVERY_VIEWER']);
  assert.equal(f.decisions.view('run',viewer).executionAllowed,false);
  assert.throws(()=>f.decisions.view('run',{}),{code:'RECOVERY_UNAUTHENTICATED'});
  assert.throws(()=>f.planner.createPlan({workflowRunId:'run',operationKind:'BOUNDED_CONTINUATION',targetId:'run'},viewer),{code:'RECOVERY_UNAUTHORIZED'});
  const g=f.authorize();assert.throws(()=>f.authorizer.revoke(g.authorizationId,viewer),{code:'RECOVERY_UNAUTHORIZED'});
});
for(const [key,value] of Object.entries({workflowRunId:'other',operationKind:'CANCEL_UNSENT_MODEL',targetId:'other',planDigest:'0'.repeat(64),operationContractVersion:'COORD-5C-4B'}))test(`grant scope rejects changed ${key}`,t=>{
  const f=authorizationFixture(t),p=f.plan(),g=f.authorize(p),scope={...scopeOf(p),[key]:value};
  assert.throws(()=>f.authorizer.authorize(p.recoveryPlanId,scope,f.credential),{code:'RECOVERY_UNAUTHORIZED'});
  assert.throws(()=>f.authorizer.inspect(g.authorizationId,scope),{code:'RECOVERY_UNAUTHORIZED'});
});
test('duplicate authorization/revocation is idempotent, never refreshes TTL, and a revoked grant cannot be revived',t=>{
  const f=authorizationFixture(t),p=f.plan(),g=f.authorize(p);
  assert.deepEqual(f.authorize(p),g);assert.equal(f.authorize(p).expiresAt,g.expiresAt);
  const revoked=f.authorizer.revoke(g.authorizationId,f.credential);assert.deepEqual(f.authorizer.revoke(g.authorizationId,f.credential),revoked);
  assert.equal(f.authorizer.inspect(g.authorizationId,scopeOf(p)).valid,false);
  assert.throws(()=>f.authorize(p),{code:'RECOVERY_UNAUTHORIZED'});
  assert.equal(f.raw.prepare("SELECT count(*) n FROM runtime_audit_events WHERE event_kind='RECOVERY_REVOKED'").get()!.n,1);
});
test('expiry is derived with database time without a reader mutation',async t=>{
  const f=authorizationFixture(t),p=f.plan(),g=f.authorize(p,f.credential,80);await delay(100);
  const before=f.raw.prepare('SELECT count(*) n FROM runtime_audit_events').get()!.n;
  assert.equal(f.authorizer.inspect(g.authorizationId,scopeOf(p)).authorization.status,'EXPIRED');
  assert.equal(f.raw.prepare('SELECT status FROM recovery_authorizations').get()!.status,'AUTHORIZED');
  assert.equal(f.raw.prepare('SELECT count(*) n FROM runtime_audit_events').get()!.n,before);
});
test('self approval and multiple distinct approvers are policy requirements; quorum still cannot execute',t=>{
  const f=authorizationFixture(t,{BOUNDED_CONTINUATION:{minimumApprovers:2,forbidSelfApproval:true}}),p=f.plan();
  assert.throws(()=>f.authorize(p),{code:'RECOVERY_UNAUTHORIZED'});
  const a=f.authorize(p,f.identity.credential('a',['RECOVERY_APPROVER']));
  assert.equal(f.authorizer.inspect(a.authorizationId,scopeOf(p)).quorumSatisfied,false);
  f.authorize(p,f.identity.credential('b',['RECOVERY_APPROVER']));
  assert.equal(f.authorizer.inspect(a.authorizationId,scopeOf(p)).quorumSatisfied,true);
  assert.equal(f.authorizer.inspect(a.authorizationId,scopeOf(p)).executionAllowed,false);
});
test('journal/budget movement invalidates plan and existing authorization, and explicit invalidation is audited',t=>{
  const f=authorizationFixture(t),p=f.plan(),g=f.authorize(p);f.store.append(usage(f.store.getSnapshot('run')));
  assert.equal(f.authorizer.inspect(g.authorizationId,scopeOf(p)).valid,false);
  assert.throws(()=>f.authorize(p),{code:'RECOVERY_INVALID_PLAN'});
  f.authorizer.invalidate(p.recoveryPlanId,f.credential);
  assert.equal(f.decisions.inspect('run').plans[0].status,'INVALIDATED');
});
test('a new generation invalidates both plans and grants even after a clean release',t=>{
  const f=authorizationFixture(t),p=f.plan(),g=f.authorize(p);f.manager.release(f.lease);const lease=f.manager.acquire('run');
  assert.equal(new RecoveryAuthorizer(f.db,lease).inspect(g.authorizationId,scopeOf(p)).valid,false);
  assert.throws(()=>f.authorize(p),{code:'LEASE_FENCED'});
});
test('new healthy workflow and normal action registration are not held',t=>{
  const f=authorizationFixture(t);f.store.assertRecoveryExecution('run');
  const c=new DurableExecutionCoordinator(f.store,{get:()=>undefined}),r=registration(f.store);
  c.registerAction(record,r.expected,r.sessionEvent,r.taskEvent);
  assert.equal(f.decisions.inspect('run').holds.length,0);
  assert.equal(f.planner.preview('run').candidates.some(c=>c.operationKind==='ALLOW_PREPARED_DISPATCH'),true);
});
test('hold persists across release/reacquire; approvals cannot clear it or issue operations',t=>{
  const f=authorizationFixture(t);f.hold();const p=f.plan(),g=f.authorize(p);
  assert.equal(f.decisions.inspect('run').holds.length,1);assert.equal(g.status,'AUTHORIZED');
  f.manager.renew(f.lease);assert.equal(new RecoveryReader(f.db).inspect('run').executionAllowed,false);
  f.manager.release(f.lease);const lease=f.manager.acquire('run');assert.throws(()=>f.db.assertRecoveryExecution(lease,'run'),{code:'RECOVERY_HELD'});
  assert.throws(()=>f.db.writeWithLease(lease,'run',tx=>tx.run('DELETE FROM recovery_holds')));
  assert.throws(()=>f.db.writeWithLease(lease,'run',tx=>tx.run("UPDATE recovery_authorizations SET status='CONSUMED'")));
  assert.throws(()=>f.db.writeWithLease(lease,'run',tx=>tx.run("INSERT INTO recovery_operations VALUES ('op',?,'run','BOUNDED_CONTINUATION','COMMITTED','forged')",g.authorizationId)),{code:'RECOVERY_EXECUTION_DISABLED'});
});
test('lease-fenced direct store, coordinator, model ledger and resume routes reject held workflows',t=>{
  const f=authorizationFixture(t);f.hold();
  const c=new DurableExecutionCoordinator(f.store,{get:()=>undefined});
  assert.throws(()=>c.reserveDispatch('run',{} as never),{code:'RECOVERY_HELD'});
  assert.throws(()=>f.store.append(usage(f.store.getSnapshot('run'))),{code:'RECOVERY_HELD'});
  assert.throws(()=>f.store.append({...usage(f.store.getSnapshot('run')),type:'WorkflowResumed',payload:{}}),{code:'RECOVERY_HELD'});
  assert.throws(()=>new ModelCallLedger(f.store).markDispatchIntent({workflowRunId:'run',modelCallId:'x',attemptId:'x',modelId:'x',providerId:'x'}),{code:'INTEGRITY_ERROR'});
});
test('SQL functions are observations, not setters; invented DTOs and an independent connection confer no authority',t=>{
  const f=authorizationFixture(t),p=f.plan();
  f.db.writeWithLease(f.lease,'run',tx=>{
    assert.equal(tx.get("SELECT map_recovery_management('run','AUTHORIZE','forged') AS n")!.n,0);
    assert.equal(tx.get("SELECT map_recovery_audit('run','RECOVERY_AUTHORIZED',?,'forged',NULL) AS n",p.recoveryPlanId)!.n,0);
  });
  assert.throws(()=>f.authorizer.inspect('forged',scopeOf(p)),{code:'RECOVERY_UNAUTHORIZED'});
  assert.throws(()=>f.raw.prepare("INSERT INTO recovery_plan_invalidations VALUES (?,'run','STATE_CHANGED',1,'fake')").run(p.recoveryPlanId));
  assert.throws(()=>f.db.writeWithLease(f.lease,'run',tx=>tx.run("INSERT INTO recovery_plan_invalidations VALUES (?,'run','STATE_CHANGED',1,'fake')",p.recoveryPlanId)),{code:'RECOVERY_UNAUTHORIZED'});
});
for(const operation of ['plan','authorization','revocation'] as const)test(`${operation} and its audit roll back together on audit failure`,t=>{
  const f=authorizationFixture(t),p=operation==='plan'?undefined:f.plan(),g=operation==='revocation'?f.authorize(p):undefined;
  f.raw.exec("CREATE TRIGGER test_reject_audit BEFORE INSERT ON runtime_audit_events WHEN NEW.event_kind LIKE 'RECOVERY_%' BEGIN SELECT RAISE(ABORT,'FAIL'); END;");
  assert.throws(()=>operation==='plan'?f.plan():operation==='authorization'?f.authorize(p):f.authorizer.revoke(g!.authorizationId,f.credential));
  assert.equal(f.raw.prepare('SELECT count(*) n FROM recovery_plans').get()!.n,operation==='plan'?0:1);
  assert.equal(f.raw.prepare('SELECT count(*) n FROM recovery_authorizations').get()!.n,operation==='revocation'?1:0);
  if(g)assert.equal(f.raw.prepare('SELECT status FROM recovery_authorizations').get()!.status,'AUTHORIZED');
});
test('tampering with approval provenance or its audit is detected by the diagnostic reader',t=>{
  const f=authorizationFixture(t);f.authorize();f.raw.exec("DROP TRIGGER audit_no_update; UPDATE runtime_audit_events SET recovery_actor_id='forged' WHERE event_kind='RECOVERY_AUTHORIZED'");
  assert.equal(new RecoveryReader(f.db).inspect('run').disposition,'RECOVERY_FAILED');
});

function modelRequest(f:ReturnType<typeof authorizationFixture>) {
  const s=f.store.getSnapshot('run');return {workflowRunId:'run',modelCallId:'model',attemptId:'attempt',providerId:'test',modelId:'test',roundKey:'round',phase:'PLAN' as const,
    requestCursor:s.events.length,requestEventId:s.events.at(-1)!.eventId,
    quote:{providerId:'test',modelId:'test',maxAttempts:1 as const,inputTokens:1,maxOutputTokens:1,maxEstimatedCost:0,pricingId:'test',conditions:'test',requestDigest:'a'.repeat(64)}};
}
test('target Action state movement invalidates a saved plan before approval',t=>{
  const f=authorizationFixture(t),executor={id:'test',prepare:async()=>record.action,execute:async()=>({status:'succeeded' as const,summary:'test'})};
  const c=new DurableExecutionCoordinator(f.store,{get:()=>executor},{clock}),r=registration(f.store);c.registerAction(record,r.expected,r.sessionEvent,r.taskEvent);
  const p=f.planner.createPlan({workflowRunId:'run',operationKind:'ALLOW_PREPARED_DISPATCH',targetId:'action'},f.credential);
  c.reserveDispatch('run',f.store.getSnapshot('run').tasks.task);
  assert.throws(()=>f.authorize(p),{code:'RECOVERY_INVALID_PLAN'});
  assert.equal(f.planner.preview('run').candidates.some(c=>c.operationKind==='ALLOW_PREPARED_DISPATCH'),false);
});
test('model reservation cancellation changes both model and budget digests; no fabricated zero settlement candidate',t=>{
  const f=authorizationFixture(t),ledger=new ModelCallLedger(f.store,clock),x=modelRequest(f);ledger.reserve(x);
  const p=f.planner.createPlan({workflowRunId:'run',operationKind:'CANCEL_UNSENT_MODEL',targetId:'model'},f.credential);
  ledger.cancelBeforeDispatch(x);assert.throws(()=>f.authorize(p),{code:'RECOVERY_INVALID_PLAN'});
  assert.equal(f.planner.preview('run').candidates.some(c=>c.operationKind==='RECONCILE_VERIFIED_USAGE'),false);
});
test('policy and approval requirement changes invalidate prior authorization on another connection',t=>{
  const f=authorizationFixture(t),p=f.plan(),g=f.authorize(p);
  const db=new DurableDatabase({path:f.path,recoveryIdentityVerifier:f.identity.verifier,recoveryAuthorizationPolicy:{BOUNDED_CONTINUATION:{minimumApprovers:2,forbidSelfApproval:true}}});
  t.after(()=>db.close());const authorizer=new RecoveryAuthorizer(db,f.lease);
  assert.equal(authorizer.inspect(g.authorizationId,scopeOf(p)).valid,false);
  assert.throws(()=>authorizer.authorize(p.recoveryPlanId,scopeOf(p),f.credential),{code:'RECOVERY_INVALID_PLAN'});
});
test('hold revision and terminal workflow invalidate a formerly valid plan',t=>{
  const f=authorizationFixture(t),p=f.plan(),g=f.authorize(p);f.hold();
  assert.equal(f.authorizer.inspect(g.authorizationId,scopeOf(p)).valid,false);
});
test('terminal workflow cannot be planned or authorized',t=>{
  const f=authorizationFixture(t),p=f.plan();
  f.store.append(createRunnerEvent(f.store.getSnapshot('run'),'WorkflowCancelled',{},clock,{nextId:()=> 'cancel'}));
  assert.equal(f.planner.preview('run').candidates.length,0);assert.throws(()=>f.authorize(p),{code:'RECOVERY_INVALID_PLAN'});
});
for(const ttl of [0,-1,1800001,Infinity,NaN])test(`invalid authorization lifetime ${ttl} fails closed`,t=>{
  const f=authorizationFixture(t),p=f.plan();assert.throws(()=>f.authorize(p,f.credential,ttl));
  assert.equal(f.decisions.inspect('run').authorizations.length,0);
});
test('database clock anomaly refuses issue and inspection',t=>{
  const f=authorizationFixture(t),p=f.plan(),g=f.authorize(p),prepare=DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare=function(sql:string){
    const statement=prepare.call(this,sql);
    if(sql.includes("unixepoch('subsec')")) statement.get=()=>({now:-1});
    return statement;
  };
  try{assert.throws(()=>f.authorize(p));assert.throws(()=>f.authorizer.inspect(g.authorizationId,scopeOf(p)));}finally{DatabaseSync.prototype.prepare=prepare;}
});
test('read failure cannot be translated to a valid authorization',t=>{
  const f=authorizationFixture(t),p=f.plan(),g=f.authorize(p),prepare=DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare=function(sql:string){if(sql.includes('FROM recovery_authorizations'))throw Error('private failure');return prepare.call(this,sql);};
  try{assert.throws(()=>f.authorizer.inspect(g.authorizationId,scopeOf(p)),{code:'DATABASE_ERROR'});}finally{DatabaseSync.prototype.prepare=prepare;}
});
test('model intent and Runner entry points cannot bypass hold, including with an AUTHORIZED plan',async t=>{
  const f=authorizationFixture(t),l=new ModelCallLedger(f.store,clock),x=modelRequest(f);l.reserve(x);
  f.hold();const p=f.planner.createPlan({workflowRunId:'run',operationKind:'CANCEL_UNSENT_MODEL',targetId:'model'},f.credential);f.authorize(p);
  assert.throws(()=>l.markDispatchIntent(x),{code:'RECOVERY_HELD'});
  let calls=0;const provider=testModel({plan:async()=>{calls++;return model({kind:'needs_user',reason:'test'});},verify:async()=>{calls++;return model({taskOutcome:'FAIL',summary:'test',criteria:[]});}});
  const c=new DurableModelCallCoordinator(f.store,provider,clock);await assert.rejects(c.call({workflowRunId:'run',roundKey:'other',phase:'PLAN',requestCursor:1,requestEventId:'x',request:{} as any}),{code:'RECOVERY_HELD'});
  const runner=createDurableCoordinationRunner({coordinator:new DurableExecutionCoordinator(f.store,{get:()=>undefined},{clock}),supervisorProvider:provider,clock});
  const before=f.store.getSnapshot('run');await runner.runOneRound('run');await runner.runUntilStop('run');assert.equal(calls,0);assert.deepEqual(f.store.getSnapshot('run'),before);
});
test('raw SQL dispatch observes unresolved Model intent, even before a persistent hold has been created',t=>{
  const f=authorizationFixture(t),executor={id:'test',prepare:async()=>record.action,execute:async()=>({status:'succeeded' as const,summary:'test'})};
  const c=new DurableExecutionCoordinator(f.store,{get:()=>executor},{clock}),r=registration(f.store);c.registerAction(record,r.expected,r.sessionEvent,r.taskEvent);
  const ledger=new ModelCallLedger(f.store,clock),x=modelRequest(f);ledger.reserve(x);ledger.markDispatchIntent(x);
  assert.equal(f.decisions.inspect('run').holds.length,0);
  assert.throws(()=>f.store.writeWorkflow('run',tx=>tx.run("UPDATE execution_ledger SET state='DISPATCH_RESERVED',attempt_id='forged',reserved_at=10,updated_at=10 WHERE action_id='action'")),{code:'RECOVERY_HELD'});
  assert.equal(c.inspectExecution('run','action')!.state,'PREPARED');
});
test('a risky clean lease release cannot enable direct Result reflection after reacquisition',t=>{
  const f=authorizationFixture(t),l=new ModelCallLedger(f.store,clock),x=modelRequest(f);l.reserve(x);l.markDispatchIntent(x);
  f.manager.release(f.lease);const lease=f.manager.acquire('run');assert.equal(f.decisions.inspect('run').holds[0].origin,'ACQUIRE');
  assert.throws(()=>f.admin.withLease(lease).append(usage(f.admin.getSnapshot('run'))),{code:'RECOVERY_HELD'});
});
test('same-plan duplicate approval on independent connections is unique and cancellation records the actual administrator',async t=>{
  const f=authorizationFixture(t),p=f.plan(),db=new DurableDatabase({path:f.path,recoveryIdentityVerifier:f.identity.verifier});t.after(()=>db.close());
  const second=new RecoveryAuthorizer(db,f.lease),credential=f.identity.credential('approver',['RECOVERY_APPROVER']);
  const outcomes=await Promise.all([Promise.resolve().then(()=>f.authorize(p,credential)),Promise.resolve().then(()=>second.authorize(p.recoveryPlanId,scopeOf(p),credential))]);
  assert.equal(outcomes[0].authorizationId,outcomes[1].authorizationId);
  const revoked=f.authorizer.revoke(outcomes[0].authorizationId,f.credential);assert.equal(revoked.revokedByActorId,'operator');
  assert.equal(new RecoveryReader(f.db).getWorkflowTimeline('run').entries.find(e=>e.eventKind==='RECOVERY_REVOKED')!.recoveryActorId,'operator');
});
test('a competing SQLite writer refuses authorization without partial records and fences the uncertain lease',t=>{
  const f=authorizationFixture(t),p=f.plan();
  const db=new DurableDatabase({path:f.path,busyTimeoutMs:0,recoveryIdentityVerifier:f.identity.verifier});t.after(()=>db.close());
  const second=new RecoveryAuthorizer(db,f.lease);
  f.raw.exec('BEGIN IMMEDIATE');
  try {
    assert.throws(()=>second.authorize(p.recoveryPlanId,scopeOf(p),f.credential),{code:'DATABASE_BUSY'});
    assert.equal(f.raw.prepare('SELECT count(*) n FROM recovery_authorizations').get()!.n,0);
    assert.equal(f.raw.prepare("SELECT count(*) n FROM runtime_audit_events WHERE event_kind='RECOVERY_AUTHORIZED'").get()!.n,0);
  } finally { f.raw.exec('ROLLBACK'); }
  // Preserve 5C-2: DATABASE_BUSY invalidates the handle; a retry cannot assume ownership.
  assert.throws(()=>second.authorize(p.recoveryPlanId,scopeOf(p),f.credential),{code:'LEASE_FENCED'});
  assert.throws(()=>f.authorize(p),{code:'LEASE_FENCED'});
  assert.equal(f.raw.prepare('SELECT count(*) n FROM recovery_authorizations').get()!.n,0);
  assert.equal(f.raw.prepare("SELECT count(*) n FROM runtime_audit_events WHERE event_kind='RECOVERY_AUTHORIZED'").get()!.n,0);
});
test('plan JSON/digest and grant scope are immutable through valid lease SQL',t=>{
  const f=authorizationFixture(t);f.authorize();
  for(const sql of ["UPDATE recovery_plans SET plan_digest='forged'","UPDATE recovery_authorizations SET target_id='other'","DELETE FROM recovery_plans","DELETE FROM recovery_authorizations"])
    assert.throws(()=>f.store.writeWorkflow('run',tx=>tx.run(sql)));
  assert.notEqual(new RecoveryReader(f.db).inspect('run').disposition,'RECOVERY_FAILED');
});
