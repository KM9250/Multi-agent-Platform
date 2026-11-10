import type { DurableDatabase } from './db';
import type { WorkflowLease } from './runtimeLease';
import type { ControlledGrant, ControlledGrantScope, ControlledPlan, ControlledPlanInput, DispatchInspection } from './controlledRecoveryTypes';
import type { RunnerActionExecutor, RunnerExecutionContext, RunnerExecutionResult, PreparedRunnerAction } from '../runner/types';
import { validateRunnerExecution } from '../runner/model';
import { parseSecurityReviewRef } from '../runner/securityHold';
import { EXECUTION_LIMITS, executionJson, rejectEmbeddedCredentials } from './executionIntegrity';
import { jsonCopy } from './integrity';

export { controlledScopeOf } from './recoveryDispatchStore';
export { CONTROLLED_RECOVERY_CONTRACT } from './controlledRecoveryTypes';
export class ControlledRecoveryPlanner {
  constructor(readonly database:DurableDatabase,readonly lease?:WorkflowLease){}
  preview(workflowRunId:string){return this.database.previewControlledDispatch(workflowRunId);}
  createPlan(input:ControlledPlanInput,credential:unknown):ControlledPlan{
    return this.database.controlledRecoveryDecision(this.lease,credential,{kind:'CREATE_PLAN',input}) as ControlledPlan;
  }
}
export class ControlledRecoveryAuthorizer {
  constructor(readonly database:DurableDatabase,readonly lease?:WorkflowLease){}
  authorize(planId:string,scope:ControlledGrantScope,credential:unknown,ttlMs?:number):ControlledGrant{
    return this.database.controlledRecoveryDecision(this.lease,credential,{kind:'AUTHORIZE',planId,scope,ttlMs}) as ControlledGrant;
  }
  revoke(authorizationId:string,credential:unknown):ControlledGrant{
    return this.database.controlledRecoveryDecision(this.lease,credential,{kind:'REVOKE',authorizationId}) as ControlledGrant;
  }
}
export class RecoveryDispatchCoordinator {
  constructor(readonly database:DurableDatabase,readonly lease?:WorkflowLease){}
  executeAuthorized(planId:string,credential:unknown,options:{signal?:AbortSignal}={}):Promise<DispatchInspection>{
    return this.database.executeControlledDispatch(this.lease,planId,credential,options.signal);
  }
}
export const unknownDispatchResult=(errorCode:string):RunnerExecutionResult=>({status:'uncertain',summary:'Controlled execution requires review.',errorCode});
/** Process-local monotonic execution window; never exposed to the executor or persisted. */
export interface ControlledExecutionWindow { deadline?:number }
/** No database or permit is accepted. Called only after the private send permit is consumed. */
export async function collectControlledResult(execute:RunnerActionExecutor['execute'],action:PreparedRunnerAction,
  context:RunnerExecutionContext,timeoutMs:number,execution:ControlledExecutionWindow):Promise<RunnerExecutionResult>{
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  let stopped:RunnerExecutionResult|undefined,stop!:(result:RunnerExecutionResult)=>void;
  const interruption=new Promise<RunnerExecutionResult>(resolve=>{stop=resolve;});
  const halt=(reason:string)=>{if(stopped)return;stopped=unknownDispatchResult(reason);stop(stopped);controller.abort();};
  const checkDeadline=()=>{
    if(execution.deadline!==undefined && performance.now()>=execution.deadline)halt('RUNNER_EXECUTION_TIMEOUT');
    return stopped;
  };
  const abort=()=>halt('RUNNER_EXECUTION_ABORTED');
  context.signal?.addEventListener('abort',abort,{once:true});
  try{
    if(context.signal?.aborted)return unknownDispatchResult('RUNNER_DISPATCH_NOT_STARTED');
    // This invocation occurs synchronously, before this function's first await.
    let pending:Promise<RunnerExecutionResult>;
    try{
      const prepared=jsonCopy(action),executionContext={...context,signal:controller.signal};
      execution.deadline=performance.now()+timeoutMs;
      timer=setTimeout(()=>halt('RUNNER_EXECUTION_TIMEOUT'),timeoutMs);
      pending=Promise.resolve(execute(prepared,executionContext));
    }
    catch{return checkDeadline()??unknownDispatchResult('RUNNER_EXECUTOR_OUTCOME_UNKNOWN');}
    const outcome=pending.then(raw=>{
      const interrupted=checkDeadline();if(interrupted)return interrupted;
      try{
        executionJson(raw,EXECUTION_LIMITS.result);rejectEmbeddedCredentials(raw);
        const result=jsonCopy(validateRunnerExecution(raw));
        delete result.errorDetail; // Never persist raw adapter exception text.
        if(result.status==='aborted')return unknownDispatchResult('RUNNER_EXECUTION_ABORTED');
        if(result.safetyHold){const owner=parseSecurityReviewRef(result.safetyHold.reviewRef);
          if(owner?.workflowRunId!==context.workflowRunId || owner.taskId!==context.taskId || !['succeeded','failed'].includes(result.status))return unknownDispatchResult('RUNNER_SECURITY_REVIEW_OWNER_INVALID');}
        return checkDeadline()??result;
      }catch{return checkDeadline()??unknownDispatchResult('RUNNER_INVALID_EXECUTION_RESULT');}
    },()=>checkDeadline()??unknownDispatchResult('RUNNER_EXECUTOR_OUTCOME_UNKNOWN'));
    const result=await Promise.race([outcome,interruption]);
    return checkDeadline()??result;
  }finally{if(timer)clearTimeout(timer);context.signal?.removeEventListener('abort',abort);}
}
