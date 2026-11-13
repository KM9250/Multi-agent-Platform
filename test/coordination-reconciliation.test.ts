import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { DurableDatabase } from '../services/coordination/durable/db.ts';
import { ModelCallLedger } from '../services/coordination/durable/modelCallLedger.ts';
import { ReconciliationReader } from '../services/coordination/durable/reconciliationReader.ts';
import { ReconciliationExecutor } from '../services/coordination/durable/reconciliationExecutor.ts';
import { ReconciliationEvidenceService } from '../services/coordination/durable/reconciliationEvidenceStore.ts';
import { digest } from '../services/coordination/durable/integrity.ts';
import { reconciliationFixture as fixture, reconciliationContents, tableCount, assertRefusedWithoutEffects, completeClaim, completeUsage, actionClaim } from './reconciliation-fixture.ts';

const history=(f:ReturnType<typeof fixture>)=>({ledger:f.raw.prepare('SELECT * FROM model_call_ledger').all(),attempts:f.raw.prepare('SELECT * FROM model_call_attempts').all(),actions:f.raw.prepare('SELECT * FROM execution_ledger').all(),results:f.raw.prepare('SELECT * FROM execution_results').all(),journal:f.raw.prepare('SELECT * FROM journal_events').all(),snapshot:f.store.getSnapshot('run')});
async function modelReady(t:Parameters<typeof fixture>[0],config:Parameters<typeof fixture>[1]={}){const f=fixture(t,config),m=f.model(),v=await f.verified(m.target),p=f.plan(m.target,v.verification.verificationId);return {...f,m,...v,p};}

test('EV-01 EV-02 INV-02: candidate and signed verification preserve original business state and require a fresh approval',async t=>{
 const f=fixture(t),m=f.model(),before=history(f),e=f.submit(m.target);assert.deepEqual(history(f),before);assert.equal(tableCount(f.raw,'reconciliation_grants'),0);
 assert.equal(f.api().evidence.readEvidence(e.evidenceId,f.credential).evidenceOwnerId,'operator');
 const body=f.api().evidence.readBody(e.evidenceId,f.credential);assert.ok(body);const v=await f.api().evidence.verify({evidenceId:e.evidenceId,verifierId:f.synthetic.binding.verifierId},f.credential);
 assert.equal(v.status,'VERIFIED');assert.equal(f.counts.verifier,1);assert.deepEqual(history(f),before);assert.equal(tableCount(f.raw,'model_usage_authorities'),0);
 const p=f.plan(m.target,v.verificationId);assertRefusedWithoutEffects(f,()=>f.execute(p));f.authorize(p);assert.equal(f.execute(p).status,'COMMITTED');assert.deepEqual(f.counts,{verifier:1,action:0,model:0,lookup:0});
});
test('EV-12 IN-11 INV-13: verification reads and metadata/body reads are side effect free and never invoke verifier again',async t=>{
 const f=fixture(t),m=f.model(),{evidence,verification}=await f.verified(m.target),before=reconciliationContents(f.raw),counts={...f.counts};
 for(let i=0;i<3;i++){assert.deepEqual(f.api().evidence.readVerification(verification.verificationId,f.credential),verification);f.api().evidence.readEvidence(evidence.evidenceId,f.credential);f.api().evidence.readBody(evidence.evidenceId,f.credential);}
 assert.deepEqual(reconciliationContents(f.raw),before);assert.deepEqual(f.counts,counts);
});
test('US-01 US-04 US-18 INV-01 INV-04 INV-05: full usage replaces the entire 1000-token reservation with 400 exactly once',async t=>{
 const f=await modelReady(t),before=history(f),budget=f.m.ledger.getBudgetPosition('run');assert.equal(budget.outstanding.inputTokens+budget.outstanding.outputTokens,1000);
 f.authorize(f.p);f.execute(f.p);const after=f.m.ledger.getBudgetPosition('run');assert.equal(after.committed.inputTokens+after.committed.outputTokens,400);assert.equal(after.outstanding.inputTokens+after.outstanding.outputTokens,0);assert.equal(after.committed.costMicros,400);
 assert.equal(tableCount(f.raw,'model_usage_authorities'),1);assert.equal(tableCount(f.raw,'reconciled_model_usages'),1);assert.deepEqual(history(f),before);assert.equal(before.snapshot.run.usage.llmCalls,0);
});
test('US-06 INV-06: zero-cost complete usage still consumes one logical call and does not invent a free retry',async t=>{
 const f=fixture(t),m=f.model(),claim={...completeClaim(),usage:{llmCalls:1,inputTokens:0,outputTokens:0,estimatedCost:0}},v=await f.verified(m.target,claim),p=f.plan(m.target,v.verification.verificationId);f.authorize(p);f.execute(p);
 const position=m.ledger.getBudgetPosition('run');assert.equal(position.committed.llmCalls,1);assert.equal(position.committed.costMicros,0);assert.equal(position.outstanding.llmCalls,0);assertRefusedWithoutEffects(f,()=>m.ledger.markDispatchIntent(m.x));
});
test('US-05: usage above the reservation is retained in full and prevents new execution',async t=>{
 const f=fixture(t),m=f.model(),claim={...completeClaim(),usage:{llmCalls:1,inputTokens:20000,outputTokens:20000,estimatedCost:2}},v=await f.verified(m.target,claim),p=f.plan(m.target,v.verification.verificationId);f.authorize(p);f.execute(p);
 const position=m.ledger.getBudgetPosition('run');assert.equal(position.committed.inputTokens,20000);assert.equal(position.committed.costMicros,2000000);assert.equal(position.outstanding.llmCalls,0);assert.throws(()=>f.store.assertRecoveryExecution('run'));
});
test('US-08: late ordinary settlement after reconciliation cannot append UsageRecorded or replace the authority',async t=>{
 const f=await modelReady(t);f.authorize(f.p);f.execute(f.p);assertRefusedWithoutEffects(f,()=>f.m.ledger.settle(f.m.x,{...completeUsage},false));
 assert.equal(tableCount(f.raw,'model_usage_authorities'),1);assert.equal(f.store.getSnapshot('run').events.filter(e=>e.type==='UsageRecorded').length,0);
});
test('US-07: ordinary settlement wins first and reconciliation cannot account a second time',async t=>{
 const f=fixture(t),m=f.model('model','SETTLED'),v=await f.verified(m.target);assert.equal(tableCount(f.raw,'model_usage_authorities'),1);
 assertRefusedWithoutEffects(f,()=>f.plan(m.target,v.verification.verificationId));assert.equal(m.ledger.getBudgetPosition('run').committed.costMicros,400);
});
test('US-10 RT-C17: independently approved plans for one attempt consume only the winning grant',async t=>{
 const f=await modelReady(t),other=f.plan(f.m.target,f.verification.verificationId);f.authorize(f.p);const grant=f.authorize(other);f.execute(f.p);assertRefusedWithoutEffects(f,()=>f.execute(other));
 assert.equal(tableCount(f.raw,'model_usage_authorities'),1);assert.equal(f.raw.prepare('SELECT status FROM reconciliation_grants WHERE grant_id=?').get(grant.grantId)!.status,'AUTHORIZED');
});
test('AU-01: plan binds canonical contract and is not invalidated by its own grants or unrelated candidate metadata',async t=>{
 const f=await modelReady(t),{planDigest,...data}=f.p;assert.equal(f.p.contract,'COORD-5C-4C:RECONCILIATION:1');assert.equal(planDigest,digest(data));
 f.submit(f.m.target,completeClaim());f.authorize(f.p);assert.equal(f.execute(f.p).status,'COMMITTED');
});
test('AU-04 AU-11 RT-C12: another authenticated operator or Admin cannot start a creator-owned plan before any effect',async t=>{
 const f=await modelReady(t);f.authorize(f.p);for(const role of ['RECOVERY_OPERATOR','RECOVERY_ADMIN'] as const)assertRefusedWithoutEffects(f,()=>f.execute(f.p,f.identity.credential('other',[role])));
 assert.equal(f.execute(f.p).status,'COMMITTED');assert.equal(f.counts.model,0);assert.equal(f.counts.action,0);
});
test('AU-06 RT-C13: two credentials and roles belonging to one actor cannot satisfy a two-person quorum',async t=>{
 const f=await modelReady(t,{policy:{approvals:{SETTLE_VERIFIED_MODEL_USAGE:{minimumApprovers:2,forbidSelfApproval:true}}}}),a=f.identity.credential('a',['RECOVERY_APPROVER']),a2=f.identity.credential('a',['RECOVERY_ADMIN']),b=f.identity.credential('b',['RECOVERY_APPROVER']);
 f.authorize(f.p,a);f.authorize(f.p,a2);assertRefusedWithoutEffects(f,()=>f.execute(f.p));f.authorize(f.p,b);assert.equal(f.execute(f.p).status,'COMMITTED');
});
test('AU-07: self approval and revoked approvals fail without consuming grants or accounting',async t=>{
 const f=await modelReady(t);assertRefusedWithoutEffects(f,()=>f.authorize(f.p,f.identity.credential('operator',['RECOVERY_ADMIN'])));
 const grant=f.authorize(f.p);f.api().authorizer.revoke(grant.grantId,f.approver);assertRefusedWithoutEffects(f,()=>f.execute(f.p));
});
test('AU-07: expired Plan/Grant never becomes success merely because the actor still has a role',async t=>{
 const f=await modelReady(t),p=f.plan(f.m.target,f.verification.verificationId,'SETTLE_VERIFIED_MODEL_USAGE',f.credential,60);f.authorize(p);await delay(100);assertRefusedWithoutEffects(f,()=>f.execute(p));
});
test('AU-08 RT-C18: old generation approval cannot be used by either stale or new lease',async t=>{
 const f=await modelReady(t);f.authorize(f.p);const old=f.api().executor;f.reacquire();assertRefusedWithoutEffects(f,()=>old.executeAuthorized(f.p.planId,f.credential));assertRefusedWithoutEffects(f,()=>f.execute(f.p));
});
test('AU-12 IN-08 IN-09 INV-10 INV-16: committed receipt survives generation change and retry is read-only',async t=>{
 const f=await modelReady(t);f.authorize(f.p);const receipt=f.execute(f.p);f.reacquire();const before=reconciliationContents(f.raw),calls={...f.counts};
 assert.deepEqual(new ReconciliationExecutor(f.db).inspectReceipt(f.p.planId,f.credential),receipt);assert.deepEqual(f.execute(f.p),receipt);assert.deepEqual(reconciliationContents(f.raw),before);assert.deepEqual(f.counts,calls);
});
test('AU-10 IN-12: Admin role does not imply evidence body access; metadata remains separately authorized',async t=>{
 const f=fixture(t),m=f.model(),e=f.submit(m.target),admin=f.identity.credential('other-admin',['RECOVERY_ADMIN']);
 f.acl((_actor,_target,permission)=>permission!=='VIEW_EVIDENCE_BODY');const before=reconciliationContents(f.raw);f.api().evidence.readEvidence(e.evidenceId,admin);assert.throws(()=>f.api().evidence.readBody(e.evidenceId,admin));assert.deepEqual(reconciliationContents(f.raw),before);
});
test('AC-01 AC-04 INV-09: recording a final action fact does not complete its Task; a separate approval applies it once',async t=>{
 const f=fixture(t),a=f.action(),v=await f.verified(a.target),original=history(f),p=f.plan(a.target,v.verification.verificationId);f.authorize(p);const outcome=f.execute(p);
 assert.deepEqual(history(f),original);assert.equal(f.store.getSnapshot('run').tasks.task.status,'ASSIGNED');assert.equal(tableCount(f.raw,'reconciled_action_outcomes'),1);
 const apply=f.plan(a.target,v.verification.verificationId,'APPLY_RECONCILED_ACTION_RESULT');assertRefusedWithoutEffects(f,()=>f.execute(apply));f.authorize(apply);const receipt=f.execute(apply);
 assert.equal(receipt.status,'COMMITTED');assert.equal(f.store.getSnapshot('run').tasks.task.status,'COMPLETED');assert.equal(f.store.getSnapshot('run').events.filter(e=>e.type==='TaskCompleted').length,1);assert.equal(f.counts.action,0);
 assert.deepEqual(f.raw.prepare('SELECT * FROM execution_ledger').all(),original.actions);assert.deepEqual(f.raw.prepare('SELECT * FROM execution_results').all(),original.results);
 assert.deepEqual(f.api().executor.inspectReceipt(p.planId,f.credential),outcome);const before=reconciliationContents(f.raw);assert.deepEqual(f.execute(apply),receipt);assert.deepEqual(reconciliationContents(f.raw),before);
});
test('AC-02: uncertain original result is retained when independently verified final action evidence is recorded',async t=>{
 const f=fixture(t),a=await f.historicalAction('UNCERTAIN'),v=await f.verified(a.target),before=history(f),p=f.plan(a.target,v.verification.verificationId);f.authorize(p);f.execute(p);assert.deepEqual(history(f),before);assert.equal(f.raw.prepare('SELECT state FROM execution_ledger').get()!.state,'REVIEW_REQUIRED');
});
test('AC-03: final action fact without result details is preserved but cannot authorize Task completion',async t=>{
 const f=fixture(t),a=f.action(),v=await f.verified(a.target,actionClaim('EXECUTED_FINAL',false)),p=f.plan(a.target,v.verification.verificationId);f.authorize(p);f.execute(p);assertRefusedWithoutEffects(f,()=>f.plan(a.target,v.verification.verificationId,'APPLY_RECONCILED_ACTION_RESULT'));assert.equal(f.store.getSnapshot('run').tasks.task.status,'ASSIGNED');
});
test('AC-05: suspended workflow can record external fact but result apply cannot invent a resume',async t=>{
 const f=fixture(t),a=f.action();f.add('WorkflowSuspended',{});const v=await f.verified(a.target),p=f.plan(a.target,v.verification.verificationId);f.authorize(p);f.execute(p);assertRefusedWithoutEffects(f,()=>f.plan(a.target,v.verification.verificationId,'APPLY_RECONCILED_ACTION_RESULT'));assert.equal(f.store.getSnapshot('run').run.status,'SUSPENDED');
});
test('AC-06: historically failed Task is never rewritten as completed by later external success evidence',async t=>{
 const f=fixture(t),a=await f.historicalAction('FAILED'),v=await f.verified(a.target),before=f.store.getSnapshot('run');
 assert.equal(tableCount(f.raw,'reconciliation_disputes'),1);assertRefusedWithoutEffects(f,()=>f.plan(a.target,v.verification.verificationId));
 assert.equal(f.store.getSnapshot('run').tasks.task.status,'FAILED');assert.deepEqual(f.store.getSnapshot('run'),before);assertRefusedWithoutEffects(f,()=>f.plan(a.target,v.verification.verificationId,'APPLY_RECONCILED_ACTION_RESULT'));
});
test('AC-07: a sealed action attempt rejects a late ordinary result before a second Task effect',async t=>{
 const f=fixture(t),a=f.action(),v=await f.verified(a.target),p=f.plan(a.target,v.verification.verificationId);f.authorize(p);f.execute(p);assertRefusedWithoutEffects(f,()=>a.coordinator.recordResult('run',a.task,a.target.attemptId,{status:'succeeded',summary:'Late normal result'}));
});
test('EV-07 US-02: signed partial usage is retained as evidence while full reservation and unresolved accounting remain',async t=>{
 const f=fixture(t),m=f.model(),claim={...completeClaim(),completeness:'PARTIAL' as const},v=await f.verified(m.target,claim),before=m.ledger.getBudgetPosition('run');
 assert.equal(v.verification.claim.completeness,'PARTIAL');assertRefusedWithoutEffects(f,()=>f.plan(m.target,v.verification.verificationId));assert.deepEqual(m.ledger.getBudgetPosition('run'),before);assert.equal(tableCount(f.raw,'model_usage_authorities'),0);
});
test('IN-03: reconciliation maintains an existing hold and never invokes original Action, Model, VERIFY, or Resume',async t=>{
 const f=await modelReady(t);f.held();const p=f.plan(f.m.target,f.verification.verificationId),hold=f.raw.prepare('SELECT * FROM recovery_holds').all();f.authorize(p);f.execute(p);
 assert.deepEqual(f.raw.prepare('SELECT * FROM recovery_holds').all(),hold);assert.equal(f.store.getSnapshot('run').events.filter(e=>e.type==='WorkflowResumed').length,0);assert.equal(f.counts.action,0);assert.equal(f.counts.model,0);assert.throws(()=>f.store.assertRecoveryExecution('run'));
});
test('CR-07: lost COMMIT acknowledgement recovers only from a durable receipt and never repeats settlement',async t=>{
 const f=await modelReady(t);f.authorize(f.p);const exec=DatabaseSync.prototype.exec;let lost=false;
 DatabaseSync.prototype.exec=function(sql:string){const result=exec.call(this,sql);if(sql==='COMMIT'&&!lost){lost=true;throw Error('synthetic lost commit ACK');}return result;};
 try{try{f.execute(f.p);}catch{}}finally{DatabaseSync.prototype.exec=exec;}assert.equal(lost,true);assert.equal(tableCount(f.raw,'model_usage_authorities'),1);const before=reconciliationContents(f.raw);const receipt=f.api().executor.inspectReceipt(f.p.planId,f.credential);assert.equal(receipt?.status,'COMMITTED');assert.deepEqual(f.execute(f.p),receipt);assert.deepEqual(reconciliationContents(f.raw),before);
});

test('US-11 US-12 IN-10 INV-08 INV-11: late usage on cancelled workflow preserves terminal Journal and original generation',async t=>{
 const f=fixture(t),m=f.model();f.add('WorkflowCancelled',{});f.reacquire();const original=history(f),v=await f.verified(m.target),p=f.plan(m.target,v.verification.verificationId);f.authorize(p);f.execute(p);
 assert.deepEqual(history(f),original);assert.equal(f.store.getSnapshot('run').run.status,'CANCELLED');assert.equal(m.ledger.getBudgetPosition('run').committed.costMicros,400);assert.equal(m.ledger.getBudgetPosition('run').outstanding.llmCalls,0);assert.equal(f.counts.model,0);
});
test('US-17: usage-only settlement never invents a response or APPLIED state',async t=>{
 const f=fixture(t),m=f.model(),claim={...completeClaim(),responseState:'UNAVAILABLE_REVIEW_REQUIRED' as const},v=await f.verified(m.target,claim),p=f.plan(m.target,v.verification.verificationId);f.authorize(p);f.execute(p);
 assert.equal(f.raw.prepare('SELECT application_status FROM model_call_ledger').get()!.application_status,'NOT_APPLICABLE');assert.equal(f.raw.prepare('SELECT response_status FROM reconciled_model_usages').get()!.response_status,'UNAVAILABLE_REVIEW_REQUIRED');assert.throws(()=>f.store.assertRecoveryExecution('run'));assert.equal(f.counts.model,0);
});
test('EV-03 AU-08: a new version preserves old evidence but makes its approved Plan stale',async t=>{
 const f=await modelReady(t);f.authorize(f.p);const oldBody=f.api().evidence.readBody(f.evidence.evidenceId,f.credential),second=f.submit(f.m.target,completeClaim(),undefined,f.credential,f.evidence.logicalId);
 assert.equal(second.version,f.evidence.version+1);assert.deepEqual(f.api().evidence.readBody(f.evidence.evidenceId,f.credential),oldBody);assertRefusedWithoutEffects(f,()=>f.execute(f.p));
});
test('AU-05: missing host approval policy fails closed for operations but still preserves submitted evidence',async t=>{
 const f=fixture(t,{policy:{approvals:{}}}),m=f.model(),v=await f.verified(m.target);assert.equal(v.verification.status,'VERIFIED');assertRefusedWithoutEffects(f,()=>f.plan(m.target,v.verification.verificationId));
});
test('EV-06: empty production registry preserves candidates and refuses to fabricate verification',async t=>{
 const f=fixture(t),m=f.model(),e=f.submit(m.target);f.register(false);const before=reconciliationContents(f.raw);await assert.rejects(f.api().evidence.verify({evidenceId:e.evidenceId,verifierId:'synthetic-ed25519'},f.credential));assert.deepEqual(reconciliationContents(f.raw),before);assert.equal(f.counts.verifier,0);
});
for(const table of ['model_usage_authorities','reconciled_model_usages','reconciliation_target_seals','reconciliation_operations','reconciliation_operation_grants','reconciliation_audit','reconciliation_cases'])test(`INV-09 CR-04: injected ${table} write failure rolls back usage, authority, Grant, receipt and control together`,async t=>{
 const f=await modelReady(t);f.authorize(f.p);f.raw.exec(`CREATE TRIGGER synthetic_failure BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'synthetic transaction fault'); END`);assertRefusedWithoutEffects(f,()=>f.execute(f.p));
});
test('INV-09 CR-05: injected Task event failure rolls back only the separate application and preserves the outcome',async t=>{
 const f=fixture(t),a=f.action(),v=await f.verified(a.target),p=f.plan(a.target,v.verification.verificationId);f.authorize(p);f.execute(p);const apply=f.plan(a.target,v.verification.verificationId,'APPLY_RECONCILED_ACTION_RESULT');f.authorize(apply);
 f.raw.exec("CREATE TRIGGER synthetic_task_failure BEFORE INSERT ON journal_events WHEN NEW.event_type IN ('TaskCompleted','TaskFailed') BEGIN SELECT RAISE(ABORT,'synthetic task fault'); END");assertRefusedWithoutEffects(f,()=>f.execute(apply));assert.equal(tableCount(f.raw,'reconciled_action_outcomes'),1);assert.equal(tableCount(f.raw,'reconciled_action_applications'),0);
});

test('US-03: signed source totals include cache and reasoning; normalization uses each inclusive total once',async t=>{
 const f=fixture(t),m=f.model(),raw={...f.payload(m.target),providerCounts:{inputTotal:200,cachedInputSubset:50,outputTotal:200,reasoningOutputSubset:40}};
 f.synthetic.hook((_request,signed)=>{const {providerCounts,...payload}=signed as typeof raw;assert.ok(providerCounts.cachedInputSubset<=providerCounts.inputTotal&&providerCounts.reasoningOutputSubset<=providerCounts.outputTotal);return {...payload,claim:{...payload.claim,usage:{llmCalls:1,inputTokens:providerCounts.inputTotal,outputTokens:providerCounts.outputTotal,estimatedCost:0.0004}}};});
 const evidence=f.api().evidence.submitCandidate({target:m.target,body:f.synthetic.sign(raw),dataClass:'synthetic',contentType:'application/json'},f.credential),v=await f.api().evidence.verify({evidenceId:evidence.evidenceId,verifierId:f.synthetic.binding.verifierId},f.credential),p=f.plan(m.target,v.verificationId);f.authorize(p);f.execute(p);
 assert.equal(m.ledger.getBudgetPosition('run').committed.inputTokens,200);assert.equal(m.ledger.getBudgetPosition('run').committed.outputTokens,200);assert.equal(m.ledger.getBudgetPosition('run').committed.costMicros,400);
});
test('US-13: old generation ordinary response remains fenced while a current verifier and fresh approval settle its usage',async t=>{
 const f=fixture(t),m=f.model(),old=f.raw.prepare('SELECT * FROM model_call_ledger').all();f.reacquire();assertRefusedWithoutEffects(f,()=>m.ledger.settle(m.x,{...completeUsage},false));
 const v=await f.verified(m.target),p=f.plan(m.target,v.verification.verificationId);f.authorize(p);f.execute(p);assert.deepEqual(f.raw.prepare('SELECT * FROM model_call_ledger').all(),old);assert.equal(new ModelCallLedger(f.store).getBudgetPosition('run').committed.costMicros,400);
});
test('US-15: non-model legacy Journal usage is preserved and added once alongside the reconciled authority',async t=>{
 const f=fixture(t);f.add('UsageRecorded',{llmCalls:2,inputTokens:17,outputTokens:19,estimatedCost:0.000003,sourceRef:'synthetic-non-model-usage'});const m=f.model(),v=await f.verified(m.target),p=f.plan(m.target,v.verification.verificationId),historical=f.store.getSnapshot('run').run.usage;f.authorize(p);f.execute(p);
 const position=m.ledger.getBudgetPosition('run');assert.deepEqual(position.committed,{llmCalls:3,inputTokens:217,outputTokens:219,costMicros:403});assert.deepEqual(f.store.getSnapshot('run').run.usage,historical);assert.equal(tableCount(f.raw,'model_usage_authorities'),1);
});
test('IN-01: resolving one action obligation does not erase another model reservation or its diagnostic obligation',async t=>{
 const f=fixture(t),pending=f.model('pending','RESERVED'),a=f.action(),v=await f.verified(a.target),p=f.plan(a.target,v.verification.verificationId);f.authorize(p);f.execute(p);
 const inspection=new ReconciliationReader(f.db).inspect(a.target,f.credential);assert.equal(inspection.executionAllowed,false);assert.ok(inspection.obligations.some(x=>x.targetId==='pending'&&x.reason==='USAGE_UNSETTLED'));assert.equal(pending.ledger.getBudgetPosition('run').outstanding.llmCalls,1);
});
