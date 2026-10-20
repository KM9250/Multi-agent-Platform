// Test-only fault injection through the actual SQLite driver. No production crash hooks.
import { DatabaseSync } from 'node:sqlite';
import { appendFileSync } from 'node:fs';
import { DurableDatabase, SqliteCoordinationRunnerStore, DurableExecutionCoordinator } from '../services/coordination/durable/index.ts';
import { registration, record, clock } from './durable-execution-fixture.ts';
const [path, mode, effectPath] = process.argv.slice(2);
const db = new DurableDatabase({path}), store = new SqliteCoordinationRunnerStore(db);
const pause = () => {process.send!({stage:mode});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);};
let boundary = '';
const prepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function(sql: string) {
  const statement=prepare.call(this,sql),run=statement.run.bind(statement);
  statement.run=(...params:any[])=>{
    const result=run(...params);
    if(sql.startsWith('INSERT INTO pending_actions')) boundary='registration';
    if(sql.includes("SET state = 'DISPATCH_RESERVED'")) boundary='reserve';
    if(sql.startsWith('INSERT INTO execution_results')) boundary='result';
    if(sql.startsWith('UPDATE execution_ledger SET state = ?')&&params[0]==='FINALIZED') boundary='finalize';
    if((mode==='registration-before'&&boundary==='registration')||(mode==='reserve-before'&&boundary==='reserve')
      ||(mode==='result-before'&&boundary==='result')||(mode==='finalize-before'&&boundary==='finalize')
      ||(mode==='evidence-before'&&sql.startsWith('INSERT INTO runner_evidence'))) pause();
    return result;
  };
  return statement;
};
const exec=DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec=function(sql:string){
  exec.call(this,sql);
  if(sql==='COMMIT') {
    if(mode===`${boundary}-after`) pause();
    boundary='';
  }
};
const executor = {id:'test',async prepare(){return record.action;},async execute(){
  // Independent external effect record, outside the coordination database transaction.
  appendFileSync(effectPath,'effect\n');
  if(mode==='external-after') pause();
  return {status:'succeeded' as const,summary:'done'};
}};
const coordinator=new DurableExecutionCoordinator(store,{get:id=>id==='test'?executor:undefined},{clock});
process.on('message',async()=>{
  try{
    if(mode.startsWith('registration-')){
      const request=registration(store);coordinator.registerAction(record,request.expected,request.sessionEvent,request.taskEvent);
    }else if(mode==='inspect'){
      const diagnostic=coordinator.inspectExecution('run','action');db.close();process.send!({done:true,diagnostic});process.disconnect();return;
    }else if(mode.startsWith('finalize-')) coordinator.finalizeResult('run',store.getSnapshot('run').tasks.task);
    else {
      const task=store.getSnapshot('run').tasks.task;
      await coordinator.dispatch('run',task);
      coordinator.finalizeResult('run',task);
    }
    db.close();process.send!({done:true});
  }catch(error){db.close();process.send!({done:true,code:(error as any).code});}
  process.disconnect();
});
process.send!({ready:true});
