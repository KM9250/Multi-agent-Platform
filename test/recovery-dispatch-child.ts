// Tests intercept native SQLite boundaries; production has no crash hooks.
import { DatabaseSync } from 'node:sqlite';
import { appendFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { dispatchFixture,dispatchContents } from './recovery-dispatch-fixture.ts';
import { DurableDatabase } from '../services/coordination/durable/db.ts';
import { ControlledRecoveryPlanner,ControlledRecoveryAuthorizer,RecoveryDispatchCoordinator,controlledScopeOf } from '../services/coordination/durable/recoveryDispatchCoordinator.ts';
import { testIdentityProvider } from './recovery-authorization-fixture.ts';

const [path,mode,boundary,counter,priorPlan] = process.argv.slice(2);
const kill=()=>process.kill(process.pid,process.platform==='win32'?'SIGTERM':'SIGKILL');
const nativeExec=DatabaseSync.prototype.exec,nativePrepare=DatabaseSync.prototype.prepare;
let phase='',aCommitted=false;
function intercept(){
  DatabaseSync.prototype.prepare=function(sql:string){
    const stmt=nativePrepare.call(this,sql),run=stmt.run.bind(stmt);
    stmt.run=(...args:Parameters<typeof stmt.run>)=>{
      const value=run(...args);
      if(sql.startsWith('INSERT INTO recovery_dispatch_intents'))phase='A';
      if(sql.startsWith('INSERT INTO execution_results'))phase='B';
      return value;
    };return stmt;
  };
  DatabaseSync.prototype.exec=function(sql:string){
    if(mode==='migration' && boundary==='before-ddl' && sql.includes('CREATE TABLE recovery_controlled_plans'))kill();
    if(sql==='COMMIT' && boundary===`before-${phase}`)kill();
    if(sql==='COMMIT' && boundary==='before-send' && aCommitted)kill();
    if(mode==='migration' && boundary==='before-commit' && sql==='COMMIT')kill();
    const value=nativeExec.call(this,sql);
    if(mode==='migration' && boundary==='after-ddl' && sql.includes('CREATE TABLE recovery_controlled_plans'))kill();
    if(mode==='migration' && boundary==='after-commit' && sql==='COMMIT')kill();
    if(sql==='COMMIT' && boundary===`after-${phase}`)kill();
    if(sql==='COMMIT' && phase==='A'){aCommitted=true;phase='';}
    return value;
  };
}
if(mode==='migration'){intercept();new DurableDatabase({path});throw Error('Missing migration crash');}
if(mode==='retry' || mode==='race'){
  const identity=testIdentityProvider(),credential=identity.credential(),approver=identity.credential('approver',['RECOVERY_APPROVER']);
  const executor={id:'test',prepare:async()=>{throw Error('unexpected prepare');},execute:async()=>{appendFileSync(counter,'send\n');return {status:'succeeded' as const,summary:'Synthetic child result.'};}};
  const db=new DurableDatabase({path,recoveryIdentityVerifier:identity.verifier,controlledExecutors:{get:()=>({executor,contractVersion:'test:1',implementationDigest:'a'.repeat(64),sideEffectRetries:'disabled'})}});
  process.send!({ready:true});
  process.once('message',async()=>{
    try{
      let planId=priorPlan,lease;
      if(mode==='race'){
        lease=db.createLeaseManager({ttlMs:1000}).acquire('run');
        const plan=new ControlledRecoveryPlanner(db,lease).createPlan({workflowRunId:'run',actionId:'action'},credential);planId=plan.planId;
        new ControlledRecoveryAuthorizer(db,lease).authorize(planId,controlledScopeOf(plan),approver);
      }
      const result=await new RecoveryDispatchCoordinator(db,lease).executeAuthorized(planId,credential);process.send!({done:true,status:result.status,outcome:result.outcome});
    }catch(error){process.send!({done:true,error:(error as {code?:string}).code??'ERROR'});}
    finally{db.close();process.disconnect();}
  });
}else{
  const f=dispatchFixture({after(){}},{path,dir:dirname(path)}),p=f.plan();f.authorize(p);
  f.hook(async()=>{
    appendFileSync(counter,'send\n');
    if(boundary==='after-send')kill();
    if(boundary==='after-evidence'){await f.put({synthetic:'evidence'});kill();}
    return {status:'succeeded',summary:'Synthetic child result.'};
  });
  process.send!({ready:true,planId:p.planId,before:dispatchContents(f.raw)});
  process.once('message',async()=>{intercept();await f.execute(p);throw Error('Missing dispatch crash');});
}
