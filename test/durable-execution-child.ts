// Test-only fault injection through the actual SQLite driver. No production crash hooks.
import { DatabaseSync } from 'node:sqlite';
import { appendFileSync } from 'node:fs';
import { DurableDatabase, SqliteCoordinationRunnerStore, DurableExecutionCoordinator, createDurableCoordinationRunner, createRuntimeLeaseManager } from '../services/coordination/durable/index.ts';
import { createRunnerEvent } from '../services/coordination/runner/eventFactory.ts';
import { registration, record, clock, model } from './durable-execution-fixture.ts';
const [path, mode, effectPath] = process.argv.slice(2);
const db = new DurableDatabase({path}); let store = new SqliteCoordinationRunnerStore(db);
const manager = createRuntimeLeaseManager(db, { ttlMs: 1000 });
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
    if(sql.startsWith('INSERT INTO journal_events')&&params[3]==='WorkflowBlocked'&&mode.startsWith('uncertain-atomic-')) boundary='uncertain-atomic';
    if(sql.startsWith('UPDATE execution_ledger SET state = ?')&&params[0]==='FINALIZED') boundary='finalize';
    if((mode==='registration-before'&&boundary==='registration')||(mode==='reserve-before'&&boundary==='reserve')
      ||(mode==='result-before'&&boundary==='result')||(mode==='finalize-before'&&boundary==='finalize')
      ||(mode==='evidence-before'&&sql.startsWith('INSERT INTO runner_evidence'))
      ||(mode==='uncertain-atomic-before'&&boundary==='uncertain-atomic')) pause();
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
  return {status:mode.startsWith('uncertain-')?'uncertain' as const:'succeeded' as const,summary:'done'};
}};
let coordinator: DurableExecutionCoordinator;
process.on('message',async()=>{
  try{
    let outcome;
    if (mode !== 'inspect') store = store.withLease(manager.acquire('run'));
    coordinator = new DurableExecutionCoordinator(store,{get:id=>id==='test'?executor:undefined},{clock});
    if(mode.startsWith('uncertain-legacy-')){
      const task=store.getSnapshot('run').tasks.task;
      await coordinator.dispatch('run',task);coordinator.finalizeResult('run',task);
      if(mode==='uncertain-legacy-task')pause();
      const append=(type: 'SessionResolved' | 'ProgressRecorded',payload:unknown,key:string,sessionId?:string)=>
        store.append(createRunnerEvent(store.getSnapshot('run'),type,payload,clock,
          {nextId:()=>`legacy-${type}`},{sessionId,idempotencyKey:key}));
      append('SessionResolved',{outcome:'FAILED'},'runner:run:round:resolve','session');
      if(mode==='uncertain-legacy-session')pause();
      append('ProgressRecorded',{outcome:'ERROR',summary:'Runner round error.'},'runner:run:round:progress');
      pause();
    }else if(mode==='uncertain-recover'||mode.startsWith('uncertain-atomic-')){
      const runner=createDurableCoordinationRunner({coordinator,clock,supervisorProvider:{
        async plan(){appendFileSync(effectPath+'.plan','plan\n');return model({kind:'needs_user',reason:'Unexpected PLAN'});},
        async verify(){appendFileSync(effectPath+'.verify','verify\n');return model({taskOutcome:'FAIL',summary:'Unexpected VERIFY',criteria:[]});},
      }});
      const result=await runner.runUntilStop('run');outcome={reason:result.reason,errorCode:result.errorCode,roundsCompleted:result.roundsCompleted};
    }else if(mode.startsWith('registration-')){
      const request=registration(store);coordinator.registerAction(record,request.expected,request.sessionEvent,request.taskEvent);
    }else if(mode==='inspect'){
      const diagnostic=coordinator.inspectExecution('run','action');db.close();process.send!({done:true,diagnostic});process.disconnect();return;
    }else if(mode.startsWith('finalize-')) coordinator.finalizeResult('run',store.getSnapshot('run').tasks.task);
    else {
      const task=store.getSnapshot('run').tasks.task;
      await coordinator.dispatch('run',task);
      coordinator.finalizeResult('run',task);
    }
    if (store.lease) manager.release(store.lease);
    db.close();process.send!({done:true,outcome});
  }catch(error){if(store.lease){try{manager.release(store.lease);}catch{}} db.close();process.send!({done:true,code:(error as any).code});}
  process.disconnect();
});
process.send!({ready:true});
