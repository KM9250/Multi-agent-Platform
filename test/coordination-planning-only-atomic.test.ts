import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { continuationFixture,content } from './continuation-fixture.ts';
import { RecoveryContinuationCoordinator } from '../services/coordination/durable/recoveryContinuationCoordinator.ts';
import { DurableDatabase } from '../services/coordination/durable/db.ts';

import {fault} from './continuation-fault-fixture.ts';
for(const when of ['BEFORE','ACK'] as const)test(`I02/I03: invocation start ${when} cannot manufacture runner authority`,async t=>{
 const f=continuationFixture(t),p=f.api().createPlan(f.input(),f.credential);
 await fault('INSERT INTO recovery_invocations',when,async()=>{
  if(when==='BEFORE')await assert.rejects(f.api().startAuthorized(p.planId,f.credential));
  else assert.equal((await f.api().startAuthorized(p.planId,f.credential)).invocation?.status,'ACTIVE');
 });
 assert.equal(f.counts.draft,0);assert.equal(f.raw.prepare('SELECT count(*) n FROM recovery_invocations').get()!.n,when==='ACK'?1:0);
 assert.equal(f.raw.prepare('SELECT status FROM recovery_continuation_grants').get()!.status,when==='ACK'?'CONSUMED':'AUTHORIZED');
 if(when==='ACK')assert.equal((await f.api().startAuthorized(p.planId,f.credential)).counts.modelCalls,0);
});
for(const boundary of ['INSERT INTO model_call_ledger','INSERT INTO recovery_invocation_debits',"SET state='DISPATCH_INTENT'",'INSERT INTO planning_artifacts'])test(`I05/P14: rollback at ${boundary} keeps debit/ledger/application atomic`,async t=>{
 const f=continuationFixture(t),p=f.api().createPlan(f.input(),f.credential);
 await fault(boundary,'BEFORE',()=>f.api().startAuthorized(p.planId,f.credential));
 const ledger=f.raw.prepare('SELECT * FROM model_call_ledger').all(),debits=f.raw.prepare("SELECT * FROM recovery_invocation_debits WHERE kind='MODEL'").all();assert.equal(ledger.length,debits.length);
 if(boundary==='INSERT INTO planning_artifacts'){
  assert.equal(ledger[0].state,'SETTLED');assert.equal(ledger[0].application_status,'PENDING_APPLICATION');assert.equal(f.raw.prepare('SELECT count(*) n FROM planning_artifacts').get()!.n,0);assert.equal(f.counts.draft,1);
 } else assert.equal(f.counts.draft,0);
 await f.api().startAuthorized(p.planId,f.credential);assert.equal(f.counts.draft,boundary==='INSERT INTO planning_artifacts'?1:0);
});
for(const boundary of ["SET state='DISPATCH_INTENT'",'INSERT INTO planning_artifacts'])test(`P15/I17: ACK loss at ${boundary} only permits receipt inspection`,async t=>{
 const f=continuationFixture(t),p=f.api().createPlan(f.input(),f.credential);
 await fault(boundary,'ACK',()=>f.api().startAuthorized(p.planId,f.credential));
 const r=f.api().inspect(p.planId,f.credential),n=f.counts.draft;
 if(boundary==='INSERT INTO planning_artifacts'){assert.equal(r.invocation?.outcome,'AWAITING_PLAN_REVIEW');assert.deepEqual(r.artifact?.content,content);}
 const other=new DurableDatabase(f.options);try{const api=new RecoveryContinuationCoordinator(other);assert.deepEqual((await api.startAuthorized(p.planId,f.credential)).artifact,r.artifact);}finally{other.close();}
 assert.equal(f.counts.draft,n);
});
test('M05: a viewer from another actor/workflow cannot obtain plan content',async t=>{
 const f=continuationFixture(t),p=f.api().createPlan(f.input(),f.credential);await f.api().startAuthorized(p.planId,f.credential);
 assert.throws(()=>f.api().inspect(p.planId,f.identity.credential('other',['RECOVERY_VIEWER'])));
 f.policy.canAccess=()=>false;assert.throws(()=>f.api().inspect(p.planId,f.credential));
});
