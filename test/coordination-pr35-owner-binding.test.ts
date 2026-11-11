import test from 'node:test';
import assert from 'node:assert/strict';
import { continuationFixture } from './continuation-fixture.ts';
import { hold, executeInput } from './continuation-runner-fixture.ts';
import { DurableDatabase } from '../services/coordination/durable/db.ts';
import { RecoveryContinuationReader } from '../services/coordination/durable/recoveryContinuationReader.ts';

type Fixture=ReturnType<typeof continuationFixture>;
const questions=['Which recovery target should be inspected?','What is the permitted scope?'];
const usage={llmCalls:1,inputTokens:1,outputTokens:1,estimatedCost:0};
function persisted(f:Fixture) {
  return Object.fromEntries(f.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(r=>[String(r.name),f.raw.prepare(`SELECT * FROM "${String(r.name).replaceAll('"','""')}" ORDER BY rowid`).all()]));
}

for(const mode of ['THINK_ONLY','PLAN_READ_ONLY'] as const)for(const role of ['RECOVERY_OPERATOR','RECOVERY_ADMIN'] as const)
test(`PR35 F-04: ${mode} RECOVERY rejects another ${role} before effects; creator can use the same Grant`,async t=>{
  const f=continuationFixture(t),alice=f.identity.credential('alice',['RECOVERY_OPERATOR']),bob=f.identity.credential('bob',[role]);
  // Both actors pass Workflow ACL; Recovery roles and a separate valid approval are present.
  hold(f);const input=f.input(mode);input.origin='RECOVERY';input.resume={authorization:{type:'user'},reason:'Explicit recovery planning'};
  f.hook(async()=>({value:{kind:'needs_input',questions},usage,completeness:'COMPLETE'}));
  const p=f.api().createPlan(input,alice),grant=f.api().authorize(p,f.approver),before=persisted(f),snapshot=f.store.getSnapshot('run');
  assert.equal(p.createdBy,'alice');assert.equal(snapshot.run.status,'SUSPENDED');
  assert.equal(f.raw.prepare('SELECT status FROM recovery_continuation_grants WHERE grant_id=?').get(grant)!.status,'AUTHORIZED');
  await assert.rejects(f.api().startAuthorized(p.planId,bob));
  t.diagnostic(JSON.stringify({draftCalls:f.counts.draft,grant:f.raw.prepare('SELECT status FROM recovery_continuation_grants WHERE grant_id=?').get(grant)!.status,
    invocations:f.raw.prepare('SELECT count(*) n FROM recovery_invocations').get()!.n,questions:f.raw.prepare('SELECT count(*) n FROM planning_input_requests').get()!.n,
    workflow:f.store.getSnapshot('run').run.status}));
  assert.deepEqual(f.counts,{draft:0,plan:0,verify:0,action:0,prepare:0});
  assert.deepEqual(persisted(f),before);assert.deepEqual(f.store.getSnapshot('run'),snapshot);
  // Reuse the exact Plan/Grant: rejection did not consume approval or apply Resume.
  const first=await f.api().startAuthorized(p.planId,alice);
  assert.equal(first.invocation?.status,'STOPPED');assert.equal(first.invocation?.outcome,'PLAN_INCOMPLETE');
  assert.equal(first.inputRequest?.ownerId,'alice');assert.deepEqual(first.inputRequest?.questions,questions);
  assert.equal(f.raw.prepare('SELECT status FROM recovery_continuation_grants WHERE grant_id=?').get(grant)!.status,'CONSUMED');
  assert.equal(f.raw.prepare('SELECT owner_id FROM recovery_invocations').get()!.owner_id,'alice');
  assert.equal(first.usage.committed.inputTokens,1);assert.equal(first.counts.readCalls,0);
  const saved=persisted(f),counts={...f.counts};
  assert.deepEqual(f.api().inspect(p.planId,alice).inputRequest,first.inputRequest);
  assert.deepEqual((await f.api().startAuthorized(p.planId,alice)).inputRequest,first.inputRequest);
  const second=new DurableDatabase(f.options);
  try{
    const reader=new RecoveryContinuationReader(second);
    assert.deepEqual(reader.inspect(p.planId,alice).inputRequest,first.inputRequest);
    assert.throws(()=>reader.inspect(p.planId,bob));
    assert.throws(()=>reader.inspect(p.planId,f.identity.credential('other-admin',['RECOVERY_ADMIN'])));
  }finally{second.close();}
  await assert.rejects(f.api().startAuthorized(p.planId,bob));
  assert.deepEqual(persisted(f),saved);assert.deepEqual(f.counts,counts);assert.equal(f.counts.draft,1);
});

for(const mode of ['THINK_ONLY','PLAN_READ_ONLY'] as const)test(`PR35 F-04: ${mode} USER_REQUEST still requires creator and configured planning role`,async t=>{
  const f=continuationFixture(t),p=f.api().createPlan(f.input(mode),f.credential),before=persisted(f);
  await assert.rejects(f.api().startAuthorized(p.planId,f.identity.credential('other-admin',['RECOVERY_ADMIN'])));
  await assert.rejects(f.api().startAuthorized(p.planId,f.identity.credential('operator',['RECOVERY_OPERATOR'])));
  assert.deepEqual(persisted(f),before);assert.equal(f.counts.draft,0);
  const r=await f.api().startAuthorized(p.planId,f.credential);assert.equal(r.invocation?.status,'COMPLETED');assert.equal(f.counts.draft,1);
});

test('PR35 F-04: separately authorized BOUNDED_CONTINUATION may still be started by another Admin',async t=>{
  const f=continuationFixture(t),alice=f.identity.credential('alice',['RECOVERY_OPERATOR']),admin=f.identity.credential('admin',['RECOVERY_ADMIN']);
  hold(f);const p=f.api().createPlan(executeInput(f),alice);f.api().authorize(p,f.approver);
  const r=await f.api().startAuthorized(p.planId,admin);
  assert.equal(r.invocation?.status,'COMPLETED');assert.equal(f.counts.action,1);
  assert.equal(f.raw.prepare('SELECT owner_id FROM recovery_invocations').get()!.owner_id,'admin');assert.equal(r.plan.createdBy,'alice');
});
