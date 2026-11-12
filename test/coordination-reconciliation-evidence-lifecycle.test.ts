import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { reconciliationFixture, reconciliationContents, assertRefusedWithoutEffects, completeClaim } from './reconciliation-fixture.ts';
import { ReconciliationReader } from '../services/coordination/durable/reconciliationReader.ts';

test('EV-01 CR-01: an identical candidate retry returns immutable metadata without another body, version, or audit',t=>{
  const f=reconciliationFixture(t),{target}=f.model(),body=f.synthetic.sign(f.payload(target));
  const input={target,body,dataClass:'synthetic',contentType:'application/json' as const};
  const first=f.api().evidence.submitCandidate(input,f.credential),before=reconciliationContents(f.raw);
  assert.deepEqual(f.api().evidence.submitCandidate(input,f.credential),first);
  assert.deepEqual(reconciliationContents(f.raw),before);
});
test('IN-08 IN-09 RT-C20: explicit host trust revocation appends dispute without deleting settled usage or invalidating its historical receipt',async t=>{
  let revoked=false;
  const f=reconciliationFixture(t);const registry=f.options.reconciliation!.verifiers!;
  // Use a fresh DB runtime: the host dependency is fixed at construction.
  const second=reconciliationFixture(t,{reconciliation:{verifiers:{get:id=>registry.get(id),isRevoked:()=>revoked}}});
  const {target}=second.model();const body=f.synthetic.sign(second.payload(target));
  const evidence=second.api().evidence.submitCandidate({target,body,dataClass:'synthetic',contentType:'application/json'},second.credential);
  const verification=await second.api().evidence.verify({evidenceId:evidence.evidenceId,verifierId:f.synthetic.binding.verifierId},second.credential);
  const p=second.plan(target,verification.verificationId);second.authorize(p);const receipt=second.execute(p);
  assertRefusedWithoutEffects(second,()=>second.api().evidence.revokeVerification(verification.verificationId,second.credential));
  const oldAuthority=second.raw.prepare('SELECT * FROM model_usage_authorities').all(),oldJournal=second.raw.prepare('SELECT * FROM journal_events').all();
  revoked=true;second.api().evidence.revokeVerification(verification.verificationId,second.credential);
  assert.deepEqual(second.raw.prepare('SELECT * FROM model_usage_authorities').all(),oldAuthority);
  assert.deepEqual(second.raw.prepare('SELECT * FROM journal_events').all(),oldJournal);
  assert.deepEqual(second.api().executor.inspectReceipt(p.planId,second.credential),receipt);
  const inspection=new ReconciliationReader(second.db).inspect(target,second.credential);
  assert.equal(inspection.holdState,'HELD');assert.ok(inspection.obligations.some(o=>o.reason==='DISPUTED'));
  const after=reconciliationContents(second.raw);second.api().evidence.revokeVerification(verification.verificationId,second.credential);assert.deepEqual(reconciliationContents(second.raw),after);
  assert.equal(second.counts.action,0);assert.equal(second.counts.model,0);
});

test('EV-07 US-02: genuinely partial usage retains known tokens without inventing absent cost or releasing reservation',async t=>{
  const f=reconciliationFixture(t),{target}=f.model();
  const claim={...completeClaim(),completeness:'PARTIAL' as const,usage:{inputTokens:17} as import('../services/coordination/runner/types.ts').RunnerModelUsage};
  delete claim.pricingId;delete claim.currency;
  const {verification}=await f.verified(target,claim);
  assert.deepEqual(verification.claim.usage,{inputTokens:17});
  assertRefusedWithoutEffects(f,()=>f.plan(target,verification.verificationId));
  assert.equal(f.raw.prepare('SELECT count(*) n FROM model_usage_authorities').get()!.n,0);
  assert.equal(f.raw.prepare('SELECT reserved_input FROM model_call_ledger').get()!.reserved_input,500);
});

test('EV-01 RT-C15: host-classified unsafe secret material fails with EVIDENCE_STORAGE_UNSUPPORTED before persistence',t=>{
  const f=reconciliationFixture(t,{policy:{inspectContent:(_value,context)=>context.stage!=='ACCEPT'}}),{target}=f.model();
  const before=reconciliationContents(f.raw);
  assert.throws(()=>f.api().evidence.submitCandidate({target,body:{syntheticSecret:'not-a-real-secret'},dataClass:'restricted',contentType:'application/json'},f.credential),{code:'EVIDENCE_STORAGE_UNSUPPORTED'});
  assert.deepEqual(reconciliationContents(f.raw),before);assert.equal(f.counts.verifier,0);assert.equal(f.counts.model,0);
});

test('RT-C07: a configured trust revocation checker outage fails closed before Grant consumption',async t=>{
  let unavailable=false;const issuer=reconciliationFixture(t),registry=issuer.options.reconciliation!.verifiers!;
  const f=reconciliationFixture(t,{reconciliation:{verifiers:{get:id=>registry.get(id),isRevoked:()=>{if(unavailable)throw Error('synthetic outage');return false;}}}});
  const {target}=f.model(),body=issuer.synthetic.sign(f.payload(target));
  const evidence=f.api().evidence.submitCandidate({target,body,dataClass:'synthetic',contentType:'application/json'},f.credential);
  const v=await f.api().evidence.verify({evidenceId:evidence.evidenceId,verifierId:issuer.synthetic.binding.verifierId},f.credential);
  const plan=f.plan(target,v.verificationId);f.authorize(plan);unavailable=true;
  assertRefusedWithoutEffects(f,()=>f.execute(plan));
});
test('RT-C09 RT-C14: caller AbortSignal accessors are never executed and ignored verifier cancellation ends promptly',async t=>{
  const f=reconciliationFixture(t),{target}=f.model(),evidence=f.submit(target);let getters=0;
  const fake=Object.defineProperty({},'aborted',{get(){getters++;return false;}});
  await assert.rejects(f.api().evidence.verify({evidenceId:evidence.evidenceId,verifierId:f.synthetic.binding.verifierId},f.credential,fake as AbortSignal));
  assert.equal(getters,0);assert.equal(f.counts.verifier,0);
  f.synthetic.hook(()=>new Promise(()=>{}));const controller=new AbortController();
  const pending=f.api().evidence.verify({evidenceId:evidence.evidenceId,verifierId:f.synthetic.binding.verifierId},f.credential,controller.signal);
  const started=performance.now();controller.abort();await assert.rejects(pending);assert.ok(performance.now()-started<1000);
  assert.equal(f.raw.prepare('SELECT count(*) n FROM reconciliation_verifications').get()!.n,0);
});

test('RT-C08 INV-14: verifier payload uses classified nonsecret binding metadata and never raw model or action payloads',async t=>{
  let classified=0;const f=reconciliationFixture(t,{policy:{inspectContent:(value,context)=>{if(context.stage==='VERIFY'){assert.ok((value as {targetSnapshot?:unknown}).targetSnapshot);classified++;}return true;}}});
  const {target}=f.model();f.synthetic.hook((request,result)=>{const text=JSON.stringify(request.targetSnapshot);assert.ok(!text.includes('quote_json'));assert.ok(!text.includes('conditions'));assert.ok(!text.includes('prepared_action_json'));assert.match(String(request.targetSnapshot.requestDigest),/^[a-f0-9]{64}$/);return result;});
  await f.verified(target);assert.ok(classified>=3);assert.equal(f.counts.model,0);
});
test('CR-01 CR-07: verification COMMIT acknowledgement loss recovers its immutable job receipt without repeating the verifier',async t=>{
  const f=reconciliationFixture(t),{target}=f.model(),evidence=f.submit(target),exec=DatabaseSync.prototype.exec;let lost=false;
  DatabaseSync.prototype.exec=function(sql:string){const result=exec.call(this,sql);if(sql==='COMMIT'&&!lost&&Number(this.prepare('SELECT count(*) n FROM reconciliation_verifications').get()!.n)>0){lost=true;throw Error('synthetic verification ACK loss');}return result;};
  let verification;try{verification=await f.api().evidence.verify({evidenceId:evidence.evidenceId,verifierId:f.synthetic.binding.verifierId},f.credential);}finally{DatabaseSync.prototype.exec=exec;}
  assert.equal(lost,true);assert.equal(f.counts.verifier,1);assert.equal(verification.status,'VERIFIED');
  const before=reconciliationContents(f.raw);assert.deepEqual(await f.api().evidence.verify({evidenceId:evidence.evidenceId,verifierId:f.synthetic.binding.verifierId},f.credential),verification);
  assert.deepEqual(reconciliationContents(f.raw),before);assert.equal(f.counts.verifier,1);
});
