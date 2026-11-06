// Native SQLite fault boundaries only: the production executor has no test hooks.
import { DatabaseSync } from 'node:sqlite';
import type { TestContext } from 'node:test';
import { dirname } from 'node:path';
import { DurableDatabase } from '../services/coordination/durable/index.ts';
import { recoveryExecutionFixture, recoveryContents } from './recovery-execution-fixture.ts';
const [path,operation,boundary] = process.argv.slice(2);
const terminate = () => { process.kill(process.pid, process.platform === 'win32' ? 'SIGTERM' : 'SIGKILL'); };
const originalExec=DatabaseSync.prototype.exec, originalPrepare=DatabaseSync.prototype.prepare;
let armed=false;
function install() {
  DatabaseSync.prototype.exec=function(sql:string){
    if(armed && boundary==='before-commit' && sql==='COMMIT')terminate();
    if(armed && boundary==='before-ddl' && sql.includes('CREATE TABLE recovery_execution_plans'))terminate();
    const result=originalExec.call(this,sql);
    if(armed && boundary==='after-commit' && sql==='COMMIT')terminate();
    if(armed && boundary==='after-ddl' && sql.includes('CREATE TABLE recovery_execution_plans'))terminate();
    return result;
  };
  DatabaseSync.prototype.prepare=function(sql:string){
    const statement=originalPrepare.call(this,sql),run=statement.run.bind(statement);
    statement.run=(...args:Parameters<typeof statement.run>)=>{
      const result=run(...args);
      if(armed && ((boundary==='grant'&&sql.startsWith('UPDATE recovery_execution_grants'))
        ||(boundary==='resolution'&&sql.startsWith('INSERT INTO recovery_model_resolutions'))
        ||(boundary==='hold'&&sql.startsWith('INSERT INTO recovery_hold_transitions'))
        ||(boundary==='result'&&sql.startsWith('UPDATE execution_ledger'))))terminate();
      return result;
    };
    return statement;
  };
}
if(operation==='migration') {
  install();armed=true;new DurableDatabase({path});throw Error('Migration did not reach crash boundary');
}
const f=recoveryExecutionFixture({after(){}} as unknown as TestContext,{}, {path,dir:dirname(path)});
let kind:'CANCEL_UNSENT_MODEL'|'DISCARD_SETTLED_RESPONSE'|'REFLECT_RECORDED_RESULT'|'COMPLETE_SAFETY_STOP',target='model';
if(operation==='cancel'){f.reserve();kind='CANCEL_UNSENT_MODEL';}
else if(operation==='discard'){f.settled();kind='DISCARD_SETTLED_RESPONSE';}
else {await f.action(operation==='safety'?'uncertain':'succeeded');kind=operation==='safety'?'COMPLETE_SAFETY_STOP':'REFLECT_RECORDED_RESULT';target='action';}
f.reacquire();const p=f.plan(kind,target);f.authorize(p);
process.send!({ready:true,before:recoveryContents(f.raw),planId:p.executionPlanId,kind});
process.once('message',()=>{install();armed=true;f.execute(p);throw Error('Operation did not reach crash boundary');});
