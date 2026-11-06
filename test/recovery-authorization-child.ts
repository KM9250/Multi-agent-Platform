import { DatabaseSync } from 'node:sqlite';
import { DurableDatabase, SqliteCoordinationRunnerStore, RecoveryPlanner, RecoveryAuthorizer } from '../services/coordination/durable/index.ts';
import { scopeOf } from '../services/coordination/durable/recoveryDecisionStore.ts';
import { executionSeed } from './durable-execution-fixture.ts';
import { testIdentityProvider } from './recovery-authorization-fixture.ts';
const [path,operation,boundary]=process.argv.slice(2);
const exec=DatabaseSync.prototype.exec;
let armed=operation==='migration';
DatabaseSync.prototype.exec=function(sql:string){
  if(armed && sql==='COMMIT' && boundary==='before') process.kill(process.pid,'SIGKILL');
  const result=exec.call(this,sql);
  if(armed && sql==='COMMIT' && boundary==='after') process.kill(process.pid,'SIGKILL');
  return result;
};
const identity=testIdentityProvider(),credential=identity.credential();
const db=new DurableDatabase({path,recoveryIdentityVerifier:identity.verifier});
if(operation==='migration') throw Error('Did not terminate at migration COMMIT');
if(operation==='takeover') {armed=true;db.createLeaseManager().acquire('run');throw Error('Did not terminate at takeover COMMIT');}
const admin=new SqliteCoordinationRunnerStore(db);admin.createWorkflow(executionSeed());
const lease=db.createLeaseManager({ttlMs:10000}).acquire('run'),planner=new RecoveryPlanner(db,lease),authorizer=new RecoveryAuthorizer(db,lease);
const create=()=>planner.createPlan({workflowRunId:'run',operationKind:'BOUNDED_CONTINUATION',targetId:'run'},credential);
const p=operation==='plan'?undefined:create();
const authorize=()=>authorizer.authorize(p!.recoveryPlanId,scopeOf(p!),credential);
const a=operation==='revoke'?authorize():undefined;
armed=true;
if(operation==='plan')create();else if(operation==='authorize')authorize();else authorizer.revoke(a!.authorizationId,credential);
throw Error('Did not terminate at decision COMMIT');
