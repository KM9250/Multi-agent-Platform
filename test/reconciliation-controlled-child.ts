// Native process boundaries only; production exposes no Scope or crash hooks.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { controlledConflictFixture } from './reconciliation-controlled-fixture.ts';
import { reconciliationContents } from './reconciliation-fixture.ts';
import { testIdentityProvider } from './recovery-authorization-fixture.ts';
import { DurableDatabase } from '../services/coordination/durable/db.ts';
import { RecoveryDispatchCoordinator } from '../services/coordination/durable/recoveryDispatchCoordinator.ts';
import { ReconciliationReader } from '../services/coordination/durable/reconciliationReader.ts';
import { syntheticSource } from './reconciliation-fixture.ts';

const [path,boundary]=process.argv.slice(2),dir=dirname(path),counter=join(dir,'external-count.txt');
if(boundary==='retry') {
  const identity=testIdentityProvider(),credential=identity.credential(),planId=readFileSync(join(dir,'plan.txt'),'utf8');
  const executor={id:'test',prepare:async()=>{throw Error('Unexpected prepare');},execute:async()=>{appendFileSync(counter,'execute\n');throw Error('Unexpected replay');}};
  const db=new DurableDatabase({path,recoveryIdentityVerifier:identity.verifier,controlledExecutors:{get:()=>({executor,contractVersion:'test:1',implementationDigest:'a'.repeat(64),sideEffectRetries:'disabled'})},
    reconciliation:{policy:{version:'synthetic-controlled-conflict:1',authorityDomain:syntheticSource.authorityDomain,approvals:{},canAccess:()=>true,inspectContent:()=>true}}});
  const coordinator=new RecoveryDispatchCoordinator(db,undefined),result=await coordinator.executeAuthorized(planId,credential);
  assert.deepEqual(await coordinator.executeAuthorized(planId,credential),result);
  const target={workflowRunId:result.intent!.workflowRunId,targetKind:'ACTION' as const,targetId:result.intent!.actionId,attemptId:result.intent!.attemptId};
  const inspected=new ReconciliationReader(db).inspect(target,credential);
  process.send!({status:result.status,taskStatus:result.taskStatus,disputed:inspected.obligations.some(o=>o.reason==='DISPUTED')});
  db.close();process.disconnect();
} else {
  const c=await controlledConflictFixture({after(){}},{path,dir},()=>appendFileSync(counter,'execute\n'));
  c.synthetic.hook((_request,result)=>{appendFileSync(counter,'verify\n');return result;});
  await c.verify();
  writeFileSync(join(dir,'before.json'),JSON.stringify(reconciliationContents(c.f.raw)));writeFileSync(join(dir,'plan.txt'),c.plan.planId);
  const exec=DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec=function(sql:string){
    const b=sql==='COMMIT'&&this.prepare('SELECT count(*) n FROM reconciliation_disputes').get()!.n===1;
    if(b&&boundary==='before-B')process.kill(process.pid,process.platform==='win32'?'SIGTERM':'SIGKILL');
    const result=exec.call(this,sql);
    if(b&&boundary==='after-B')process.kill(process.pid,process.platform==='win32'?'SIGTERM':'SIGKILL');
    return result;
  };
  c.release({status:'failed',summary:'Synthetic conflicting child response'});await c.pending;throw Error('Missing Controlled conflict crash boundary');
}
