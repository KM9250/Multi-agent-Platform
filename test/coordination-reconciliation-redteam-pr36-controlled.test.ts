import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { controlledConflictFixture } from './reconciliation-controlled-fixture.ts';
import { reconciliationContents, tableCount, actionClaim, syntheticSource } from './reconciliation-fixture.ts';
import { processResult } from './reconciliation-process-fixture.ts';
import { executionSeed, registration, record, clock } from './durable-execution-fixture.ts';
import { ReconciliationReader } from '../services/coordination/durable/reconciliationReader.ts';
import { SqliteCoordinationRunnerStore, DurableExecutionCoordinator } from '../services/coordination/durable/index.ts';
import { ReconciliationEvidenceService } from '../services/coordination/durable/reconciliationEvidenceStore.ts';
import { readReconciliationTarget } from '../services/coordination/durable/reconciliationVerifier.ts';

const failed={status:'failed' as const,summary:'Synthetic contradictory controlled response'};
const rows=(raw:DatabaseSync,table:string)=>raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
function assertCommitted(c:Awaited<ReturnType<typeof controlledConflictFixture>>,before:ReturnType<typeof reconciliationContents>) {
  const {f}=c;
  for(const name of ['execution_results','recovery_dispatch_receipts','runner_evidence','recovery_dispatch_evidence','reconciliation_disputes','reconciliation_cases'])assert.equal(tableCount(f.raw,name),1,name);
  assert.equal(rows(f.raw,'execution_ledger')[0].state,'RESULT_RECORDED');
  assert.equal(rows(f.raw,'reconciliation_disputes')[0].reason_code,'NORMAL_FACT_CONFLICT');
  const control=rows(f.raw,'recovery_workflow_control')[0];assert.equal(control.hold_state,'HELD');
  assert.equal(control.control_revision,Number(before.recovery_workflow_control[0].control_revision)+1);
  for(const name of ['journal_events','recovery_controlled_grants','reconciliation_verifications','reconciliation_grants','reconciliation_operations','model_usage_authorities','model_call_ledger'])assert.deepEqual(rows(f.raw,name),before[name],name);
  assert.equal(rows(f.raw,'runtime_audit_events').filter(r=>r.event_kind==='RECOVERY_DISPATCH_RESULT_RECORDED').length,1);
  assert.equal(rows(f.raw,'runtime_audit_events').filter(r=>r.event_kind==='RECOVERY_CONTROLLED_GRANT_CONSUMED').length,1);
  assert.equal(rows(f.raw,'reconciliation_audit').filter(r=>r.event_kind==='RECONCILIATION_DISPUTE_RECORDED'&&r.actor_id==='system:normal-fact').length,1);
  assert.equal(new ReconciliationReader(f.db).inspect(c.target,f.credential).obligations.some(o=>o.reason==='DISPUTED'),true);
  assert.equal(f.store.getSnapshot('run').tasks.task.status,'ASSIGNED');assert.deepEqual(f.calls,{execute:1,plan:0,verify:0});assert.equal(c.synthetic.counts.verifier,1);
  assert.deepEqual(f.raw.prepare('PRAGMA foreign_key_check').all(),[]);
}

for(const variant of ['CONFLICT','SAME','NONE'] as const)
test(`PR36 F-02: real Controlled Dispatch waiting on Executor preserves ${variant} Result and Receipt`,async t=>{
  const c=await controlledConflictFixture(t),{f}=c;
  if(variant!=='NONE')await c.verify();
  const initial=reconciliationContents(f.raw);
  const journal=f.raw.prepare('SELECT * FROM journal_events').all(),grant=f.raw.prepare('SELECT * FROM recovery_controlled_grants').all();
  assert.equal(f.calls.execute,1);assert.equal(grant[0].status,'CONSUMED');
  c.release({status:variant==='SAME'?'succeeded':'failed',summary:'Synthetic controlled response'});
  const result=await c.pending;
  assert.equal(result.status,'RESULT_RECORDED');assert.equal(result.outcome,'RESULT_AVAILABLE');assert.equal(result.taskStatus,'ASSIGNED');
  assert.equal(tableCount(f.raw,'execution_results'),1);assert.equal(tableCount(f.raw,'recovery_dispatch_receipts'),1);
  assert.equal(tableCount(f.raw,'runner_evidence'),1);assert.equal(tableCount(f.raw,'recovery_dispatch_evidence'),1);
  assert.equal(tableCount(f.raw,'reconciliation_disputes'),variant==='CONFLICT'?1:0);
  assert.equal(tableCount(f.raw,'reconciliation_cases'),variant==='CONFLICT'?1:0);
  assert.deepEqual(f.raw.prepare('SELECT * FROM journal_events').all(),journal);assert.deepEqual(f.raw.prepare('SELECT * FROM recovery_controlled_grants').all(),grant);
  assert.equal(f.raw.prepare('SELECT hold_state FROM recovery_workflow_control').get()!.hold_state,'HELD');
  const current=new ReconciliationReader(f.db).inspect(c.target,f.credential);
  assert.equal(current.obligations.some(o=>o.reason==='DISPUTED'),variant==='CONFLICT');assert.equal(current.executionAllowed,false);
  const before=reconciliationContents(f.raw);
  assert.deepEqual(await f.execute(c.plan),result);assert.deepEqual(f.api().reader.inspectDispatch(c.plan.planId,f.credential),result);
  assert.deepEqual(reconciliationContents(f.raw),before);assert.deepEqual(f.calls,{execute:1,plan:0,verify:0});assert.equal(c.synthetic.counts.verifier,variant==='NONE'?0:1);
  if(variant==='CONFLICT')assertCommitted(c,initial);
});

for(const evidence of ['CANDIDATE','PARTIAL','PENDING','WRONG_ATTEMPT','WRONG_WORKFLOW','OTHER_WORKFLOW'] as const)
test(`PR36 F-02: ${evidence} alone cannot dispute this Controlled Attempt`,async t=>{
  const c=await controlledConflictFixture(t),{f}=c;
  if(evidence==='CANDIDATE')c.submit();
  else if(evidence==='PARTIAL'||evidence==='PENDING')await c.verify({...actionClaim('PARTIAL_EFFECT',false),completeness:evidence==='PARTIAL'?'PARTIAL':'COMPLETE',finality:evidence==='PENDING'?'PENDING':'FINAL'});
  else if(evidence==='OTHER_WORKFLOW') {
    const admin=new SqliteCoordinationRunnerStore(f.db);admin.createWorkflow(executionSeed('ALLOW','other',{maxWallTimeMs:Number.MAX_SAFE_INTEGER}));
    const lease=f.manager.acquire('other'),store=admin.withLease(lease),coordinator=new DurableExecutionCoordinator(store,{get:id=>f.registry.get(id)?.executor},{clock});
    const r={...record,workflowRunId:'other'},registrationRequest=registration(store,r,'other');
    coordinator.registerAction(r,registrationRequest.expected,registrationRequest.sessionEvent,registrationRequest.taskEvent);
    const {attemptId}=coordinator.reserveDispatch('other',store.getSnapshot('other').tasks.task);
    const target={...c.target,workflowRunId:'other',attemptId},state=f.db.read(tx=>readReconciliationTarget(tx,target)),service=new ReconciliationEvidenceService(f.db,lease);
    const candidate=service.submitCandidate({target,dataClass:'synthetic',contentType:'application/json',body:c.synthetic.sign({target,targetDigest:state.targetDigest,
      source:{...syntheticSource,externalOperationId:'other-workflow-effect',effectUnit:'action-effect'},claim:actionClaim(),status:'VERIFIED',reasonCodes:[],expiresAt:Date.now()+600000})},f.credential);
    assert.equal((await service.verify({evidenceId:candidate.evidenceId,verifierId:c.synthetic.binding.verifierId},f.credential)).status,'VERIFIED');
  } else {
    const target={...c.target,...(evidence==='WRONG_ATTEMPT'?{attemptId:'other-attempt'}:{workflowRunId:'other-workflow'})};
    const candidate=c.submit(actionClaim(),{target}),before=reconciliationContents(f.raw);
    await assert.rejects(c.evidence.verify({evidenceId:candidate.evidenceId,verifierId:c.synthetic.binding.verifierId},f.credential));
    const after=reconciliationContents(f.raw);
    // A rejected verifier payload can retain its started job and audit, never a fact or business effect.
    for(const [table,data] of Object.entries(before))if(!['reconciliation_verification_jobs','reconciliation_audit'].includes(table))assert.deepEqual(after[table],data,table);
    assert.equal(after.reconciliation_verification_jobs.length,1);assert.equal(after.reconciliation_verification_jobs[0].receipt_id,null);
    assert.deepEqual(after.reconciliation_audit.slice(0,-1),before.reconciliation_audit);assert.equal(after.reconciliation_audit.at(-1)!.event_kind,'RECONCILIATION_VERIFICATION_STARTED');
  }
  const control=rows(f.raw,'recovery_workflow_control'),journal=rows(f.raw,'journal_events'),grants=rows(f.raw,'recovery_controlled_grants');
  c.release(failed);assert.equal((await c.pending).status,'RESULT_RECORDED');
  assert.equal(tableCount(f.raw,'reconciliation_disputes'),0);assert.equal(tableCount(f.raw,'reconciliation_cases'),0);
  assert.deepEqual(rows(f.raw,'recovery_workflow_control'),control);assert.deepEqual(rows(f.raw,'journal_events'),journal);assert.deepEqual(rows(f.raw,'recovery_controlled_grants'),grants);
  assert.equal(f.calls.execute,1);assert.equal(f.store.getSnapshot('run').tasks.task.status,'ASSIGNED');
});

for(const fault of ['CONTROLLED_AUDIT','MISSING_CONTROLLED_AUDIT','DISPUTE','CASE','CONTROL','RECONCILIATION_AUDIT','CONTROLLED_SQL_POISON','NORMAL_SQL_POISON','COMMIT'] as const)
test(`PR36 F-02: ${fault} rolls back all B facts while retaining A and its consumed Grant`,async t=>{
  const c=await controlledConflictFixture(t),{f}=c;await c.verify();const before=reconciliationContents(f.raw);
  const prepare=DatabaseSync.prototype.prepare,exec=DatabaseSync.prototype.exec,check=f.db.assertWorkflowWrite.bind(f.db);let injected=false,normalWrites=0;
  DatabaseSync.prototype.prepare=function(sql:string){if(sql.startsWith('INSERT INTO reconciliation_disputes'))normalWrites++;return prepare.call(this,sql);};
  if(fault.endsWith('SQL_POISON')) {
    f.db.assertWorkflowWrite=(tx,id)=>{check(tx,id);if(!injected&&tx.get('SELECT operation_id FROM recovery_dispatch_receipts')) {
      const controlled=tx.get('SELECT map_controlled_actor() AS actor')!.actor!==null;
      if(controlled===(fault==='CONTROLLED_SQL_POISON')){injected=true;try{tx.run('INSERT INTO missing_f02_table VALUES (1)');}catch{}}
    }};
  } else if(fault==='COMMIT') {
    DatabaseSync.prototype.exec=function(sql:string){if(sql==='COMMIT'&&!injected&&this.prepare('SELECT count(*) n FROM reconciliation_disputes').get()!.n===1){injected=true;throw Error('synthetic B commit failure');}return exec.call(this,sql);};
  } else {
    const [table,condition]=fault.includes('CONTROLLED_AUDIT')?['runtime_audit_events',"WHEN NEW.event_kind='RECOVERY_DISPATCH_RESULT_RECORDED'"]
      :fault==='DISPUTE'?['reconciliation_disputes','']:fault==='CASE'?['reconciliation_cases','']:fault==='CONTROL'?['recovery_hold_lifecycle','']:['reconciliation_audit',"WHEN NEW.event_kind='RECONCILIATION_DISPUTE_RECORDED'"];
    f.raw.exec(`CREATE TRIGGER f02_fault BEFORE INSERT ON ${table} ${condition} BEGIN SELECT RAISE(${fault==='MISSING_CONTROLLED_AUDIT'?'IGNORE':"ABORT,'synthetic fault'"}); END`);
  }
  try{c.release(failed);await assert.rejects(c.pending);}finally{DatabaseSync.prototype.prepare=prepare;DatabaseSync.prototype.exec=exec;f.db.assertWorkflowWrite=check;}
  if(fault.endsWith('SQL_POISON')||fault==='COMMIT')assert.equal(injected,true);
  if(fault.includes('CONTROLLED_AUDIT'))assert.equal(normalWrites,0,'Unvalidated Controlled writes cannot hand off to the normal participant');
  assert.deepEqual(reconciliationContents(f.raw),before);assert.equal(f.calls.execute,1);assert.equal(c.synthetic.counts.verifier,1);
  f.raw.exec('DROP TRIGGER IF EXISTS f02_fault');
  const retried=await f.execute(c.plan);assert.equal(retried.status,'INTENT_RECORDED');assert.equal(retried.receipt,undefined);assert.equal(retried.taskStatus,'ASSIGNED');
  assert.deepEqual(reconciliationContents(f.raw),before);assert.deepEqual(f.calls,{execute:1,plan:0,verify:0});
  assert.equal(rows(f.raw,'recovery_workflow_control')[0].hold_state,'HELD');assert.equal(rows(f.raw,'recovery_controlled_grants')[0].status,'CONSUMED');
});

test('PR36 F-02: lost B COMMIT ACK recovers the same Result, Receipt and Dispute without replay',async t=>{
  const c=await controlledConflictFixture(t),{f}=c;await c.verify();const before=reconciliationContents(f.raw),exec=DatabaseSync.prototype.exec;let lost=false;
  DatabaseSync.prototype.exec=function(sql:string){const result=exec.call(this,sql);if(sql==='COMMIT'&&!lost&&this.prepare('SELECT count(*) n FROM reconciliation_disputes').get()!.n===1){lost=true;throw Error('synthetic B ACK loss');}return result;};
  let result;try{c.release(failed);result=await c.pending;}finally{DatabaseSync.prototype.exec=exec;}
  assert.equal(lost,true);assert.equal(result.status,'RESULT_RECORDED');assertCommitted(c,before);
  const saved=reconciliationContents(f.raw);assert.deepEqual(await f.execute(c.plan),result);assert.deepEqual(f.api().reader.inspectDispatch(c.plan.planId,f.credential),result);
  assert.deepEqual(reconciliationContents(f.raw),saved);assert.equal(f.calls.execute,1);assert.equal(c.synthetic.counts.verifier,1);
});

test('PR36 F-02: concurrent same-Plan requests during verification cannot create another Send Permit',async t=>{
  const c=await controlledConflictFixture(t),{f}=c;
  const [verification,inspections]=await Promise.all([c.verify(),Promise.all(Array.from({length:4},()=>f.execute(c.plan)))]);
  assert.equal(verification.status,'VERIFIED');assert.ok(inspections.every(i=>i.status==='INTENT_RECORDED'&&!i.receipt));
  const before=reconciliationContents(f.raw);c.release(failed);const result=await c.pending;assert.equal(result.status,'RESULT_RECORDED');assertCommitted(c,before);
  const saved=reconciliationContents(f.raw),again=await Promise.all(Array.from({length:4},()=>f.execute(c.plan)));
  assert.ok(again.every(i=>i.receipt?.resultDigest===result.receipt!.resultDigest));assert.deepEqual(reconciliationContents(f.raw),saved);assert.equal(f.calls.execute,1);
});

test('PR36 F-02: verified non-execution and a successful Controlled Result also commit a Dispute',async t=>{
  const c=await controlledConflictFixture(t);await c.verify(actionClaim('NOT_EXECUTED_FINAL'));
  const before=reconciliationContents(c.f.raw);c.release({status:'succeeded',summary:'Synthetic conflicting success'});
  assert.equal((await c.pending).status,'RESULT_RECORDED');assertCommitted(c,before);
});

function child(args:string[]) {
  return fork(fileURLToPath(new URL('./reconciliation-controlled-child.ts',import.meta.url)),args,{execArgv:['--experimental-transform-types','--loader',fileURLToPath(new URL('./ts-loader.mjs',import.meta.url))],stdio:['ignore','ignore','pipe','ipc']});
}
for(const boundary of ['before-B','after-B'] as const)
test(`PR36 F-02: real process Crash ${boundary} keeps Controlled conflict atomic and restart never resends`,async t=>{
  const dir=mkdtempSync(join(tmpdir(),'map-f02-crash-')),path=join(dir,'db.sqlite');t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const dead=await processResult(child([path,boundary]));assert.equal(dead.timedOut,false,dead.stderr);assert.equal(dead.signal,process.platform==='win32'?'SIGTERM':'SIGKILL',dead.stderr);
  const raw=new DatabaseSync(path);t.after(()=>raw.close());const committed=boundary==='after-B',before=JSON.parse(readFileSync(join(dir,'before.json'),'utf8'));
  const current=()=>JSON.parse(JSON.stringify(reconciliationContents(raw)));
  for(const table of ['execution_results','recovery_dispatch_receipts','runner_evidence','recovery_dispatch_evidence','reconciliation_disputes','reconciliation_cases'])assert.equal(tableCount(raw,table),committed?1:0,table);
  assert.equal(rows(raw,'recovery_controlled_grants')[0].status,'CONSUMED');assert.equal(rows(raw,'recovery_workflow_control')[0].hold_state,'HELD');
  assert.equal(rows(raw,'execution_ledger')[0].state,committed?'RESULT_RECORDED':'DISPATCH_RESERVED');
  if(!committed)assert.deepEqual(current(),before);
  else {
    assert.equal(rows(raw,'recovery_workflow_control')[0].control_revision,Number(before.recovery_workflow_control[0].control_revision)+1);
    for(const table of ['journal_events','recovery_controlled_grants','reconciliation_verifications','reconciliation_grants','model_usage_authorities'])assert.deepEqual(current()[table],before[table],table);
    assert.equal(rows(raw,'runtime_audit_events').filter(r=>r.event_kind==='RECOVERY_DISPATCH_RESULT_RECORDED').length,1);
    assert.equal(rows(raw,'reconciliation_audit').filter(r=>r.event_kind==='RECONCILIATION_DISPUTE_RECORDED').length,1);
  }
  assert.deepEqual(readFileSync(join(dir,'external-count.txt'),'utf8').trim().split('\n'),['execute','verify']);
  const saved=current(),retried=await processResult(child([path,'retry']));assert.equal(retried.timedOut,false,retried.stderr);assert.equal(retried.code,0,retried.stderr);
  assert.ok(retried.messages.some((m:{status?:string;taskStatus?:string;disputed?:boolean})=>m.status===(committed?'RESULT_RECORDED':'INTENT_RECORDED')&&m.taskStatus==='ASSIGNED'&&m.disputed===committed));
  assert.deepEqual(current(),saved);assert.deepEqual(readFileSync(join(dir,'external-count.txt'),'utf8').trim().split('\n'),['execute','verify']);assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(),[]);
});
