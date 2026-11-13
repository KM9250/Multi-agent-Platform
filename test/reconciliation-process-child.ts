import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DurableDatabase } from '../services/coordination/durable/db.ts';

const [path, mode, boundary = '', arg = ''] = process.argv.slice(2), dir = dirname(path);
const kill = () => process.kill(process.pid, process.platform === 'win32' ? 'SIGTERM' : 'SIGKILL');
const nativeExec = DatabaseSync.prototype.exec, nativePrepare = DatabaseSync.prototype.prepare;

function migrationCrash() {
  DatabaseSync.prototype.exec = function(sql: string) {
    if (sql.includes('CREATE TABLE reconciliation_evidence')) {
      if (boundary === 'before-ddl') kill();
      const backfill = sql.indexOf('INSERT INTO model_usage_authorities');
      const trigger = sql.indexOf('CREATE TRIGGER model_usage_authority_normal');
      assert.ok(backfill > 0, 'Migration must expose a real backfill statement');
      assert.ok(trigger > backfill, 'Migration must install authority guards after validated backfill');
      if (boundary === 'after-ddl' || boundary === 'before-backfill') { nativeExec.call(this, sql.slice(0,backfill)); kill(); }
      if (boundary === 'after-backfill') { nativeExec.call(this,sql.slice(0,sql.indexOf(';',backfill)+1)); kill(); }
      const result = nativeExec.call(this,sql);
      if (boundary === 'after-triggers') kill();
      return result;
    }
    if (sql === 'COMMIT' && boundary === 'before-commit') kill();
    const result = nativeExec.call(this,sql);
    if (sql === 'COMMIT' && boundary === 'after-commit') kill();
    return result;
  };
}
if (mode === 'migration') {
  migrationCrash(); new DurableDatabase({path}).close(); throw Error(`Missing SIGKILL boundary ${boundary}`);
} else if (mode === 'migration-race') {
  process.send!({ready:true}); process.once('message', () => { try { new DurableDatabase({path}).close();process.send!({migration:'COMPLETE'}); } catch(error) { assert.equal((error as {code?:string}).code,'DATABASE_BUSY');process.send!({migration:'DATABASE_BUSY'}); } finally { process.disconnect(); } });
} else if (mode === 'migration-busy') {
  assert.throws(() => new DurableDatabase({path,busyTimeoutMs:0}),{code:'DATABASE_BUSY'}); process.exit(0);
} else if (mode === 'migration-open') {
  new DurableDatabase({path}).close(); process.exit(0);
} else if (mode === 'v9-open') {
  const baseline = mkdtempSync(join(tmpdir(),'map-v9-runtime-'));
  try {
    const archive = spawnSync('git',['archive','89d431e20cf1f6617d4095b9a8722d86fb711d1d','services','types.ts','utils','constants.ts','package.json'],{cwd:resolve('.'),maxBuffer:32*1024*1024});
    assert.equal(archive.status,0,archive.stderr.toString());
    const extract=spawnSync('tar',['-xf','-','-C',baseline],{input:archive.stdout,maxBuffer:4*1024*1024}); assert.equal(extract.status,0,extract.stderr.toString());
    symlinkSync(resolve('node_modules'),join(baseline,'node_modules'),'dir');
    const {DurableDatabase:V9Database}=await import(pathToFileURL(join(baseline,'services/coordination/durable/db.ts')).href);
    assert.throws(() => new V9Database({path}),{code:'SCHEMA_UNSUPPORTED'});
  } finally { rmSync(baseline,{recursive:true,force:true}); }
  process.exit(0);
} else if(mode==='active-dispute') {
  const {activeDispute}=await import('./reconciliation-active-process-fixture.ts');
  await activeDispute({after(){}} as never,async({f,synthetic,target,verify,before,aborts})=>{
    writeFileSync(join(dir,'private.pem'),synthetic.pair.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
    writeFileSync(join(dir,'public.pem'),synthetic.pair.publicKey.export({type:'spki',format:'pem'}),{mode:0o600});
    writeFileSync(join(dir,'state.json'),JSON.stringify({target}));writeFileSync(join(dir,'before.json'),JSON.stringify(before));
    let armed=false;
    DatabaseSync.prototype.prepare=function(sql:string){const stmt=nativePrepare.call(this,sql),run=stmt.run.bind(stmt);stmt.run=(...args:Parameters<typeof stmt.run>)=>{const result=run(...args);if(sql.startsWith('INSERT INTO reconciliation_disputes'))armed=true;return result;};return stmt;};
    DatabaseSync.prototype.exec=function(sql:string){if(armed&&sql==='COMMIT'&&boundary==='before-commit')kill();const result=nativeExec.call(this,sql);if(armed&&sql==='COMMIT'&&boundary==='after-commit')kill();return result;};
    await verify();throw Error(`Active dispute missed ${boundary}; aborts=${aborts()}`);
  },{dir,path});
  throw Error(`Missing active dispute crash ${boundary}`);
} else {
  const {reconciliationFixture,reconciliationContents,actionClaim,completeUsage}=await import('./reconciliation-fixture.ts');
  const {ModelCallLedger}=await import('../services/coordination/durable/modelCallLedger.ts');
  const {clock}=await import('./durable-execution-fixture.ts');
  const loadPair=()=>({privateKey:createPrivateKey(readFileSync(join(dir,'private.pem'))),publicKey:createPublicKey(readFileSync(join(dir,'public.pem')))});
  const reopening=['inspect','normal-late','reconcile-race','lease-race'].includes(mode);
  const fixture=reconciliationFixture({after(){}} as never,reopening?{keyPair:loadPair()}:{},{dir,path,reopen:reopening});
  const persist=(value:unknown)=>writeFileSync(join(dir,'state.json'),JSON.stringify(value));
  const saveKeys=()=>{writeFileSync(join(dir,'private.pem'),fixture.synthetic.pair.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});writeFileSync(join(dir,'public.pem'),fixture.synthetic.pair.publicKey.export({type:'spki',format:'pem'}),{mode:0o600});};
  const close=()=>{fixture.raw.close();fixture.db.close();};
  if (mode === 'inspect') {
    const state=JSON.parse(readFileSync(join(dir,'state.json'),'utf8'));
    const before=reconciliationContents(fixture.raw),target=state.target;
    const {ReconciliationReader}=await import('../services/coordination/durable/reconciliationReader.ts');
    const reader=new ReconciliationReader(fixture.db),api=fixture.api();
    const inspected={cases:0,evidence:0,bodies:0,verifications:0,planChecks:0,receipts:0,authenticationRefusals:0};
    const authenticatedRead=<T>(read:(credential:unknown)=>T):T=>{
      assert.throws(()=>read({}),{code:'RECOVERY_UNAUTHENTICATED'});inspected.authenticationRefusals++;
      return read(fixture.credential);
    };
    assert.equal(authenticatedRead(token=>reader.inspect(target,token)).executionAllowed,false);inspected.cases++;
    // Direct fixture SQL discovers committed IDs only. Candidate/body/verification
    // reads and Plan-based receipt lookups use authenticated public APIs.
    const targetArgs=[target.workflowRunId,target.targetKind,target.targetId,target.attemptId];
    const ownedIds=(table:string,column:string)=>fixture.raw.prepare(`SELECT ${column} FROM ${table} WHERE workflow_run_id=? AND target_kind=? AND target_id=? AND attempt_id=? ORDER BY rowid`).all(...targetArgs);
    for(const row of ownedIds('reconciliation_evidence','evidence_id')) {
      const evidenceId=String(row.evidence_id);
      assert.equal(authenticatedRead(token=>api.evidence.readEvidence(evidenceId,token)).evidenceId,evidenceId);inspected.evidence++;
      assert.ok(authenticatedRead(token=>api.evidence.readBody(evidenceId,token)));inspected.bodies++;
    }
    for(const row of ownedIds('reconciliation_verifications','verification_id')) {
      const verificationId=String(row.verification_id);
      assert.equal(authenticatedRead(token=>api.evidence.readVerification(verificationId,token)).verificationId,verificationId);inspected.verifications++;
    }
    for(const row of ownedIds('reconciliation_plans','plan_id')) {
      const planId=String(row.plan_id),receipt=authenticatedRead(token=>api.executor.inspectReceipt(planId,token));inspected.planChecks++;
      const committed=fixture.raw.prepare('SELECT operation_id FROM reconciliation_operations WHERE plan_id=?').get(planId);
      if(committed){assert.equal(receipt?.operationId,committed.operation_id);inspected.receipts++;}
      else assert.equal(receipt,undefined);
    }
    assert.deepEqual(reconciliationContents(fixture.raw),before);
    assert.equal(fixture.counts.action,0);assert.equal(fixture.counts.model,0);assert.equal(fixture.counts.verifier,0);
    await new Promise<void>((resolve,reject)=>process.send!({inspected},error=>error?reject(error):resolve()));close();process.exit(0);
  } else if(mode==='lease-race') {
    process.send!({ready:true});process.once('message',()=>{fixture.reacquire();process.send!({acquired:true});close();process.disconnect();});
  } else if(mode==='verify-owner') {
    saveKeys();const {target}=fixture.model(),evidence=fixture.submit(target);persist({target});
    let resolveVerifier!:()=>void;const waiting=new Promise<void>(resolve=>{resolveVerifier=resolve;});
    fixture.synthetic.hook(async(_request,result)=>{process.send!({verifying:true});await waiting;return result;});
    process.on('message',(command:string)=>{if(command==='release'){fixture.manager.release(fixture.lease);process.send!({released:true});}else if(command==='finish')resolveVerifier();});
    try {await fixture.api().evidence.verify({evidenceId:evidence.evidenceId,verifierId:fixture.synthetic.binding.verifierId},fixture.credential);process.send!({done:true,success:true});}
    catch(error){process.send!({done:true,success:false,code:(error as {code?:string}).code});}
    finally{close();process.disconnect();}
  } else if (mode === 'normal-late' || mode === 'reconcile-race') {
    const state=JSON.parse(readFileSync(join(dir,'state.json'),'utf8'));
    if(mode==='normal-late')throw Error('Normal writer must retain its original process-local lease');
    process.send!({ready:true});process.once('message',()=>{
      try {fixture.reacquire(); const p=fixture.plan(state.target,state.verificationId);fixture.authorize(p);fixture.execute(p);process.send!({success:true});}
      catch(error){process.send!({success:false,code:(error as {code?:string}).code});}
      finally{close();process.disconnect();}
    });
  } else if(mode==='race-owner') {
    saveKeys();const model=fixture.model();const verified=await fixture.verified(model.target);const p=fixture.plan(model.target,verified.verification.verificationId);fixture.authorize(p);
    persist({target:model.target,verificationId:verified.verification.verificationId,planId:p.planId,originalLedger:fixture.raw.prepare('SELECT * FROM model_call_ledger').get()});
    process.send!({ready:true});process.on('message',(command:string)=>{
      if(command==='close'){close();process.disconnect();return;}
      if(command==='release'){fixture.manager.release(fixture.lease);process.send!({released:true});return;}
      try {
        if(command==='normal')new ModelCallLedger(fixture.store,clock).settle(model.x,{...completeUsage,estimatedCost:boundary==='different'?0.0005:0.0004},true);
        else if(command==='reconcile')fixture.execute(p);
        else throw Error('Unknown race command');
        process.send!({done:true,success:true});
      }catch(error){process.send!({done:true,success:false,code:(error as {code?:string}).code});}
      if(arg!=='keep'){close();process.disconnect();}
    });
  } else {
    saveKeys();let planId:string|undefined,verificationId:string|undefined;
    const target=mode==='usage'||mode==='normal-conflict'||mode==='candidate'||mode==='verification'||mode==='plan'||mode==='grant'?fixture.model().target:fixture.action().target;
    let evidence:ReturnType<typeof fixture.submit>|undefined;
    if(mode!=='candidate')evidence=fixture.submit(target,undefined,mode==='expired-apply'?{expiresAt:Date.now()+1000}:undefined);
    if(!['candidate','verification'].includes(mode))verificationId=(await fixture.api().evidence.verify({evidenceId:evidence!.evidenceId,verifierId:fixture.synthetic.binding.verifierId},fixture.credential)).verificationId;
    if(!['candidate','verification','plan'].includes(mode)){
      const p=fixture.plan(target,verificationId!);planId=p.planId;
      if(mode!=='grant')fixture.authorize(p);
      if(mode==='apply'||mode==='expired-apply'||mode==='dispute') {
        fixture.execute(p);
        if(mode==='apply'||mode==='expired-apply'){if(mode==='expired-apply'){const expires=Number(fixture.raw.prepare('SELECT expires_at FROM reconciliation_verifications WHERE verification_id=?').get(verificationId)!.expires_at);await new Promise(resolve=>setTimeout(resolve,Math.max(0,expires-Date.now())+30));}const apply=fixture.plan(target,verificationId!,'APPLY_RECONCILED_ACTION_RESULT');fixture.authorize(apply);planId=apply.planId;}
        else evidence=fixture.submit(target,actionClaim('NOT_EXECUTED_FINAL'));
      }
    }
    persist({target,planId,verificationId,evidenceId:evidence?.evidenceId});
    writeFileSync(join(dir,'before.json'),JSON.stringify(reconciliationContents(fixture.raw)));
    const tableByMode:Record<string,string>={candidate:'reconciliation_evidence',verification:'reconciliation_verifications',plan:'reconciliation_plans',grant:'reconciliation_grants',usage:'reconciled_model_usages',outcome:'reconciled_action_outcomes',apply:'reconciled_action_applications','expired-apply':'reconciled_action_applications','normal-conflict':'reconciliation_disputes',dispute:'reconciliation_disputes'};
    const selected=tableByMode[mode];assert.ok(selected,`Unknown mode ${mode}`);let armed=false;
    DatabaseSync.prototype.prepare=function(sql:string){const statement=nativePrepare.call(this,sql),run=statement.run.bind(statement);statement.run=(...args:Parameters<typeof statement.run>)=>{const result=run(...args);if(new RegExp(`^INSERT INTO ${selected}\\b`,'i').test(sql.trim()))armed=true;return result;};return statement;};
    DatabaseSync.prototype.exec=function(sql:string){if(armed&&sql==='COMMIT'&&boundary==='before-commit')kill();const result=nativeExec.call(this,sql);if(armed&&sql==='COMMIT'&&boundary==='after-commit')kill();return result;};
    if(mode==='candidate')fixture.submit(target);
    else if(mode==='verification'||mode==='dispute')await fixture.api().evidence.verify({evidenceId:evidence!.evidenceId,verifierId:fixture.synthetic.binding.verifierId},fixture.credential);
    else if(mode==='plan'){const p=fixture.plan(target,verificationId!);planId=p.planId;}
    else if(mode==='grant'){const p=fixture.raw.prepare('SELECT plan_json FROM reconciliation_plans WHERE plan_id=?').get(planId);fixture.authorize(JSON.parse(String(p!.plan_json)));}
    else if(mode==='normal-conflict')new ModelCallLedger(fixture.store,clock).settle({workflowRunId:target.workflowRunId,modelCallId:target.targetId,attemptId:target.attemptId,providerId:'test',modelId:'test'},{...completeUsage,estimatedCost:0.0005},false);
    else fixture.api().executor.executeAuthorized(planId!,fixture.credential);
    throw Error(`Missing reconciliation SIGKILL ${mode}/${boundary}`);
  }
}
