/**
 * The three supplied audit regressions failed against 995c186 (0/3) before correction.
 * Additional cases exercise the fixed payload, authorization and persistence boundaries.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { continuationFixture, content } from './continuation-fixture.ts';
import { hold, executeInput } from './continuation-runner-fixture.ts';
import { createLocalPlanningReadRegistry } from '../services/coordination/durable/planningReadRegistry.ts';
import { RecoveryContinuationCoordinator } from '../services/coordination/durable/recoveryContinuationCoordinator.ts';
import { SafeRecoveryPlanner, SafeRecoveryAuthorizer, SafeRecoveryExecutor } from '../services/coordination/durable/safeRecoveryExecutor.ts';
import { executionScopeOf } from '../services/coordination/durable/safeRecoveryStore.ts';
import type { ContinuationPolicy } from '../services/coordination/durable/continuationTypes.ts';
import { DurableDatabase } from '../services/coordination/durable/db.ts';
import { RecoveryContinuationReader } from '../services/coordination/durable/recoveryContinuationReader.ts';
import { finalizeRecordedResultInTransaction } from '../services/coordination/durable/executionReader.ts';
import { readPendingActionInTransaction } from '../services/coordination/durable/pendingActionStore.ts';
import { SqliteRunnerEvidenceStore } from '../services/coordination/durable/evidenceStore.ts';
import { executionSeed } from './durable-execution-fixture.ts';
import { fault } from './continuation-fault-fixture.ts';
import { digest } from '../services/coordination/durable/integrity.ts';

const usage = { llmCalls: 1, inputTokens: 1, outputTokens: 1, estimatedCost: 0 };

test('PR35 F-01: recheck every cached read before another Provider request', async t => {
  const f = continuationFixture(t);
  writeFileSync(join(f.dir, 'public.txt'), 'A separate public synthetic document.');
  const registry = createLocalPlanningReadRegistry({
    root: f.dir, rootId: 'synthetic', files: { source: 'input.txt', public: 'public.txt' },
  });
  f.options.bounded.reads = registry;
  let sourceAllowed = true;
  const canSend: ContinuationPolicy['canSend'] = (_who, snapshot) =>
    snapshot.id !== 'source' || sourceAllowed;
  f.policy.canSend = canSend as typeof f.policy.canSend;
  const outgoing: Array<{ sourceAllowed: boolean; resourceIds: string[] }> = [];
  f.hook(async request => {
    outgoing.push({ sourceAllowed, resourceIds: request.reads.map(r => r.resourceId) });
    if (outgoing.length === 1) {
      return { value: { kind: 'read_requests', requests: [{ resourceId: 'source', digest: registry.describe('source')!.digest }] }, usage, completeness: 'COMPLETE' };
    }
    if (outgoing.length === 2) {
      assert.equal(sourceAllowed, true);
      assert.ok(request.reads.some(r => r.resourceId === 'source'));
      // Simulate an ACL revocation during an outstanding model request.
      // Keep Policy.version unchanged: canSend is the authoritative current ACL.
      sourceAllowed = false;
      return { value: { kind: 'read_requests', requests: [{ resourceId: 'public', digest: registry.describe('public')!.digest }] }, usage, completeness: 'COMPLETE' };
    }
    return { value: { kind: 'plan', artifact: content }, usage, completeness: 'COMPLETE' };
  });
  const input = f.input('PLAN_READ_ONLY');
  input.resources = ['source', 'public'];
  input.limits.maxModelCalls = 3;
  const p = f.api().createPlan(input, f.credential);
  const result = await f.api().startAuthorized(p.planId, f.credential);
  assert.equal(outgoing.filter(r => !r.sourceAllowed && r.resourceIds.includes('source')).length, 0,
    'No new provider request may contain source after its send permission is revoked.');
  assert.equal(f.counts.action, 0);
  assert.equal(f.counts.prepare, 0);
  assert.equal(outgoing.length, 2);
  assert.equal(result.counts.modelCalls, 2);
  assert.equal(result.counts.readCalls, 2);
  assert.equal(result.usage.committed.inputTokens, 2);
  assert.equal(result.usage.outstanding.inputTokens, 0);
  assert.equal(result.invocation?.status, 'STOPPED');
  assert.equal(result.artifact, undefined);
  assert.deepEqual(result.plan.input, input.input);
  assert.equal(result.plan.createdBy, p.createdBy);
});

test('PR35 F-02: a fresh 4B-1 approval can reflect a recorded result after the old application deadline', async t => {
  const f = continuationFixture(t, {
    actionTimeoutMs: 1000, collectionGraceMs: 50, finalizationMs: 50,
  });
  hold(f);
  const p = f.api().createPlan(executeInput(f), f.credential);
  f.api().authorize(p, f.approver);
  // Leave the Action result committed, but interrupt its normal Task application.
  f.raw.exec(`CREATE TRIGGER audit_stop_initial_application BEFORE UPDATE ON execution_ledger
    WHEN NEW.state='FINALIZED' BEGIN SELECT RAISE(ABORT,'audit application stop'); END;`);
  try { await f.api().startAuthorized(p.planId, f.credential); }
  finally { f.raw.exec('DROP TRIGGER audit_stop_initial_application'); }
  const action = f.raw.prepare("SELECT action_id,state FROM execution_ledger WHERE state='RESULT_RECORDED'").get();
  assert.ok(action, 'Test setup must leave a recorded, unapplied result.');
  assert.equal(f.counts.action, 1);
  const step = f.raw.prepare("SELECT application_deadline FROM recovery_invocation_steps WHERE kind='ACTION' AND target_id=?").get(String(action.action_id));
  assert.ok(step);
  await delay(Math.max(0, Number(step.application_deadline) - Date.now()) + 30);
  const recovery = new SafeRecoveryPlanner(f.db, f.lease).createPlan({
    workflowRunId: 'run', operationKind: 'REFLECT_RECORDED_RESULT', targetId: String(action.action_id),
  }, f.credential);
  new SafeRecoveryAuthorizer(f.db, f.lease).authorize(recovery.executionPlanId, executionScopeOf(recovery), f.approver);
  new SafeRecoveryExecutor(f.db, f.lease).executeAuthorized(recovery.executionPlanId, f.credential);
  assert.equal(f.raw.prepare('SELECT state FROM execution_ledger WHERE action_id=?').get(String(action.action_id))!.state, 'FINALIZED');
  assert.equal(f.counts.action, 1, 'Safe Recovery must not invoke the Executor again.');
  assert.equal(f.raw.prepare("SELECT count(*) n FROM journal_events WHERE event_type='TaskCompleted'").get()!.n, 1);
  assert.deepEqual(f.raw.prepare("SELECT application_deadline FROM recovery_invocation_steps WHERE kind='ACTION' AND target_id=?").get(String(action.action_id)), step);
});

test('PR35 F-03: needs_input questions remain available without regenerating the model answer', async t => {
  const f = continuationFixture(t);
  const questions = ['Which environment is the intended target?', 'What is the permitted retention period?'];
  f.hook(async () => ({ value: { kind: 'needs_input', questions }, usage, completeness: 'COMPLETE' }));
  const p = f.api().createPlan(f.input(), f.credential);
  const first = await f.api().startAuthorized(p.planId, f.credential);
  const reread = new RecoveryContinuationCoordinator(f.db).inspect(p.planId, f.credential);
  // Do not prescribe the final DTO field name; the questions must actually be returned.
  for (const question of questions) {
    assert.ok(JSON.stringify(first).includes(question), 'Initial result must expose the validated question.');
    assert.ok(JSON.stringify(reread).includes(question), 'An authenticated re-read must expose the same saved question.');
  }
  assert.equal(f.counts.draft, 1);
  assert.equal(f.counts.prepare, 0);
  assert.equal(f.counts.action, 0);
  assert.deepEqual(first.inputRequest?.questions, questions);
  assert.deepEqual(reread.inputRequest, first.inputRequest);
  assert.equal(first.inputRequest?.state, 'AWAITING_INPUT');
  assert.equal(first.invocation?.status, 'STOPPED');
  assert.equal(first.invocation?.outcome, 'PLAN_INCOMPLETE');
  assert.equal(first.control.planningReviewPending, false);
  assert.equal(first.control.holdState, 'NONE');
  assert.equal(first.artifact, undefined);
  const second = new DurableDatabase(f.options);
  try {
    const reader = new RecoveryContinuationReader(second);
    assert.deepEqual(reader.inspect(p.planId, f.credential).inputRequest, first.inputRequest);
    assert.ok(reader.timeline(p.planId, f.credential).some(r => r.referenceId === first.inputRequest!.inputRequestId));
    assert.equal(JSON.stringify(reader.timeline(p.planId, f.credential)).includes(questions[0]), false);
    for (const credential of [{}, f.identity.credential('another', ['RECOVERY_VIEWER']), f.identity.credential('another', ['RECOVERY_ADMIN'])])
      assert.throws(() => reader.inspect(p.planId, credential));
  } finally { second.close(); }
  f.policy.canAccess = (() => false) as typeof f.policy.canAccess;
  assert.throws(() => f.api().inspect(p.planId, f.credential));
  assert.equal(f.counts.draft, 1);
});

test('PR35 F-01: revocation after Intent prevents external entry and retains the committed reservation', async t => {
  const f=continuationFixture(t);let allowed=true;
  f.policy.canSend=((_actor,snapshot)=>snapshot.id!=='source'||allowed) as ContinuationPolicy['canSend'] as typeof f.policy.canSend;
  f.hook(async()=>({value:{kind:'read_requests',requests:[{resourceId:'source',digest:f.reads.describe('source')!.digest}]},usage,completeness:'COMPLETE'}));
  const p=f.api().createPlan(f.input('PLAN_READ_ONLY'),f.credential),prepare=DatabaseSync.prototype.prepare;
  let revoked=false;
  DatabaseSync.prototype.prepare=function(sql:string){const stmt=prepare.call(this,sql),run=stmt.run.bind(stmt);
    stmt.run=(...args:Parameters<typeof stmt.run>)=>{const result=run(...args);if(sql.includes("SET state='DISPATCH_INTENT'")&&f.counts.draft===1){allowed=false;revoked=true;}return result;};return stmt;};
  let result;
  try{result=await f.api().startAuthorized(p.planId,f.credential);}finally{DatabaseSync.prototype.prepare=prepare;}
  assert.equal(revoked,true);assert.equal(f.counts.draft,1);assert.equal(result.counts.modelCalls,2);
  assert.equal(result.invocation?.status,'REVIEW_REQUIRED');assert.equal(result.usage.committed.inputTokens,1);assert.equal(result.usage.outstanding.inputTokens,20);
  assert.equal(f.raw.prepare("SELECT count(*) n FROM model_call_ledger WHERE state='DISPATCH_INTENT'").get()!.n,1);
  await f.api().startAuthorized(p.planId,f.credential);assert.equal(f.counts.draft,1);
  assert.throws(()=>f.api().createPlan(f.input(),f.credential));assert.equal(f.counts.action,0);
});

test('PR35 F-01: permitted cached reads and Artifact provenance use the same captured metadata',async t=>{
  const f=continuationFixture(t);let delivered:import('../services/coordination/durable/continuationTypes.ts').PlanningProviderRequest|undefined;
  f.hook(async r=>{if(!r.reads.length)return {value:{kind:'read_requests',requests:[{resourceId:'source',digest:f.reads.describe('source')!.digest}]},usage,completeness:'COMPLETE'};
    delivered=r;return {value:{kind:'plan',artifact:content},usage,completeness:'COMPLETE'};});
  const p=f.api().createPlan(f.input('PLAN_READ_ONLY'),f.credential),result=await f.api().startAuthorized(p.planId,f.credential);
  assert.ok(delivered);assert.equal(f.counts.draft,2);
  assert.deepEqual(result.artifact?.snapshots,[...delivered.references,...delivered.reads.map(r=>({id:r.resourceId,digest:r.digest,revision:r.revision,observedAt:r.observedAt}))]);
  assert.equal(result.artifact?.snapshots[0].revision,f.reads.describe('source')!.revision);
  assert.equal(result.invocation?.outcome,'AWAITING_PLAN_REVIEW');
});

test('PR35 F-01: the final permission check uses the actual payload outside the parent authority',async t=>{
  const f=continuationFixture(t);let revoked=false;
  f.policy.canSend=((actor,snapshot,destination,dataClass)=>{
    if(snapshot.id!=='source')return true;
    assert.equal(actor.actorId,'operator');assert.equal(destination,'synthetic');assert.equal(dataClass,'synthetic');
    assert.equal(snapshot.revision,f.reads.describe('source')!.revision);
    if(f.counts.draft===1&&!f.db.boundedInvocationActive){revoked=true;return false;}return true;
  }) as ContinuationPolicy['canSend'] as typeof f.policy.canSend;
  f.hook(async()=>({value:{kind:'read_requests',requests:[{resourceId:'source',digest:f.reads.describe('source')!.digest}]},usage,completeness:'COMPLETE'}));
  const p=f.api().createPlan(f.input('PLAN_READ_ONLY'),f.credential),r=await f.api().startAuthorized(p.planId,f.credential);
  assert.equal(revoked,true);assert.equal(f.counts.draft,1);assert.equal(r.counts.modelCalls,2);
  assert.equal(r.invocation?.status,'REVIEW_REQUIRED');assert.equal(r.usage.outstanding.inputTokens,20);
});

for(const boundary of ['deadline','stop'] as const)test(`PR35 F-01: ${boundary} during the final permission check prevents external entry`,async t=>{
  const f=continuationFixture(t,{modelTimeoutMs:boundary==='deadline'?50:1000});let planId='',checked=false;
  f.policy.canSend=((_actor,snapshot)=>{
    if(snapshot.id==='source'&&f.counts.draft===1&&!f.db.boundedInvocationActive){
      checked=true;
      if(boundary==='deadline'){const until=performance.now()+200;while(performance.now()<until){}}
      else f.api().requestStop(planId,f.credential);
    }
    return true;
  }) as ContinuationPolicy['canSend'] as typeof f.policy.canSend;
  f.hook(async()=>({value:{kind:'read_requests',requests:[{resourceId:'source',digest:f.reads.describe('source')!.digest}]},usage,completeness:'COMPLETE'}));
  const p=f.api().createPlan(f.input('PLAN_READ_ONLY'),f.credential);planId=p.planId;
  const r=await f.api().startAuthorized(planId,f.credential);
  assert.equal(checked,true);assert.equal(f.counts.draft,1,'No Provider entry after the permission check outlives the send window.');
  assert.equal(r.counts.modelCalls,2);assert.equal(r.usage.committed.inputTokens,1);assert.equal(r.usage.outstanding.inputTokens,20);
  assert.equal(r.invocation?.status,'REVIEW_REQUIRED');assert.equal(f.counts.action,0);
});

async function expiredResult(t:import('node:test').TestContext) {
  const f=continuationFixture(t,{actionTimeoutMs:1000,collectionGraceMs:50,finalizationMs:50});hold(f);
  const p=f.api().createPlan(executeInput(f),f.credential);f.api().authorize(p,f.approver);
  f.raw.exec("CREATE TRIGGER audit_stop_initial_application BEFORE UPDATE ON execution_ledger WHEN NEW.state='FINALIZED' BEGIN SELECT RAISE(ABORT,'audit application stop'); END;");
  try{await f.api().startAuthorized(p.planId,f.credential);}finally{f.raw.exec('DROP TRIGGER audit_stop_initial_application');}
  const row=f.raw.prepare("SELECT * FROM execution_ledger WHERE state='RESULT_RECORDED'").get()!;assert.ok(row);
  const step=f.raw.prepare("SELECT * FROM recovery_invocation_steps WHERE kind='ACTION' AND target_id=?").get(row.action_id)!;
  await delay(Math.max(0,Number(step.application_deadline)-Date.now())+30);
  const plan=new SafeRecoveryPlanner(f.db,f.lease).createPlan({workflowRunId:'run',operationKind:'REFLECT_RECORDED_RESULT',targetId:String(row.action_id)},f.credential);
  const grant=new SafeRecoveryAuthorizer(f.db,f.lease).authorize(plan.executionPlanId,executionScopeOf(plan),f.approver);
  return {f,p,row,step,plan,grant,executor:new SafeRecoveryExecutor(f.db,f.lease)};
}

test('PR35 F-02: expired Invocation, ordinary Store and SQL cannot use even an approved recovery Grant',async t=>{
  const {f,p,row,step,plan,executor}=await expiredResult(t);
  await f.api().startAuthorized(p.planId,f.credential);
  assert.throws(()=>f.db.writeWithLease(f.lease,'run',tx=>{
    const record=readPendingActionInTransaction(tx,'run',String(row.action_id))!;
    return finalizeRecordedResultInTransaction(f.store,tx,record,new SqliteRunnerEvidenceStore(f.db),{now:()=>Number(row.updated_at)});
  }));
  assert.throws(()=>f.db.writeWithLease(f.lease,'run',tx=>tx.run("UPDATE execution_ledger SET state='FINALIZED' WHERE action_id=?",row.action_id as string)));
  assert.throws(()=>f.raw.prepare("UPDATE execution_ledger SET state='FINALIZED' WHERE action_id=?").run(row.action_id));
  assert.deepEqual(f.raw.prepare('SELECT * FROM execution_ledger WHERE action_id=?').get(row.action_id),row);
  assert.equal(f.raw.prepare("SELECT count(*) n FROM journal_events WHERE event_type='TaskCompleted'").get()!.n,0);
  assert.equal(f.raw.prepare('SELECT count(*) n FROM recovery_execution_operations').get()!.n,0);
  const prepare=DatabaseSync.prototype.prepare;let scoped=false;
  DatabaseSync.prototype.prepare=function(sql:string){const stmt=prepare.call(this,sql),run=stmt.run.bind(stmt);
    stmt.run=(...args:Parameters<typeof stmt.run>)=>{
      if(sql.startsWith('UPDATE execution_ledger SET state = ?')){
        const keys=['state','review_reason','finalized_event_id','result_ref','result_digest','attempt_id','reserved_at','updated_at'];
        const next={...row,state:args[0],finalized_event_id:args[1],updated_at:args[2]};
        const detail=JSON.stringify({old:keys.map(k=>row[k]),next:keys.map(k=>next[k as keyof typeof next])});
        const check=prepare.call(this,"SELECT map_safe_recovery_write(?,'execution_ledger','UPDATE',?,?) AS allowed");
        assert.equal(check.get('run',row.action_id,detail)!.allowed,1);scoped=true;
        assert.equal(check.get('another',row.action_id,detail)!.allowed,0);
        assert.equal(check.get('run','another-action',detail)!.allowed,0);
        assert.equal(check.get('run',row.action_id,JSON.stringify({SafeRecovery:true}))!.allowed,0);
        for(const key of ['result_digest','attempt_id','result_ref']){const changed={...next,[key]:'forged'};
          assert.equal(check.get('run',row.action_id,JSON.stringify({old:keys.map(k=>row[k]),next:keys.map(k=>changed[k as keyof typeof changed])}))!.allowed,0);}
      }
      return run(...args);
    };return stmt;
  };
  try{executor.executeAuthorized(plan.executionPlanId,f.credential);}finally{DatabaseSync.prototype.prepare=prepare;}
  assert.equal(scoped,true);assert.equal(f.counts.action,1);
  assert.deepEqual(f.raw.prepare('SELECT * FROM recovery_invocation_steps WHERE step_id=?').get(step.step_id),step);
  assert.equal(f.raw.prepare("SELECT count(*) n FROM journal_events WHERE event_type='TaskCompleted'").get()!.n,1);
});

for(const when of ['BEFORE','ACK'] as const)test(`PR35 F-02: fresh recovery ${when} keeps Grant, reflection, receipt and audit atomic`,async t=>{
  const {f,row,plan,grant,executor}=await expiredResult(t);
  await fault('INSERT INTO recovery_execution_operations',when,async()=>{
    if(when==='BEFORE')assert.throws(()=>executor.executeAuthorized(plan.executionPlanId,f.credential));
    else assert.equal(executor.executeAuthorized(plan.executionPlanId,f.credential).status,'COMMITTED');
  });
  const committed=when==='ACK';
  assert.equal(f.raw.prepare('SELECT state FROM execution_ledger WHERE action_id=?').get(row.action_id)!.state,committed?'FINALIZED':'RESULT_RECORDED');
  assert.equal(f.raw.prepare('SELECT status FROM recovery_execution_grants WHERE authorization_id=?').get(grant.authorizationId)!.status,committed?'CONSUMED':'AUTHORIZED');
  assert.equal(f.raw.prepare("SELECT count(*) n FROM journal_events WHERE event_type='TaskCompleted'").get()!.n,committed?1:0);
  assert.equal(f.raw.prepare('SELECT count(*) n FROM recovery_execution_operations').get()!.n,committed?1:0);
  assert.equal(f.raw.prepare("SELECT count(*) n FROM runtime_audit_events WHERE event_kind='RECOVERY_OPERATION_COMMITTED'").get()!.n,committed?1:0);
  executor.executeAuthorized(plan.executionPlanId,f.credential);executor.executeAuthorized(plan.executionPlanId,f.credential);
  assert.equal(f.counts.action,1);assert.equal(f.raw.prepare("SELECT count(*) n FROM journal_events WHERE event_type='TaskCompleted'").get()!.n,1);
});

for(const boundary of ['INSERT INTO planning_input_requests',"SET application_status='APPLIED'",'INSERT INTO recovery_hold_lifecycle'])
test(`PR35 F-03: question transaction rollback at ${boundary} has no partial output`,async t=>{
  const f=continuationFixture(t);f.hook(async()=>({value:{kind:'needs_input',questions:['Which environment?']},usage,completeness:'COMPLETE'}));
  const p=f.api().createPlan(f.input(),f.credential);
  // The lifecycle also occurs at start: arm only once the question insert has executed.
  const prepare=DatabaseSync.prototype.prepare;let inQuestions=false,armed=false,fired=false;
  const exec=DatabaseSync.prototype.exec;
  DatabaseSync.prototype.prepare=function(sql:string){const stmt=prepare.call(this,sql),run=stmt.run.bind(stmt);stmt.run=(...args:Parameters<typeof stmt.run>)=>{
    const result=run(...args);if(sql.includes('INSERT INTO planning_input_requests'))inQuestions=true;
    if(inQuestions&&sql.includes(boundary))armed=true;return result;};return stmt;};
  DatabaseSync.prototype.exec=function(sql:string){if(sql==='COMMIT'&&armed&&!fired){fired=true;throw Error('question commit failure');}return exec.call(this,sql);};
  let result;try{result=await f.api().startAuthorized(p.planId,f.credential);}finally{DatabaseSync.prototype.prepare=prepare;DatabaseSync.prototype.exec=exec;}
  assert.equal(fired,true);assert.equal(result.inputRequest,undefined);assert.equal(result.invocation?.status,'REVIEW_REQUIRED');
  assert.equal(f.raw.prepare('SELECT count(*) n FROM planning_input_requests').get()!.n,0);
  assert.equal(f.raw.prepare("SELECT count(*) n FROM journal_events WHERE event_type='PlanningInputRequested'").get()!.n,0);
  assert.equal(f.raw.prepare("SELECT count(*) n FROM bounded_audit WHERE entity_table='planning_input_requests'").get()!.n,0);
  assert.equal(f.raw.prepare('SELECT application_status FROM model_call_ledger').get()!.application_status,'PENDING_APPLICATION');
  assert.equal(result.usage.committed.inputTokens,1);await f.api().startAuthorized(p.planId,f.credential);assert.equal(f.counts.draft,1);
});

test('PR35 F-03: lost question COMMIT ACK and reconnect only read the same saved questions',async t=>{
  const f=continuationFixture(t),questions=['Which environment?','Which retention period?'];
  f.hook(async()=>({value:{kind:'needs_input',questions},usage,completeness:'COMPLETE'}));
  const p=f.api().createPlan(f.input(),f.credential);
  await fault('INSERT INTO planning_input_requests','ACK',()=>f.api().startAuthorized(p.planId,f.credential));
  const db=new DurableDatabase(f.options);try{
    const reader=new RecoveryContinuationReader(db),saved=reader.inspect(p.planId,f.credential);
    assert.deepEqual(saved.inputRequest?.questions,questions);assert.equal(saved.inputRequest?.contentDigest,digest(questions));
    await new RecoveryContinuationCoordinator(db).startAuthorized(p.planId,f.credential);
    for(const table of ['journal_events','bounded_audit','runtime_audit_events','model_call_ledger'])
      assert.equal(JSON.stringify(f.raw.prepare(`SELECT * FROM ${table}`).all()).includes(questions[0]),false,table);
  }finally{db.close();}
  assert.equal(f.counts.draft,1);assert.equal(f.counts.action,0);assert.equal(f.counts.prepare,0);
});

for(const kind of ['secret','host-denied','too-long','too-many'] as const)test(`PR35 F-03: rejects ${kind} questions without publishing or applying them`,async t=>{
  const f=continuationFixture(t);
  const questions=kind==='secret'?['Authorization: Bearer '+'synthetic'.repeat(4)]:kind==='too-long'?['x'.repeat(4097)]:kind==='too-many'?Array(21).fill('Question?'):['Classified question?'];
  if(kind==='host-denied')f.policy.inspectContent=((text:string)=>!text.includes('Classified')) as typeof f.policy.inspectContent;
  f.hook(async()=>({value:{kind:'needs_input',questions},usage,completeness:'COMPLETE'}));
  const p=f.api().createPlan(f.input(),f.credential),r=await f.api().startAuthorized(p.planId,f.credential);
  assert.equal(r.inputRequest,undefined);assert.notEqual(f.raw.prepare('SELECT application_status FROM model_call_ledger').get()!.application_status,'APPLIED');
  assert.equal(f.raw.prepare('SELECT count(*) n FROM planning_input_requests').get()!.n,0);
  assert.equal(f.raw.prepare("SELECT count(*) n FROM journal_events WHERE event_type='PlanningInputRequested'").get()!.n,0);
});

test('PR35 F-03: answers use a new explicit request and budget; other Workflows expose no old questions',async t=>{
  const f=continuationFixture(t);f.hook(async()=>({value:{kind:'needs_input',questions:['Which environment?']},usage,completeness:'COMPLETE'}));
  const p=f.api().createPlan(f.input(),f.credential),first=await f.api().startAuthorized(p.planId,f.credential);
  f.admin.createWorkflow(executionSeed('ALLOW','other',{maxWallTimeMs:Number.MAX_SAFE_INTEGER}));
  const otherLease=f.manager.acquire('other'),otherApi=new RecoveryContinuationCoordinator(f.db,otherLease),other=f.input();other.workflowRunId='other';
  const otherPlan=otherApi.createPlan(other,f.credential);assert.equal(otherApi.inspect(otherPlan.planId,f.credential).inputRequest,undefined);
  f.policy.canAccess=((_actor,workflow)=>workflow==='other') as ContinuationPolicy['canAccess'] as typeof f.policy.canAccess;
  assert.throws(()=>otherApi.inspect(p.planId,f.credential));f.policy.canAccess=()=>true;
  const input=f.input();input.input!.text='The intended environment is a synthetic staging environment.';
  f.hook(async()=>({value:{kind:'plan',artifact:content},usage,completeness:'COMPLETE'}));
  const next=f.api().createPlan(input,f.credential),result=await f.api().startAuthorized(next.planId,f.credential);
  assert.notEqual(next.requestId,p.requestId);assert.notEqual(result.invocation?.invocationId,first.invocation?.invocationId);
  assert.equal(result.counts.modelCalls,1);assert.equal(result.invocation?.outcome,'AWAITING_PLAN_REVIEW');
  assert.deepEqual(f.api().inspect(p.planId,f.credential).inputRequest,first.inputRequest);assert.equal(f.counts.draft,2);
});
