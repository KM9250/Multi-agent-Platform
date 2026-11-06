import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import type { TestContext } from 'node:test';
import { DurableDatabase, SqliteCoordinationRunnerStore, RecoveryPlanner, RecoveryAuthorizer, RecoveryDecisionStore } from '../services/coordination/durable/index.ts';
import type { RecoveryAuthorizationPolicy, RecoveryRole } from '../services/coordination/durable/recoveryDecisionTypes.ts';
import { scopeOf } from '../services/coordination/durable/recoveryDecisionStore.ts';
import { executionSeed } from './durable-execution-fixture.ts';

/** Only tests can mint credentials. The verifier compares object identity, never a claimed role. */
export function testIdentityProvider() {
  const identities = new WeakMap<object, {actorId:string; roles:RecoveryRole[]}>();
  return {
    credential(actorId='operator', roles:RecoveryRole[]=['RECOVERY_ADMIN']) { const token=Object.freeze({}); identities.set(token,{actorId,roles}); return token; },
    verifier: { verify(token: unknown, now: number) {
      if (!token || typeof token !== 'object') return;
      const identity=identities.get(token); return identity && {...identity,source:'test-identity',authenticatedAt:now-1,expiresAt:now+1_800_000};
    } },
  };
}
export function authorizationFixture(t:TestContext, policy:RecoveryAuthorizationPolicy={}) {
  const dir=mkdtempSync(join(tmpdir(),'map-authorization-')),path=join(dir,'db.sqlite');
  const identity=testIdentityProvider(), credential=identity.credential();
  const db=new DurableDatabase({path,recoveryIdentityVerifier:identity.verifier,recoveryAuthorizationPolicy:policy});
  const admin=new SqliteCoordinationRunnerStore(db);admin.createWorkflow(executionSeed());
  const manager=db.createLeaseManager(),lease=manager.acquire('run'),store=admin.withLease(lease);
  const raw=new DatabaseSync(path);raw.exec('PRAGMA foreign_keys=ON');
  t.after(()=>{raw.close();db.close();rmSync(dir,{recursive:true,force:true});});
  const planner=new RecoveryPlanner(db,lease),authorizer=new RecoveryAuthorizer(db,lease),decisions=new RecoveryDecisionStore(db);
  const plan=(ttlMs?:number)=>planner.createPlan({workflowRunId:'run',operationKind:'BOUNDED_CONTINUATION',targetId:'run',ttlMs},credential);
  const authorize=(p=plan(),token=credential,ttlMs?:number)=>authorizer.authorize(p.recoveryPlanId,scopeOf(p),token,ttlMs);
  const hold=()=>{store.append({eventId:'stop',sequence:2,workflowRunId:'run',actorAgentId:'supervisor',type:'WorkflowSuspended',timestamp:2,payload:{}});try{store.assertRecoveryExecution('run');}catch{}}
  return {dir,path,db,raw,admin,manager,lease,store,identity,credential,planner,authorizer,decisions,plan,authorize,hold};
}
