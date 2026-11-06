import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { DurableDatabase, RecoveryReader, RecoveryPlanner, RecoveryAuthorizer } from '../services/coordination/durable/index.ts';
import { SafeRecoveryPlanner, SafeRecoveryAuthorizer, SafeRecoveryExecutor } from '../services/coordination/durable/safeRecoveryExecutor.ts';
import { executionScopeOf } from '../services/coordination/durable/safeRecoveryStore.ts';
import { scopeOf } from '../services/coordination/durable/recoveryDecisionStore.ts';
import { createRunnerEvent } from '../services/coordination/runner/eventFactory.ts';
import { clock } from './durable-execution-fixture.ts';
import { usage } from './durable-fixture.ts';
import { ModelCallLedger } from '../services/coordination/durable/modelCallLedger.ts';
import { digest } from '../services/coordination/durable/integrity.ts';
import { recoveryExecutionFixture as fixture, recoveryContents, corruptTable, withoutTestTriggers } from './recovery-execution-fixture.ts';

function ready(t: Parameters<typeof fixture>[0], policy: Parameters<typeof fixture>[1] = {}) {
  const f = fixture(t, policy); f.reserve(); f.reacquire(); return f;
}
const count = (f: ReturnType<typeof fixture>, table: string) => Number(f.raw.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);

test('4B plan digest binds the execution contract and survives its own approvals/audit and unrelated plan creation', t => {
  const f = ready(t), p = f.plan(), {planDigest,...body} = p;
  assert.equal(p.operationContractVersion, 'COORD-5C-4B:EXECUTE:1'); assert.equal(planDigest,digest(body));
  assert.equal(f.rebind().planner.preview('run').executionAllowed,false); f.plan();
  const a = f.authorize(p); assert.equal(a.status,'AUTHORIZED');
  assert.equal(f.execute(p).status,'COMMITTED'); assert.equal(count(f,'recovery_execution_operations'),1);
});
test('4A plan and record-only grant cannot authorize any 4B execution and remain unchanged', t => {
  const f = ready(t), p = new RecoveryPlanner(f.db,f.lease).createPlan({workflowRunId:'run',operationKind:'CANCEL_UNSENT_MODEL',targetId:'model'},f.credential);
  const g = new RecoveryAuthorizer(f.db,f.lease).authorize(p.recoveryPlanId,scopeOf(p),f.credential);
  const before = recoveryContents(f.raw);
  assert.throws(()=>f.rebind().executor.executeAuthorized(p.recoveryPlanId,f.credential));
  assert.throws(()=>f.rebind().executor.executeAuthorized(g.authorizationId,f.credential));
  assert.deepEqual(recoveryContents(f.raw),before);
});
test('missing verifier and self-declared credential cannot create, approve or execute', t => {
  const f = ready(t), p = f.plan(); f.authorize(p);
  const fake = {actorId:'operator',roles:['RECOVERY_ADMIN'],approved:true};
  assert.throws(()=>f.authorize(p,fake),{code:'RECOVERY_UNAUTHENTICATED'});
  assert.throws(()=>f.execute(p,fake),{code:'RECOVERY_UNAUTHENTICATED'});
  const db = new DurableDatabase({path:f.path}); t.after(()=>db.close());
  assert.throws(()=>new SafeRecoveryExecutor(db,f.lease).executeAuthorized(p.executionPlanId,f.credential),{code:'RECOVERY_UNAUTHENTICATED'});
  assert.throws(()=>new SafeRecoveryPlanner(db,f.lease).createPlan({workflowRunId:'run',operationKind:'CANCEL_UNSENT_MODEL',targetId:'model'},f.credential),{code:'RECOVERY_UNAUTHENTICATED'});
  assert.equal(count(f,'recovery_execution_operations'),0);
});
for (const role of ['RECOVERY_VIEWER','RECOVERY_OPERATOR'] as const) test(`${role} cannot approve execution grants`, t => {
  const f = ready(t), p = f.plan(); assert.throws(()=>f.authorize(p,f.identity.credential('other',[role])),{code:'RECOVERY_UNAUTHORIZED'});
});
test('viewer cannot execute an approved plan',t=>{
  const f=ready(t),p=f.plan();f.authorize(p);assert.throws(()=>f.execute(p,f.identity.credential('viewer',['RECOVERY_VIEWER'])),{code:'RECOVERY_UNAUTHORIZED'});
});
test('quorum requires distinct actors and forbids the plan author from approving',t=>{
  const f=ready(t,{CANCEL_UNSENT_MODEL:{minimumApprovers:2,forbidSelfApproval:true}}),p=f.plan();
  assert.throws(()=>f.authorize(p),{code:'RECOVERY_UNAUTHORIZED'});
  const a=f.identity.credential('a',['RECOVERY_APPROVER']),b=f.identity.credential('b',['RECOVERY_APPROVER']);
  const g=f.authorize(p,a);assert.deepEqual(f.authorize(p,a),g);assert.throws(()=>f.execute(p));
  f.authorize(p,b);const receipt=f.execute(p);assert.equal(receipt.status,'COMMITTED');
  assert.equal(count(f,'recovery_operation_grants'),2);
  assert.deepEqual(f.raw.prepare('SELECT status FROM recovery_execution_grants').all().map(r=>r.status),['CONSUMED','CONSUMED']);
});
test('revoked grant cannot execute or be reauthorized; revocation itself is durable and audited',t=>{
  const f=ready(t),p=f.plan(),g=f.authorize(p);f.rebind().authorizer.revoke(g.authorizationId,f.credential);
  const before=recoveryContents(f.raw);assert.throws(()=>f.execute(p));assert.throws(()=>f.authorize(p));assert.deepEqual(recoveryContents(f.raw),before);
});
test('expired authorization fails without mutating original grant status',async t=>{
  const f=ready(t),p=f.plan();f.authorize(p,f.credential,160);await delay(200);
  const before=recoveryContents(f.raw);assert.throws(()=>f.execute(p));assert.deepEqual(recoveryContents(f.raw),before);
  assert.equal(f.raw.prepare('SELECT status FROM recovery_execution_grants').get()!.status,'AUTHORIZED');
});
test('expired plan cannot be authorized or executed',async t=>{
  const f=ready(t),p=f.plan('CANCEL_UNSENT_MODEL','model',160);f.authorize(p);await delay(200);
  assert.throws(()=>f.authorize(p));assert.throws(()=>f.execute(p));assert.equal(count(f,'recovery_execution_operations'),0);
});
for(const [field,value] of Object.entries({workflowRunId:'other',operationKind:'REFLECT_RECORDED_RESULT',targetId:'other',planDigest:'0'.repeat(64),operationContractVersion:'COORD-5C-4A:RECORD_ONLY:1'}))
  test(`grant rejects scope mismatch ${field}`,t=>{const f=ready(t),p=f.plan();assert.throws(()=>f.rebind().authorizer.authorize(p.executionPlanId,{...executionScopeOf(p),[field]:value},f.credential));assert.equal(count(f,'recovery_execution_grants'),0);});
test('generation change invalidates approved plan with both stale and new lease handles',t=>{
  const f=ready(t),p=f.plan();f.authorize(p);const executor=f.rebind().executor;f.reacquire();
  assert.throws(()=>executor.executeAuthorized(p.executionPlanId,f.credential),{code:'LEASE_FENCED'});assert.throws(()=>f.execute(p));assert.equal(count(f,'recovery_execution_operations'),0);
});
test('changed approval policy on another connection invalidates the saved digest and authorization',t=>{
  const f=ready(t),p=f.plan();f.authorize(p);
  const db=new DurableDatabase({path:f.path,recoveryIdentityVerifier:f.identity.verifier,recoveryAuthorizationPolicy:{CANCEL_UNSENT_MODEL:{minimumApprovers:2,forbidSelfApproval:true}}});t.after(()=>db.close());
  assert.throws(()=>new SafeRecoveryAuthorizer(db,f.lease).authorize(p.executionPlanId,executionScopeOf(p),f.credential));
  assert.throws(()=>new SafeRecoveryExecutor(db,f.lease).executeAuthorized(p.executionPlanId,f.credential));assert.equal(count(f,'recovery_execution_operations'),0);
});
test('an operation advances hold revision and invalidates another already-approved plan without releasing hold',t=>{
  const f=fixture(t);f.reserve('model');f.reserve('second');f.reacquire();const a=f.plan(),b=f.plan('CANCEL_UNSENT_MODEL','second');f.authorize(a);f.authorize(b);
  const hold=f.raw.prepare('SELECT * FROM recovery_holds').all();f.execute(a);assert.throws(()=>f.execute(b));
  assert.deepEqual(f.raw.prepare('SELECT * FROM recovery_holds').all(),hold);assert.equal(count(f,'recovery_hold_transitions'),1);
  const refreshed=f.plan('CANCEL_UNSENT_MODEL','second');f.authorize(refreshed);f.execute(refreshed);assert.equal(count(f,'recovery_hold_transitions'),2);
  assert.throws(()=>f.store.assertRecoveryExecution('run'),{code:'RECOVERY_HELD'});assert.equal(new RecoveryReader(f.db).inspect('run').executionAllowed,false);
});
test('same-plan retries and caller-supplied replacement operation IDs return one receipt without another mutation',t=>{
  const f=ready(t),p=f.plan();f.authorize(p);const receipt=f.execute(p),before=recoveryContents(f.raw);
  assert.deepEqual(f.execute(p),receipt);assert.deepEqual((f.rebind().executor.executeAuthorized as Function)(p.executionPlanId,f.credential,'different-operation'),receipt);
  assert.deepEqual(f.rebind().executor.inspectReceipt(p.executionPlanId,f.credential),receipt);assert.deepEqual(recoveryContents(f.raw),before);
  assert.equal(count(f,'recovery_execution_operations'),1);assert.equal(count(f,'recovery_operation_grants'),1);
});
test('COMMIT succeeds but ACK throws: a new receipt query and retry never execute the operation again',t=>{
  const f=ready(t),p=f.plan();f.authorize(p);const exec=DatabaseSync.prototype.exec;let lost=false;
  DatabaseSync.prototype.exec=function(sql:string){const result=exec.call(this,sql);if(sql==='COMMIT'&&!lost){lost=true;throw Error('lost ACK');}return result;};
  try{try{f.execute(p);}catch{/* Receipt lookup below is the durable outcome. */}}finally{DatabaseSync.prototype.exec=exec;}
  assert.equal(lost,true);assert.equal(count(f,'recovery_execution_operations'),1);const before=recoveryContents(f.raw);
  const receipt=f.rebind().executor.inspectReceipt(p.executionPlanId,f.credential);assert.equal(receipt?.status,'COMMITTED');assert.deepEqual(f.execute(p),receipt);assert.deepEqual(recoveryContents(f.raw),before);
});
for(const table of ['recovery_execution_operations','recovery_execution_grants','recovery_operation_grants','recovery_hold_transitions','recovery_model_resolutions','runtime_audit_events'])
  test(`failure writing ${table} rolls back grants, resolution, hold and audit together`,t=>{
    const f=ready(t),p=f.plan();f.authorize(p);const before=recoveryContents(f.raw),op=table==='recovery_execution_grants'?'UPDATE':'INSERT';
    f.raw.exec(`CREATE TRIGGER reject_recovery_write BEFORE ${op} ON ${table} BEGIN SELECT RAISE(ABORT,'injected fault'); END`);
    assert.throws(()=>f.execute(p));assert.deepEqual(recoveryContents(f.raw),before);
  });
test('two independent connections execute an approved plan at most once',async t=>{
  const f=ready(t),p=f.plan();f.authorize(p);const db=new DurableDatabase({path:f.path,recoveryIdentityVerifier:f.identity.verifier});t.after(()=>db.close());
  const other=new SafeRecoveryExecutor(db,f.lease);const [a,b]=await Promise.all([Promise.resolve().then(()=>f.execute(p)),Promise.resolve().then(()=>other.executeAuthorized(p.executionPlanId,f.credential))]);
  assert.deepEqual(a,b);assert.equal(count(f,'recovery_execution_operations'),1);assert.equal(count(f,'recovery_model_resolutions'),1);
});
test('competing SQLite writer leaves no partial execution and fences uncertain handle',t=>{
  const f=ready(t),p=f.plan();f.authorize(p);const db=new DurableDatabase({path:f.path,busyTimeoutMs:0,recoveryIdentityVerifier:f.identity.verifier});t.after(()=>db.close());
  const before=recoveryContents(f.raw);f.raw.exec('BEGIN IMMEDIATE');try{assert.throws(()=>new SafeRecoveryExecutor(db,f.lease).executeAuthorized(p.executionPlanId,f.credential),{code:'DATABASE_BUSY'});}finally{f.raw.exec('ROLLBACK');}
  assert.deepEqual(recoveryContents(f.raw),before);assert.throws(()=>f.execute(p),{code:'LEASE_FENCED'});
});
for(const sql of ["UPDATE recovery_execution_grants SET status='CONSUMED'",'DELETE FROM recovery_execution_grants',"UPDATE recovery_execution_plans SET target_id='other'",'DELETE FROM recovery_execution_plans',"UPDATE recovery_holds SET active=0"])
  test(`normal lease SQL cannot mutate recovery authority: ${sql}`,t=>{const f=ready(t),p=f.plan();f.authorize(p);const before=recoveryContents(f.raw);assert.throws(()=>f.store.writeWorkflow('run',tx=>tx.run(sql)));assert.deepEqual(recoveryContents(f.raw),before);});
test('PLAN atomicApplication scope does not confer recovery authority, including caught SQL rejection',t=>{
  const f=ready(t),p=f.plan();f.authorize(p);const before=recoveryContents(f.raw);
  assert.throws(()=>f.store.atomicApplication('run',tx=>{try{tx.run("UPDATE recovery_execution_grants SET status='CONSUMED'");}catch{/* attempted privilege escalation */}}));
  assert.deepEqual(recoveryContents(f.raw),before);
});
test('tampered committed receipt audit is rejected rather than permitting reexecution',t=>{
  const f=ready(t),p=f.plan();f.authorize(p);f.execute(p);
  corruptTable(f.raw,'runtime_audit_events',"DELETE FROM runtime_audit_events WHERE event_kind='RECOVERY_OPERATION_COMMITTED'");
  const before=recoveryContents(f.raw);assert.throws(()=>f.rebind().executor.inspectReceipt(p.executionPlanId,f.credential));assert.throws(()=>f.execute(p));assert.deepEqual(recoveryContents(f.raw),before);
});

test('a caught ordinary SQL failure inside authorized execution still poisons the whole transaction',t=>{
  const f=ready(t),p=f.plan();f.authorize(p);const before=recoveryContents(f.raw),write=f.db.writeWithLease.bind(f.db);let injected=false;
  f.db.writeWithLease=(lease,id,fn)=>write(lease,id,tx=>{
    const run=tx.run;
    tx.run=(sql,...params)=>{if(!injected&&sql.startsWith('INSERT INTO recovery_model_resolutions')){injected=true;try{run('INSERT INTO missing_recovery_table VALUES (1)');}catch{/* Internal participant swallows a generic SQL error. */}}run(sql,...params);};
    return fn(tx);
  });
  assert.throws(()=>f.execute(p));assert.equal(injected,true);assert.deepEqual(recoveryContents(f.raw),before);
});
test('receipt remains inspectable after generation changes without reviving spent grants',t=>{
  const f=ready(t),p=f.plan();f.authorize(p);const receipt=f.execute(p);f.reacquire();const before=recoveryContents(f.raw);
  assert.deepEqual(f.rebind().executor.inspectReceipt(p.executionPlanId,f.credential),receipt);assert.deepEqual(f.execute(p),receipt);assert.deepEqual(recoveryContents(f.raw),before);
});
test('SQL observations and an escaped transaction cannot manufacture or retain recovery execution scope',t=>{
  const f=ready(t),p=f.plan();f.authorize(p);let escaped:import('../services/coordination/durable/db.ts').DurableTransaction|undefined;
  f.store.writeWorkflow('run',tx=>{escaped=tx;assert.equal(tx.get("SELECT map_safe_recovery_management('run','EXECUTE',?) AS n",p.executionPlanId)!.n,0);assert.equal(tx.get("SELECT map_safe_recovery_write('run','recovery_model_resolutions','INSERT','model','CANCELLED_UNSENT') AS n")!.n,0);});
  f.execute(p);assert.throws(()=>escaped!.run("UPDATE recovery_execution_grants SET status='CONSUMED'"),{code:'INVALID_TRANSACTION'});
  f.store.atomicApplication('run',tx=>{assert.equal(tx.get("SELECT map_safe_recovery_management('run','EXECUTE',?) AS n",p.executionPlanId)!.n,0);});
});
for(const event of ['RECOVERY_GRANT_CONSUMED','RECOVERY_HOLD_STEP_APPLIED','RECOVERY_MODEL_CANCELLED_UNSENT'])test(`receipt refuses missing ${event} audit and never repeats business writes`,t=>{
  const f=ready(t),p=f.plan();f.authorize(p);f.execute(p);assert.equal(f.raw.prepare('SELECT count(*) AS n FROM runtime_audit_events WHERE event_kind=?').get(event)!.n,1);
  corruptTable(f.raw,'runtime_audit_events','DELETE FROM runtime_audit_events WHERE event_kind=?',event);const before=recoveryContents(f.raw);
  assert.throws(()=>f.rebind().executor.inspectReceipt(p.executionPlanId,f.credential));assert.throws(()=>f.execute(p));assert.deepEqual(recoveryContents(f.raw),before);
});

for(const operationKind of ['ALLOW_PREPARED_DISPATCH','BOUNDED_CONTINUATION','RECONCILE_VERIFIED_USAGE'])test(`unsupported operation ${operationKind} is never executable through the 4B-1 API`,t=>{
  const f=ready(t),before=recoveryContents(f.raw);assert.throws(()=>f.rebind().planner.createPlan({workflowRunId:'run',operationKind,targetId:'model'} as never,f.credential));assert.deepEqual(recoveryContents(f.raw),before);
});
for(const operation of ['plan','authorize','revoke'])test(`4B ${operation} and its audit cannot commit separately`,t=>{
  const f=ready(t),p=operation==='plan'?undefined:f.plan(),g=operation==='revoke'?f.authorize(p!):undefined,before=recoveryContents(f.raw);
  f.raw.exec("CREATE TRIGGER reject_decision_audit BEFORE INSERT ON runtime_audit_events WHEN NEW.event_kind LIKE 'RECOVERY_EXECUTION_%' BEGIN SELECT RAISE(ABORT,'fault'); END");
  assert.throws(()=>operation==='plan'?f.plan():operation==='authorize'?f.authorize(p!):f.rebind().authorizer.revoke(g!.authorizationId,f.credential));assert.deepEqual(recoveryContents(f.raw),before);
});

for(const change of ['journal','usage'] as const)test(`valid ${change} movement after approval invalidates authorization before execution`,t=>{
  const f=ready(t),p=f.plan();f.authorize(p);const hold=f.raw.prepare('SELECT * FROM recovery_holds').all();
  const budgetBefore=new ModelCallLedger(f.store,clock).getBudgetPosition('run');
  withoutTestTriggers(f.raw,['recovery_hold_workflow_seeds_UPDATE','recovery_hold_journal_events_INSERT'],()=>{
    const s=f.store.getSnapshot('run');f.store.append(change==='usage'?usage(s,'later-usage'):
      createRunnerEvent(s,'ProgressRecorded',{outcome:'PROGRESS',summary:'later journal change'},clock,{nextId:()=> 'later-progress'}));
  });
  // Replanning succeeds, demonstrating a valid journal and sources, not malformed storage.
  const current=f.plan();assert.notEqual(current.journalEventId,p.journalEventId);assert.notEqual(current.journalCursor,p.journalCursor);
  if(change==='usage'){assert.notEqual(current.budgetPositionDigest,p.budgetPositionDigest);assert.notDeepEqual(new ModelCallLedger(f.store,clock).getBudgetPosition('run'),budgetBefore);}
  else assert.deepEqual(new ModelCallLedger(f.store,clock).getBudgetPosition('run'),budgetBefore);
  const before=recoveryContents(f.raw);assert.throws(()=>f.execute(p),{code:'RECOVERY_INVALID_PLAN'});assert.throws(()=>f.authorize(p),{code:'RECOVERY_INVALID_PLAN'});assert.deepEqual(recoveryContents(f.raw),before);assert.deepEqual(f.raw.prepare('SELECT * FROM recovery_holds').all(),hold);
});
test('a valid reservation source and budget revision after approval invalidates the digest even when Journal and Hold revision are unchanged',t=>{
  const f=ready(t),p=f.plan();f.authorize(p);
  const source=f.raw.prepare('SELECT * FROM model_call_ledger').get()!,quote=JSON.parse(String(source.quote_json));quote.inputTokens++;
  const names=f.raw.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='model_call_ledger'").all().map(r=>String(r.name));
  withoutTestTriggers(f.raw,names,()=>{f.raw.prepare('UPDATE model_call_ledger SET quote_json=?,reserved_input=reserved_input+1 WHERE model_call_id=?').run(JSON.stringify(quote),'model');});
  const current=f.plan();assert.equal(current.journalCursor,p.journalCursor);assert.equal(current.recoveryHoldRevision,p.recoveryHoldRevision);
  assert.notEqual(current.modelStateDigest,p.modelStateDigest);assert.notEqual(current.budgetPositionDigest,p.budgetPositionDigest);
  const before=recoveryContents(f.raw);assert.throws(()=>f.execute(p),{code:'RECOVERY_INVALID_PLAN'});assert.throws(()=>f.authorize(p),{code:'RECOVERY_INVALID_PLAN'});assert.deepEqual(recoveryContents(f.raw),before);
});
test('a fresh read-only executor without a lease can authenticate and inspect a committed receipt without writes',t=>{
  const f=ready(t),p=f.plan();f.authorize(p);const receipt=f.execute(p),before=recoveryContents(f.raw);
  const db=new DurableDatabase({path:f.path,recoveryIdentityVerifier:f.identity.verifier});t.after(()=>db.close());const executor=new SafeRecoveryExecutor(db);
  assert.deepEqual(executor.inspectReceipt(p.executionPlanId,f.credential),receipt);assert.throws(()=>executor.inspectReceipt(p.executionPlanId,{}),{code:'RECOVERY_UNAUTHENTICATED'});assert.deepEqual(recoveryContents(f.raw),before);
});
