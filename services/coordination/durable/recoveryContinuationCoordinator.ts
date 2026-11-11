import { assertControlledBudget } from './controlledRecoveryPlanner';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { DurableDatabase, DurableTransaction, Row } from './db';
import type { WorkflowLease } from './runtimeLease';
import type { RecoveryIdentityVerifier, VerifiedRecoveryIdentity } from './recoveryDecisionTypes';
import type { ContinuationCommand, ContinuationPlan, ContinuationPlanInput, ContinuationPolicy, ContinuationInspection,
  BoundedProviderRegistry, BoundedProvider, InvocationTiming, PlanArtifact, ArtifactRef, PlanningProviderRequest, PlanningProviderResponse, InputSnapshot, PlanningInputRequest } from './continuationTypes';
import { BOUNDED_CONTRACT } from './continuationTypes';
import { verifyRecoveryIdentity } from './recoveryAuthorization';
import { boundedTiming, validateContinuationInput, planBinding, readContinuationPlan, executionState, artifactBasis, validateProvider, assertArtifactReferences, continuationPolicyBinding } from './recoveryContinuationPlanner';
import { canonicalJson, digest, DurableStoreError, jsonCopy, requireIntegrity } from './integrity';
import { recoveryTime } from './recoveryPlanner';
import { readWorkflowControl } from './recoveryHoldLifecycle';
import { readJournal } from './restore';
import { SqliteCoordinationRunnerStore } from './durableCoordinationStore';
import { readArtifact, readPlanningInputRequest, readPlanningReviewTarget, validateDraft, assertPlanningTextSafe } from './planningArtifactStore';
import type { PlanningReadRegistry } from './planningReadRegistry';
import { ModelCallLedger, modelBudgetPosition } from './modelCallLedger';
import type { ModelCallIdentity } from './modelCallLedger';
import { addAmounts, usageAmounts, zeroAmounts } from './modelBudgetGuard';
import { createRunnerEvent } from '../runner/eventFactory';
import { executionJson, rejectEmbeddedCredentials } from './executionIntegrity';
import { collectBoundedResponse } from './planningCoordinator';
import { runBoundedRunner } from './boundedRunner';
import { appendEvent } from '../kernel';
import { runnerActionApproved, runnerEvidenceReviewReason, runnerSecurityReviewReason } from '../runner/dispatchGuard';
import { effectiveModelRows } from './safeRecoveryModelState';

export interface BoundedRuntimeOptions {
  policy?: ContinuationPolicy; providers?: BoundedProviderRegistry; reads?: PlanningReadRegistry;
  timing?: Partial<InvocationTiming>;
}
interface Context {
  plan: ContinuationPlan; invocationId: string; lease: WorkflowLease; actor: VerifiedRecoveryIdentity;
  phase: 'RUNNER'|'MODEL'|'APPLICATION'|'READ'|'FINISH'|'EVIDENCE'; callId?: string; roundKey?: string; roundStepId?:string;
  valid: boolean; abort: AbortController;
  planningRequest?: Omit<PlanningProviderRequest,'signal'>;
}
/** The payload's references are also the provenance displayed with its output. */
function planningSnapshots(request:Omit<PlanningProviderRequest,'signal'>):InputSnapshot[] {
  return [...request.references,...request.reads.map(r=>({id:r.resourceId,digest:r.digest,revision:r.revision,observedAt:r.observedAt}))];
}
interface Host {
  db: DurableDatabase; verifier?: RecoveryIdentityVerifier;
  executorBinding(input:ContinuationPlanInput):unknown;
  write<T>(lease:WorkflowLease,fn:(tx:DurableTransaction)=>T):T;
}
/** Constructed only inside DurableDatabase. No authority-bearing method accepts caller SQL/callbacks. */
export class BoundedRuntime {
  readonly #host:Host; readonly #options:BoundedRuntimeOptions; readonly #timing:InvocationTiming;
  readonly #contexts=new AsyncLocalStorage<Context|undefined>();
  #management=false; #tx?:DurableTransaction; #inTransaction?:Context; #resume=false;
  readonly #observed=new Map<string,{provider:BoundedProvider;draft:unknown;runner:unknown;plan:unknown;verify:unknown}>();
  readonly #active=new Map<string,Context>();
  readonly #evidence=new AsyncLocalStorage<{context:Context;owner:import('./evidenceStore').EvidenceOwner;deadline:number;valid:boolean}>();
  constructor(host:Host,options:BoundedRuntimeOptions={}) {
    this.#host=host;this.#options=options;this.#timing=boundedTiming(options.timing);
    const p=options.policy;
    if(p) {
      requireIntegrity(p.version&&Array.isArray(p.planningRoles)&&typeof p.canAccess==='function'&&typeof p.canSend==='function'&&typeof p.inspectContent==='function');
      for(const q of [p.recoveryApprovals,p.releaseApprovals])requireIntegrity(Number.isSafeInteger(q.minimumApprovers)&&q.minimumApprovers>=1&&q.minimumApprovers<=100&&typeof q.forbidSelfApproval==='boolean');
    }
  }
  get protecting():boolean {return this.#management||this.active;}
  get active():boolean {return !!this.#contexts.getStore()?.valid;}
  withoutAuthority<T>(fn:()=>T):T {return this.#contexts.run(undefined,fn);}
  #policy():ContinuationPolicy {const p=this.#options.policy;if(!p)throw new DurableStoreError('RECOVERY_UNAUTHORIZED');return p;}
  #identity(tx:DurableTransaction,credential:unknown,id:string,operation:'VIEW'|'PLAN'|'EXECUTE'='PLAN',approval=false):VerifiedRecoveryIdentity {
    const who=verifyRecoveryIdentity(this.#host.verifier,credential,recoveryTime(tx),approval?'AUTHORIZE':'VIEW');
    requireIntegrity(this.#policy().canAccess(who,id,operation));return who;
  }
  #provider(p:ContinuationPlanInput):BoundedProvider|undefined {
    if(p.operation==='RELEASE_RECOVERY_HOLD')return;
    const b=this.withoutAuthority(()=>this.#options.providers?.get(p.providerId!,p.modelId!));validateProvider(b,p);
    const key=digest(b!.capabilities),old=this.#observed.get(key);
    requireIntegrity(!old||old.provider===b&&old.draft===b!.draftPlan&&old.runner===b!.runner&&old.plan===b!.runner?.plan&&old.verify===b!.runner?.verify);
    this.#observed.set(key,{provider:b!,draft:b!.draftPlan,runner:b!.runner,plan:b!.runner?.plan,verify:b!.runner?.verify});return b;
  }
  #write<T>(lease:WorkflowLease,fn:(tx:DurableTransaction)=>T):T {
    requireIntegrity(!this.#management);this.#management=true;
    try{return this.#host.write(lease,fn);}finally{this.#management=false;this.#resume=false;}
  }
  before(tx:DurableTransaction,id:string):void {
    const c=this.#contexts.getStore();this.#tx=tx;this.#inTransaction=c;
    if(!c)return;
    requireIntegrity(c.valid&&c.plan.workflowRunId===id);
    const row=tx.get('SELECT * FROM recovery_invocations WHERE invocation_id=?',c.invocationId);
    requireIntegrity(row&&row.generation===c.lease.generation&&row.runtime_instance_id===c.lease.runtimeInstanceId);
    if(!['ACTIVE','DRAINING'].includes(String(row.status)))throw new DurableStoreError('CONTINUATION_STATE_CHANGED');
    if(c.phase!=='FINISH'&&recoveryTime(tx)>=Number(row.collection_deadline))throw new DurableStoreError('CONTINUATION_EXPIRED');
    if(row.expected_state!==executionState(tx,id))throw new DurableStoreError('CONTINUATION_STATE_CHANGED');
    requireIntegrity(readWorkflowControl(tx,id).active_invocation_id===c.invocationId);
  }
  after(tx:DurableTransaction):void {
    const c=this.#inTransaction;if(!c)return;
    const row=tx.get('SELECT status FROM recovery_invocations WHERE invocation_id=?',c.invocationId);
    if(row&&['ACTIVE','DRAINING'].includes(String(row.status)))tx.run('UPDATE recovery_invocations SET expected_state=?,revision=revision+1 WHERE invocation_id=?',executionState(tx,c.plan.workflowRunId),c.invocationId);
  }
  clear():void{this.#tx=undefined;this.#inTransaction=undefined;}
  allows(workflow:unknown,table:unknown,op:unknown,target?:unknown,detail?:unknown):boolean {
    if(!this.#tx||typeof workflow!=='string'||typeof table!=='string')return false;
    if(this.#management) {
      if(table==='resume')return this.#resume;
      return table.startsWith('recovery_continuation_')||['recovery_invocations','recovery_hold_lifecycle','planning_reviews','bounded_audit'].includes(table)
        || this.#resume&&['journal_events','workflow_seeds'].includes(table);
    }
    const c=this.#inTransaction;
    if(!c?.valid||c.plan.workflowRunId!==workflow)return false;
    if(table==='resume')return false;
    if(c.phase==='FINISH')return ['recovery_invocations','recovery_continuation_receipts','recovery_hold_lifecycle','bounded_audit'].includes(table);
    if(c.phase==='EVIDENCE')return ['runner_evidence','recovery_invocations','bounded_audit'].includes(table);
    if(['recovery_invocations','recovery_invocation_steps','recovery_invocation_debits','recovery_model_lineage','bounded_audit','recovery_continuation_receipts','recovery_hold_lifecycle'].includes(table))return true;
    if(['model_call_ledger','model_call_attempts','workflow_seeds'].includes(table))return true;
    if(table==='journal_events')return true; // Exact event and target validation is in the additional event guard.
    if(table==='planning_application')return c.plan.operation==='PLANNING_ONLY'&&c.phase==='APPLICATION';
    if(['planning_artifacts','planning_input_requests','planning_reviews'].includes(table))return c.plan.operation==='PLANNING_ONLY'&&c.phase==='APPLICATION';
    if(table==='planning_read_calls')return c.plan.mode==='PLAN_READ_ONLY'&&c.phase==='READ';
    return c.plan.operation==='BOUNDED_CONTINUATION'&&c.phase==='RUNNER'
      &&['pending_actions','execution_ledger','execution_results','runner_evidence'].includes(table);
  }
  eventAllowed(workflow:unknown,eventType:unknown,payload:unknown):boolean {
    const c=this.#inTransaction;
    if(this.#management)return this.#resume&&eventType==='WorkflowResumed';
    if(!c?.valid||c.plan.workflowRunId!==workflow)return false;
    if(eventType==='UsageRecorded')return true;
    if(!this.#policy().canAccess(c.actor,c.plan.workflowRunId,'EXECUTE')||digest(continuationPolicyBinding(this.#policy()))!==digest(c.plan.binding.policy))return false;
    if(c.plan.operation==='PLANNING_ONLY')return c.phase==='APPLICATION'&&['PlanArtifactPublished','PlanningReadRequested','PlanningInputRequested'].includes(String(eventType));
    return c.phase==='RUNNER'&&!['WorkflowRunCreated','WorkflowResumed','PlanArtifactPublished','PlanningReadRequested','PlanningInputRequested'].includes(String(eventType));
  }
  startAllowed(tx:DurableTransaction,id:string,route:string):boolean {
    const c=this.#contexts.getStore();if(!c?.valid||c.plan.workflowRunId!==id)return false;
    const i=tx.get('SELECT * FROM recovery_invocations WHERE invocation_id=?',c.invocationId);
    if(!i||i.status!=='ACTIVE'||recoveryTime(tx)>=Number(i.admission_deadline))return false;
    if(route==='REGISTER')return c.plan.operation==='BOUNDED_CONTINUATION'&&c.plan.start!=='VERIFY_FINALIZED_RESULT';
    if(route==='ACTION')return c.plan.operation==='BOUNDED_CONTINUATION'&&c.plan.start!=='VERIFY_FINALIZED_RESULT';
    return route==='MODEL'||route==='RUNNER';
  }
  businessApplicationAllowed(tx:DurableTransaction,id:string,callId:string):boolean {
    const c=this.#contexts.getStore();
    return !!c?.valid && c.plan.operation==='BOUNDED_CONTINUATION' && c.plan.workflowRunId===id && c.callId===callId&&this.#policy().canAccess(c.actor,id,'EXECUTE')&&digest(continuationPolicyBinding(this.#policy()))===digest(c.plan.binding.policy);
  }
  validateAction(action:import('../runner/types').PreparedRunnerAction):void {
    const c=this.#contexts.getStore();if(!c)return;
    requireIntegrity(c.valid&&c.plan.operation==='BOUNDED_CONTINUATION'&&c.plan.actions?.some(r=>r.executorId===action.executorId&&r.operation===action.operation&&r.actionClass===action.actionClass&&r.payloadDigest===digest(action.payload)));
    requireIntegrity(digest(this.withoutAuthority(()=>this.#host.executorBinding(c.plan)))===digest(c.plan.binding.executors));
    const check=(tx:DurableTransaction)=>{requireIntegrity(this.#policy().canAccess(c.actor,c.plan.workflowRunId,'EXECUTE'));assertArtifactReferences(tx,c.plan,this.#policy(),this.#options.reads);const owned=tx.get("SELECT step_id FROM recovery_invocation_steps WHERE invocation_id=? AND kind='ACTION' AND target_id=?",c.invocationId,action.actionId);
      if(!owned&&Number(tx.get("SELECT count(*) n FROM recovery_invocation_debits WHERE invocation_id=? AND kind='ACTION'",c.invocationId)!.n)>=c.plan.limits.maxActionDispatches)throw new DurableStoreError('CONTINUATION_LIMIT');};
    if(this.#tx)check(this.#tx);else this.#host.db.read(check);
  }
  async executeAction(execute:import('../runner/types').RunnerActionExecutor['execute'],action:import('../runner/types').PreparedRunnerAction,context:import('../runner/types').RunnerExecutionContext) {
    const c=this.#contexts.getStore();requireIntegrity(c?.valid&&c.plan.operation==='BOUNDED_CONTINUATION');
    this.validateAction(action);this.dispatchDeadline('ACTION',action.actionId);
    const row=this.#host.db.read(tx=>tx.get("SELECT * FROM recovery_invocation_steps WHERE invocation_id=? AND kind='ACTION' AND target_id=?",c.invocationId,action.actionId));requireIntegrity(row);
    const remaining=Math.max(1,Number(row.execution_deadline)-this.#host.db.read(recoveryTime));
    const sink={context:c,owner:{workflowRunId:context.workflowRunId,sessionId:context.sessionId,taskId:context.taskId,actionId:action.actionId},deadline:performance.now()+remaining,valid:true};
    let value;
    try {value=await collectBoundedResponse(signal=>this.#evidence.run(sink,()=>this.withoutAuthority(async()=>jsonCopy(await execute(action,{...context,signal})))),remaining,c.plan.timing.collectionGraceMs,context.signal);}
    finally {sink.valid=false;}
    if(value.timedOut||value.aborted||!value.value)return {status:'uncertain' as const,summary:'Bounded action outcome is unknown.',errorCode:'RUNNER_EXECUTOR_OUTCOME_UNKNOWN'};
    return value.value;
  }
  collectModel<T>(invoke:()=>Promise<T>,signal?:AbortSignal) {
    const c=this.#contexts.getStore();requireIntegrity(c?.valid);
    const remaining=this.dispatchDeadline('MODEL',c.callId!);
    return collectBoundedResponse(()=>this.withoutAuthority(async()=>{try{return jsonCopy(await invoke());}catch(error){throw jsonCopy(error??{});}}),remaining,c.plan.timing.collectionGraceMs,signal);
  }
  dispatchDeadline(kind:'MODEL'|'ACTION'|'READ',target:string):number {
    const c=this.#contexts.getStore();requireIntegrity(c?.valid&&!c.abort.signal.aborted);
    requireIntegrity(this.#policy().canAccess(c.actor,c.plan.workflowRunId,'EXECUTE'));
    this.#checkData(c.actor,c.plan,kind==='MODEL'?c.planningRequest:undefined);requireIntegrity(digest(continuationPolicyBinding(this.#policy()))===digest(c.plan.binding.policy));
    if(c.plan.operation!=='RELEASE_RECOVERY_HOLD')requireIntegrity(digest(validateProvider(this.#provider(c.plan),c.plan))===digest(c.plan.binding.provider));
    return this.#host.db.read(tx=>{
      const i=tx.get('SELECT * FROM recovery_invocations WHERE invocation_id=?',c.invocationId);
      const step=tx.get('SELECT * FROM recovery_invocation_steps WHERE invocation_id=? AND kind=? AND target_id=?',c.invocationId,kind,target);
      requireIntegrity(i&&step&&i.status==='ACTIVE'&&i.expected_state===executionState(tx,c.plan.workflowRunId));
      assertArtifactReferences(tx,c.plan,this.#policy(),this.#options.reads);
      const now=recoveryTime(tx);
      if(now>=Number(i.admission_deadline)||now>=Number(step.execution_deadline))throw new DurableStoreError('CONTINUATION_EXPIRED');
      return Number(step.execution_deadline)-now;
    });
  }
  putEvidence(owner:import('./evidenceStore').EvidenceOwner,evidence:import('../runner/types').RunnerEvidence):string|undefined {
    const sink=this.#evidence.getStore();if(!sink)return;
    requireIntegrity(sink.valid&&sink.context.valid&&canonicalJson(owner)===canonicalJson(sink.owner)&&performance.now()<sink.deadline);
    const json=executionJson(evidence,1024*1024);rejectEmbeddedCredentials(evidence);
    requireIntegrity(typeof evidence.kind==='string'&&!!evidence.kind.trim()&&Number.isFinite(evidence.createdAt)&&evidence.createdAt>=0);
    const ref=`map.runner.evidence.v1:${randomUUID()}`;
    return this.#contexts.run({...sink.context,phase:'EVIDENCE'},()=>this.#host.write(sink.context.lease,tx=>{
      requireIntegrity(performance.now()<sink.deadline);
      const r=tx.get('SELECT * FROM execution_ledger WHERE workflow_run_id=? AND action_id=?',owner.workflowRunId,owner.actionId);
      requireIntegrity(r&&r.state==='DISPATCH_RESERVED'&&r.session_id===owner.sessionId&&r.task_id===owner.taskId);
      const previous=tx.all('SELECT length(CAST(content_json AS BLOB)) AS n FROM runner_evidence WHERE workflow_run_id=? AND action_id=?',owner.workflowRunId,owner.actionId);
      requireIntegrity(previous.length<15&&previous.reduce((n,r)=>n+Number(r.n),0)+Buffer.byteLength(json)<=768*1024);
      tx.run('INSERT INTO runner_evidence VALUES(?,?,?,?,?,?,?,?,?,1)',ref,owner.workflowRunId,owner.sessionId,owner.taskId,owner.actionId,evidence.kind,json,digest(evidence),evidence.createdAt);
      requireIntegrity(performance.now()<sink.deadline);return ref;
    }));
  }
  #lifecycle(tx:DurableTransaction,id:string,change:{hold?:string;active?:string|null;review?:boolean},reason:string,generation:number,expectedRevision?:number):void {
    const c=readWorkflowControl(tx,id);
    requireIntegrity(expectedRevision===undefined||c.control_revision===expectedRevision);
    tx.run('INSERT INTO recovery_hold_lifecycle VALUES(NULL,?,?,?,?,?,?,?,?,?)',id,c.hold_epoch,Number(c.control_revision)+1,
      change.hold??c.hold_state,change.active===undefined?c.active_invocation_id:change.active,change.review===undefined?c.planning_review_pending:change.review?1:0,reason,generation,recoveryTime(tx));
  }
  #receipt(tx:DurableTransaction,p:ContinuationPlan,kind:'START'|'FINISH'|'RELEASE'|'STOP',body:unknown):void {
    tx.run('INSERT INTO recovery_continuation_receipts VALUES(?,?,?,?,?,?)',randomUUID(),p.workflowRunId,p.planId,kind,canonicalJson(body),digest(body));
  }
  #checkData(who:VerifiedRecoveryIdentity,p:ContinuationPlanInput,request?:Omit<PlanningProviderRequest,'signal'>):void {
    const policy=this.#policy();
    if(p.input){
      for(const text of request?[request.input,...request.reads.map(r=>r.text)]:[p.input.text]){assertPlanningTextSafe(text);requireIntegrity(policy.inspectContent(text,p.input.dataClass));}
      for(const s of request?planningSnapshots(request):p.input.snapshots)requireIntegrity(policy.canSend(who,s,p.input.destination,p.input.dataClass)&&(!s.sourceWorkflowId||s.sourceWorkflowId!==p.workflowRunId&&policy.canAccess(who,s.sourceWorkflowId,'VIEW')));
    }
  }
  preview(input:ContinuationPlanInput,credential:unknown) {
    return this.#host.db.read(tx=>{
      const x=validateContinuationInput(input),who=this.#identity(tx,credential,x.workflowRunId);this.#checkData(who,x);
      try {planBinding(this.#host.db,tx,x,this.#policy(),this.#provider(x),this.#options.reads,this.#timing);return {eligible:true,reason:null,executionAllowed:false as const};}
      catch(error){if(!(error instanceof DurableStoreError))throw error;return {eligible:false,reason:error.code,executionAllowed:false as const};}
    });
  }
  command(lease:WorkflowLease|undefined,credential:unknown,input:ContinuationCommand):unknown {
    const command=jsonCopy(input);
    if(command.kind==='INSPECT')return this.#host.db.read(tx=>this.#inspect(tx,command.planId,credential));
    if(!lease)throw new DurableStoreError('LEASE_FENCED');
    if(command.kind==='STOP')return this.#stop(lease,command.planId,credential);
    return this.#write(lease,tx=>{
      const who=this.#identity(tx,credential,lease.workflowRunId,'PLAN',command.kind==='AUTHORIZE'||command.kind==='REVOKE');
      if(command.kind==='CREATE_PLAN') {
        const x=validateContinuationInput(command.input);requireIntegrity(x.workflowRunId===lease.workflowRunId);this.#checkData(who,x);
        if(x.origin==='USER_REQUEST'&&x.operation==='PLANNING_ONLY')requireIntegrity(who.roles.some(r=>this.#policy().planningRoles.includes(r)));
        else requireIntegrity(who.roles.some(r=>['RECOVERY_OPERATOR','RECOVERY_ADMIN'].includes(r)));
        const prior=tx.get('SELECT plan_id FROM recovery_continuation_plans WHERE workflow_run_id=? AND request_id=?',x.workflowRunId,x.requestId);
        if(prior){const saved=readContinuationPlan(tx,String(prior.plan_id));const {planId,contract,planDigest,createdBy,createdAt,expiresAt,timing,binding,...original}=saved;
          requireIntegrity(createdBy===who.actorId&&canonicalJson(original)===canonicalJson(x));return saved;}
        if(x.artifact)requireIntegrity(readArtifact(tx,x.artifact).ownerId===who.actorId);
        if(x.previousArtifact){const a=readArtifact(tx,x.previousArtifact);requireIntegrity(a.ownerId===who.actorId&&a.workflowRunId===x.workflowRunId);}
        const binding={...planBinding(this.#host.db,tx,x,this.#policy(),this.#provider(x),this.#options.reads,this.#timing),executors:this.withoutAuthority(()=>this.#host.executorBinding(x))};
        const createdAt=recoveryTime(tx),body={...x,planId:randomUUID(),contract:BOUNDED_CONTRACT,createdBy:who.actorId,createdAt,
          expiresAt:Math.min(createdAt+this.#timing.startTtlMs,who.expiresAt),timing:this.#timing,binding};
        const p={...body,planDigest:digest(body)} as ContinuationPlan;
        tx.run('INSERT INTO recovery_continuation_plans VALUES(?,?,?,?,?,?,?,?,?,?,?)',p.planId,p.workflowRunId,p.requestId,p.operation,p.mode??null,p.origin,canonicalJson(p),p.planDigest,p.createdBy,p.expiresAt,p.contract);
        if(p.operation==='PLANNING_ONLY'&&p.origin==='USER_REQUEST')this.#grant(tx,p,who);
        return p;
      }
      if(command.kind==='REVOKE') {
        const g=tx.get('SELECT * FROM recovery_continuation_grants WHERE grant_id=?',command.grantId);requireIntegrity(g&&g.workflow_run_id===lease.workflowRunId&&g.status==='AUTHORIZED'&&(g.actor_id===who.actorId||who.roles.includes('RECOVERY_ADMIN')));
        tx.run("UPDATE recovery_continuation_grants SET status='REVOKED' WHERE grant_id=?",command.grantId);return;
      }
      if(command.kind==='REVIEW') {
        const a=readArtifact(tx,command.artifact);requireIntegrity(a.workflowRunId===lease.workflowRunId&&a.ownerId===who.actorId&&!readWorkflowControl(tx,a.workflowRunId).active_invocation_id);
        const target=readPlanningReviewTarget(tx,a.workflowRunId);
        requireIntegrity(target&&target.artifactId===a.artifactId&&target.version===a.version&&target.contentDigest===a.contentDigest&&target.ownerId===who.actorId
          &&Number.isSafeInteger(command.expectedControlRevision)&&target.controlRevision===command.expectedControlRevision
          &&['ACCEPTED_FOR_SCOPE','REJECTED','SUPERSEDED'].includes(command.decision));
        tx.run('INSERT INTO planning_reviews VALUES(?,?,?,?,?,?)',randomUUID(),a.workflowRunId,a.artifactId,who.actorId,command.decision,recoveryTime(tx));
        // Every decision consumes the observed revision. Acceptance keeps the execution gate.
        const accepted=command.decision==='ACCEPTED_FOR_SCOPE';
        this.#lifecycle(tx,a.workflowRunId,{review:accepted},accepted?'PLAN_REVIEW_ACCEPTED':'PLAN_DISCARDED',lease.generation,command.expectedControlRevision);
        return;
      }
      const p=readContinuationPlan(tx,command.planId);requireIntegrity(p.workflowRunId===lease.workflowRunId);
      requireIntegrity(command.kind==='AUTHORIZE'&&command.planDigest===p.planDigest);this.#current(tx,p);return this.#grant(tx,p,who);
    });
  }
  #stop(lease:WorkflowLease,planId:string,credential:unknown):void {
    let candidate:Row|undefined,committed:Row|undefined;
    const authorize=(tx:DurableTransaction)=>{
      const who=this.#identity(tx,credential,lease.workflowRunId,'VIEW'),p=readContinuationPlan(tx,planId);
      requireIntegrity(p.workflowRunId===lease.workflowRunId);
      const i=tx.get('SELECT * FROM recovery_invocations WHERE plan_id=?',planId);requireIntegrity(i);
      if(i.owner_id!==who.actorId&&!who.roles.includes('RECOVERY_ADMIN'))throw new DurableStoreError('RECOVERY_UNAUTHORIZED');
      return {who,p,i};
    };
    try {committed=this.#write(lease,tx=>{
      const {who,p,i}=authorize(tx);
      if(i.status==='ACTIVE') {
        tx.run("UPDATE recovery_invocations SET status='DRAINING',outcome='USER_STOP',revision=revision+1 WHERE invocation_id=?",i.invocation_id);
        this.#receipt(tx,p,'STOP',{invocationId:String(i.invocation_id),actor:who.actorId,owner:String(i.owner_id),
          authorization:i.owner_id===who.actorId?'OWNER':'RECOVERY_ADMIN',outcome:'USER_STOP',at:recoveryTime(tx)});
      }
      candidate=tx.get("SELECT * FROM recovery_continuation_receipts WHERE plan_id=? AND kind='STOP'",planId);
      return candidate;
    });}catch(error){
      // A COMMIT ACK can be lost. Only this exact immutable STOP receipt proves the write committed.
      // Rollback, failed authentication and failed Audit never justify a local abort.
      if(!candidate)throw error;
      committed=this.#host.db.read(tx=>{
        authorize(tx);
        const saved=tx.get('SELECT * FROM recovery_continuation_receipts WHERE receipt_id=?',candidate!.receipt_id);
        return saved&&canonicalJson(saved)===canonicalJson(candidate)?saved:undefined;
      });
      if(!committed)throw error;
    }
    if(committed) {
      const body=JSON.parse(String(committed.receipt_json));requireIntegrity(digest(body)===committed.receipt_digest);
      this.withoutAuthority(()=>this.#active.get(body.invocationId)?.abort.abort());
    }
  }
  #grant(tx:DurableTransaction,p:ContinuationPlan,who:VerifiedRecoveryIdentity):string {
    const rule=p.operation==='RELEASE_RECOVERY_HOLD'?this.#policy().releaseApprovals:this.#policy().recoveryApprovals;
    if(!(p.origin==='USER_REQUEST'&&p.operation==='PLANNING_ONLY'))requireIntegrity(!rule.forbidSelfApproval||who.actorId!==p.createdBy);
    const prior=tx.get('SELECT * FROM recovery_continuation_grants WHERE plan_id=? AND actor_id=?',p.planId,who.actorId);
    if(prior){requireIntegrity(prior.status==='AUTHORIZED'&&Number(prior.expires_at)>recoveryTime(tx));return String(prior.grant_id);}
    const id=randomUUID();tx.run("INSERT INTO recovery_continuation_grants VALUES(?,?,?,?,?,?,?,'AUTHORIZED')",id,p.workflowRunId,p.planId,who.actorId,who.source,p.planDigest,Math.min(p.expiresAt,who.expiresAt));return id;
  }
  #current(tx:DurableTransaction,p:ContinuationPlan):void {
    if(recoveryTime(tx)>=p.expiresAt)throw new DurableStoreError('RECOVERY_INVALID_PLAN');
    const b={...planBinding(this.#host.db,tx,p,this.#policy(),this.#provider(p),this.#options.reads,this.#timing),executors:this.withoutAuthority(()=>this.#host.executorBinding(p))};
    if(canonicalJson(b)!==canonicalJson(p.binding))throw new DurableStoreError('RECOVERY_INVALID_PLAN');
  }
  async start(lease:WorkflowLease|undefined,planId:string,credential:unknown,signal?:AbortSignal):Promise<ContinuationInspection> {
    const prior=this.#host.db.read(tx=>{const p=readContinuationPlan(tx,planId);this.#identity(tx,credential,p.workflowRunId,'EXECUTE');
      return tx.get('SELECT receipt_id FROM recovery_continuation_receipts WHERE plan_id=?',planId)?this.#inspect(tx,planId,credential):undefined;});
    if(prior)return prior;
    if(!lease)throw new DurableStoreError('LEASE_FENCED');
    let committed:{p:ContinuationPlan;who:VerifiedRecoveryIdentity;invocationId?:string};
    try {committed=this.#write(lease,tx=>{
      const p=readContinuationPlan(tx,planId),who=this.#identity(tx,credential,p.workflowRunId,'EXECUTE');
      requireIntegrity(p.workflowRunId===lease.workflowRunId&&!signal?.aborted);
      if(p.origin==='USER_REQUEST'&&p.operation==='PLANNING_ONLY')requireIntegrity(p.createdBy===who.actorId&&who.roles.some(r=>this.#policy().planningRoles.includes(r)));
      else requireIntegrity(who.roles.some(r=>['RECOVERY_OPERATOR','RECOVERY_ADMIN'].includes(r)));this.#checkData(who,p);this.#current(tx,p);
      const grants=tx.all("SELECT * FROM recovery_continuation_grants WHERE plan_id=? AND status='AUTHORIZED' AND expires_at>?",p.planId,recoveryTime(tx));
      const rule=p.operation==='RELEASE_RECOVERY_HOLD'?this.#policy().releaseApprovals:this.#policy().recoveryApprovals;
      requireIntegrity(grants.length>=(p.origin==='USER_REQUEST'&&p.operation==='PLANNING_ONLY'?1:rule.minimumApprovers)&&grants.every(g=>g.plan_digest===p.planDigest));
      for(const g of grants)tx.run("UPDATE recovery_continuation_grants SET status='CONSUMED' WHERE grant_id=?",g.grant_id);
      if(p.resume)this.#applyResume(tx,p,lease);
      if(p.operation==='RELEASE_RECOVERY_HOLD') {
        this.#lifecycle(tx,p.workflowRunId,{hold:'RELEASED'},'HOLD_RELEASED',lease.generation);this.#receipt(tx,p,'RELEASE',{planId:p.planId,at:recoveryTime(tx),actor:who.actorId});return {p,who};
      }
      const invocationId=randomUUID(),now=recoveryTime(tx),admission=Math.min(now+p.timing.admissionMs,p.expiresAt,who.expiresAt,...grants.map(g=>Number(g.expires_at))),
        collection=admission+Math.max(p.timing.modelTimeoutMs,p.timing.actionTimeoutMs,p.timing.readTimeoutMs)+p.timing.collectionGraceMs+p.timing.finalizationMs;
      tx.run("INSERT INTO recovery_invocations VALUES(?,?,?,?,?,?,'ACTIVE',NULL,0,?,?,?,?)",invocationId,p.workflowRunId,p.planId,who.actorId,lease.runtimeInstanceId,lease.generation,executionState(tx,p.workflowRunId),now,admission,collection);
      this.#lifecycle(tx,p.workflowRunId,{active:invocationId,review:p.operation==='BOUNDED_CONTINUATION'&&p.artifact?false:undefined},'INVOCATION_STARTED',lease.generation);
      this.#receipt(tx,p,'START',{planId:p.planId,invocationId,actor:who.actorId,at:now});return {p,who,invocationId};
    });}catch(error){const saved=this.#host.db.read(tx=>tx.get('SELECT receipt_id FROM recovery_continuation_receipts WHERE plan_id=?',planId));if(saved)return this.#host.db.read(tx=>this.#inspect(tx,planId,credential));throw error;}
    if(!committed.invocationId)return this.#host.db.read(tx=>this.#inspect(tx,planId,credential));
    // Created only on the direct acknowledged return above. No ID/inspection can enter this branch.
    const ctx:Context={plan:committed.p,invocationId:committed.invocationId,lease,actor:committed.who,phase:'RUNNER',valid:true,abort:new AbortController()};
    const abort=()=>ctx.abort.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();this.#active.set(ctx.invocationId,ctx);
    const stopHeartbeat=this.#host.db.createLeaseManager().startHeartbeat(lease,abort);
    try {await this.#contexts.run(ctx,async()=>{
      try {
        if(ctx.plan.operation==='PLANNING_ONLY')await this.#planning(ctx);
        else {
          await runBoundedRunner(this.#host.db,ctx.lease,ctx.plan,this.#provider(ctx.plan)!,ctx.abort.signal,()=>this.#round(ctx));
          this.#finish(ctx,'COMPLETED','BOUNDED_SCOPE_COMPLETED');
        }
      }catch(error){
        try {const unknown=this.#host.db.read(tx=>effectiveModelRows(tx,ctx.plan.workflowRunId).some(r=>r.unresolved)||!!tx.get("SELECT action_id FROM execution_ledger WHERE workflow_run_id=? AND state IN ('DISPATCH_RESERVED','RESULT_RECORDED','REVIEW_REQUIRED')",ctx.plan.workflowRunId)||!!tx.get("SELECT read_id FROM planning_read_calls WHERE workflow_run_id=? AND state='INTENT'",ctx.plan.workflowRunId));
          this.#finish(ctx,unknown?'REVIEW_REQUIRED':'STOPPED',error instanceof DurableStoreError?error.code:'CONTINUATION_FAILED');}catch{/* Retain the persisted unresolved Invocation for diagnosis. */}
      }
    });}finally{stopHeartbeat();ctx.valid=false;this.#active.delete(ctx.invocationId);signal?.removeEventListener('abort',abort);}
    return this.#host.db.read(tx=>this.#inspect(tx,planId,credential));
  }
  #applyResume(tx:DurableTransaction,p:ContinuationPlan,lease:WorkflowLease):void {
    const s=readJournal(tx,p.workflowRunId).snapshot;requireIntegrity(['BLOCKED','SUSPENDED'].includes(s.run.status));
    const event=createRunnerEvent(s,'WorkflowResumed',p.resume,{now:()=>recoveryTime(tx)},{nextId:()=>randomUUID()});
    const next=appendEvent(s,event);requireIntegrity(!runnerSecurityReviewReason(next)&&!runnerEvidenceReviewReason(next));
    this.#resume=true;try{new SqliteCoordinationRunnerStore(this.#host.db,lease).appendInTransaction(tx,event);}finally{this.#resume=false;}
  }
  #round(ctx:Context):void {ctx.roundStepId=this.#host.write(ctx.lease,tx=>this.#step(tx,ctx,'ROUND',randomUUID(),'ROUND',zeroAmounts()));}
  #step(tx:DurableTransaction,ctx:Context,kind:'ROUND'|'MODEL'|'ACTION'|'READ',target:string,purpose:string,amounts:{inputTokens:number;outputTokens:number;costMicros:number},roundKey?:string):string {
    requireIntegrity(this.#policy().canAccess(ctx.actor,ctx.plan.workflowRunId,'EXECUTE')&&digest(continuationPolicyBinding(this.#policy()))===digest(ctx.plan.binding.policy));
    assertControlledBudget(tx,ctx.plan.workflowRunId);
    const i=tx.get('SELECT * FROM recovery_invocations WHERE invocation_id=?',ctx.invocationId)!;
    if(i.status!=='ACTIVE'||ctx.abort.signal.aborted||recoveryTime(tx)>=Number(i.admission_deadline))throw new DurableStoreError('CONTINUATION_EXPIRED');
    const prior=tx.get('SELECT step_id FROM recovery_invocation_steps WHERE invocation_id=? AND kind=? AND target_id=?',ctx.invocationId,kind,target);if(prior)return String(prior.step_id);
    const max={ROUND:ctx.plan.limits.maxRounds,MODEL:ctx.plan.limits.maxModelCalls,ACTION:ctx.plan.limits.maxActionDispatches,READ:ctx.plan.limits.maxReadCalls}[kind];
    const used=Number(tx.get('SELECT count(*) AS n FROM recovery_invocation_debits WHERE invocation_id=? AND kind=?',ctx.invocationId,kind)!.n);
    if(used>=max)throw new DurableStoreError('CONTINUATION_LIMIT');
    const usage=this.#usage(tx,ctx.invocationId),limits=ctx.plan.limits;
    for(const [key,limit] of [['inputTokens',limits.maxInputTokens],['outputTokens',limits.maxOutputTokens],['costMicros',limits.maxCostMicros]] as const)
      requireIntegrity(Number.isSafeInteger(amounts[key])&&amounts[key]>=0&&BigInt(usage.committed[key])+BigInt(usage.outstanding[key])+BigInt(amounts[key])<=BigInt(limit));
    const step=randomUUID(),now=recoveryTime(tx),execution=now+({ROUND:ctx.plan.timing.admissionMs,MODEL:ctx.plan.timing.modelTimeoutMs,ACTION:ctx.plan.timing.actionTimeoutMs,READ:ctx.plan.timing.readTimeoutMs}[kind]);
    tx.run('INSERT INTO recovery_invocation_steps VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',step,ctx.plan.workflowRunId,ctx.invocationId,kind,target,purpose,roundKey??null,kind==='ROUND'?null:ctx.roundStepId??null,now,execution,execution+ctx.plan.timing.collectionGraceMs,execution+ctx.plan.timing.collectionGraceMs+ctx.plan.timing.finalizationMs);
    tx.run('INSERT INTO recovery_invocation_debits VALUES(?,?,?,?,?,?,?,?)',step,ctx.plan.workflowRunId,ctx.invocationId,kind,target,amounts.inputTokens,amounts.outputTokens,amounts.costMicros);return step;
  }
  participate(tx:DurableTransaction,kind:'MODEL'|'ACTION',target:string,amounts:{inputTokens:number;outputTokens:number;costMicros:number},roundKey?:string):void {
    const c=this.#inTransaction;if(!c)return;
    requireIntegrity(this.#tx===tx&&c.valid);
    if(kind==='MODEL')c.callId=target;
    const model=kind==='MODEL'?tx.get('SELECT * FROM model_call_ledger WHERE model_call_id=?',target):undefined;
    if(model){const {requestDigest,maxAttempts,...quote}=JSON.parse(String(model.quote_json));requireIntegrity(model.provider_id===c.plan.providerId&&model.model_id===c.plan.modelId&&maxAttempts===1&&canonicalJson(quote)===canonicalJson((c.plan.binding.provider as BoundedProvider['capabilities']).quote));}
    const step=this.#step(tx,c,kind,target,model?(c.plan.operation==='PLANNING_ONLY'?'DRAFT_PLAN':String(model.phase)):kind,amounts,roundKey);
    if(model&&c.plan.operation==='BOUNDED_CONTINUATION') {
      const predecessors=effectiveModelRows(tx,c.plan.workflowRunId).filter(r=>r.historical.model_call_id!==target&&r.historical.phase===model.phase&&
        (r.historical.round_key===roundKey||tx.get('SELECT step_id FROM recovery_invocation_steps WHERE workflow_run_id=? AND target_id=? AND business_round_key=?',c.plan.workflowRunId,r.historical.model_call_id,roundKey!)));
      for(const r of predecessors)requireIntegrity(!r.unresolved&&(r.resolution||r.historical.state==='CANCELLED_PRE_DISPATCH'||r.historical.application_status==='DISCARDED'));
      const prior=predecessors.sort((a,b)=>Number(b.historical.created_at)-Number(a.historical.created_at))[0];
      if(prior) {
        const resolution=prior.resolution??tx.get("SELECT * FROM runtime_audit_events WHERE model_call_id=? AND event_kind IN ('MODEL_CALL_CANCELLED_PRE_DISPATCH','MODEL_RESPONSE_DISCARDED') ORDER BY audit_sequence DESC LIMIT 1",prior.historical.model_call_id);
        requireIntegrity(resolution);
        tx.run('INSERT INTO recovery_model_lineage VALUES(?,?,?,?,?,?)',step,c.plan.workflowRunId,target,prior.historical.model_call_id,String(resolution.operation_id??resolution.audit_event_id),digest(resolution));
      }
    }
  }
  #usage(tx:DurableTransaction,invocationId:string):ContinuationInspection['usage'] {
    let committed=zeroAmounts(),outstanding=zeroAmounts();
    for(const r of tx.all("SELECT m.* FROM model_call_ledger m JOIN recovery_invocation_debits d ON d.target_id=m.model_call_id AND d.workflow_run_id=m.workflow_run_id WHERE d.invocation_id=? AND d.kind='MODEL'",invocationId)) {
      if(r.state==='SETTLED')committed=addAmounts(committed,usageAmounts(JSON.parse(String(r.usage_json))));
      else if(effectiveModelRows(tx,String(r.workflow_run_id)).find(x=>x.historical.model_call_id===r.model_call_id)?.outstandingReservation)outstanding=addAmounts(outstanding,{llmCalls:1,inputTokens:Number(r.reserved_input),outputTokens:Number(r.reserved_output),costMicros:Number(r.reserved_cost)});
    }
    const {llmCalls:_,...a}=committed,{llmCalls:__,...b}=outstanding;return {committed:a,outstanding:b};
  }
  #finish(ctx:Context,status:'COMPLETED'|'STOPPED'|'REVIEW_REQUIRED',outcome:string,review?:boolean,tx?:DurableTransaction):void {
    const finish=(t:DurableTransaction)=>{const r=t.get('SELECT * FROM recovery_invocations WHERE invocation_id=?',ctx.invocationId)!;
      if(!['ACTIVE','DRAINING'].includes(String(r.status)))return;
      t.run("UPDATE recovery_invocations SET status='DRAINING',revision=revision+1 WHERE invocation_id=?",ctx.invocationId);
      t.run('UPDATE recovery_invocations SET status=?,outcome=?,revision=revision+1 WHERE invocation_id=?',status,outcome,ctx.invocationId);
      this.#lifecycle(t,ctx.plan.workflowRunId,{active:null,review},review?'PLAN_REVIEW_PENDING':'INVOCATION_FINISHED',ctx.lease.generation);
      this.#receipt(t,ctx.plan,'FINISH',{invocationId:ctx.invocationId,status,outcome,at:recoveryTime(t)});};
    if(tx)finish(tx);else {const prior=ctx.phase;ctx.phase='FINISH';try{this.#host.write(ctx.lease,finish);}finally{ctx.phase=prior;}}
  }
  #inspect(tx:DurableTransaction,planId:string,credential:unknown):ContinuationInspection {
    const p=readContinuationPlan(tx,planId),who=this.#identity(tx,credential,p.workflowRunId,'VIEW');
    requireIntegrity(p.createdBy===who.actorId||who.roles.includes('RECOVERY_ADMIN'));
    const i=tx.get('SELECT * FROM recovery_invocations WHERE plan_id=?',planId),c=readWorkflowControl(tx,p.workflowRunId);
    const a=i&&tx.get('SELECT * FROM planning_artifacts WHERE invocation_id=?',i.invocation_id);
    const q=i&&tx.get('SELECT input_request_id,owner_id FROM planning_input_requests WHERE invocation_id=?',i.invocation_id);
    if(q)requireIntegrity(q.owner_id===who.actorId);
    const counts={rounds:0,modelCalls:0,actionDispatches:0,readCalls:0};
    if(i)for(const r of tx.all('SELECT kind,count(*) AS n FROM recovery_invocation_debits WHERE invocation_id=? GROUP BY kind',i.invocation_id))
      counts[({ROUND:'rounds',MODEL:'modelCalls',ACTION:'actionDispatches',READ:'readCalls'} as const)[r.kind as 'ROUND']]=Number(r.n);
    const review=a?tx.get('SELECT decision FROM planning_reviews WHERE artifact_id=? ORDER BY rowid DESC LIMIT 1',a.artifact_id):undefined;
    const target=readPlanningReviewTarget(tx,p.workflowRunId);
    return {remaining:{rounds:p.limits.maxRounds-counts.rounds,modelCalls:p.limits.maxModelCalls-counts.modelCalls,actionDispatches:p.limits.maxActionDispatches-counts.actionDispatches,readCalls:p.limits.maxReadCalls-counts.readCalls},
      performed:{businessActionDispatches:counts.actionDispatches,localReadCalls:counts.readCalls,modelCalls:counts.modelCalls,internalPersistence:true},
      review:{state:(review?.decision??'UNREVIEWED') as 'UNREVIEWED',target:a&&target?.artifactId===a.artifact_id&&target.ownerId===who.actorId?target:undefined,executionAuthorizationRequired:true},plan:p,invocation:i?{invocationId:String(i.invocation_id),status:i.status as 'ACTIVE',outcome:i.outcome as string|null}:undefined,
      artifact:a?readArtifact(tx,{artifactId:String(a.artifact_id),version:Number(a.version),contentDigest:String(a.content_digest)}):undefined,
      inputRequest:q?readPlanningInputRequest(tx,String(q.input_request_id)):undefined,
      control:{holdState:String(c.hold_state),holdEpoch:Number(c.hold_epoch),revision:Number(c.control_revision),planningReviewPending:!!c.planning_review_pending},
      counts,usage:i?this.#usage(tx,String(i.invocation_id)):{committed:{inputTokens:0,outputTokens:0,costMicros:0},outstanding:{inputTokens:0,outputTokens:0,costMicros:0}},executionAllowed:false};
  }
  async #planning(ctx:Context):Promise<void> {
    const p=ctx.plan;requireIntegrity(p.operation==='PLANNING_ONLY');
    const provider=this.#provider(p)!,caps=validateProvider(provider,p),store=new SqliteCoordinationRunnerStore(this.#host.db,ctx.lease),ledger=new ModelCallLedger(store);
    const reads:PlanningProviderRequest['reads']=[];
    for(let n=0;n<p.limits.maxModelCalls;n++) {
      requireIntegrity(digest(validateProvider(this.#provider(p),p))===digest(p.binding.provider));
      ctx.phase='MODEL';const s=store.getSnapshot(p.workflowRunId),callId=randomUUID();
      const x:ModelCallIdentity={workflowRunId:p.workflowRunId,modelCallId:callId,attemptId:randomUUID(),providerId:p.providerId!,modelId:p.modelId!};
      const request=jsonCopy({mode:p.mode,input:p.input!.text,reasoning:p.reasoning??{},references:p.input!.snapshots,reads,
        remainingModelCalls:p.limits.maxModelCalls-n,remainingReadCalls:p.limits.maxReadCalls-reads.length});
      ctx.planningRequest=request;
      this.#checkData(ctx.actor,p,request);
      ledger.reserve({...x,roundKey:`bounded:${ctx.invocationId}:${n}`,phase:'PLAN',requestCursor:s.events.length,requestEventId:s.events.at(-1)!.eventId,
        quote:{...caps.quote,maxAttempts:1,requestDigest:digest(request)}});
      ledger.markDispatchIntent(x);store.assertLease(p.workflowRunId);
      const remaining=this.dispatchDeadline('MODEL',callId);
      const sendDeadline=performance.now()+remaining;
      const collected=await collectBoundedResponse(signal=>this.withoutAuthority(async()=>{
        this.#checkData(ctx.actor,p,request); // Last check of this exact payload, after Intent and before external entry.
        store.assertLease(p.workflowRunId);
        this.#host.db.read(tx=>{
          const i=tx.get('SELECT status,admission_deadline FROM recovery_invocations WHERE invocation_id=?',ctx.invocationId);
          const step=tx.get("SELECT execution_deadline FROM recovery_invocation_steps WHERE invocation_id=? AND kind='MODEL' AND target_id=?",ctx.invocationId,callId);
          requireIntegrity(i&&step);
          if(i.status!=='ACTIVE'||signal.aborted||ctx.abort.signal.aborted||performance.now()>=sendDeadline
            ||recoveryTime(tx)>=Math.min(Number(i.admission_deadline),Number(step.execution_deadline)))throw new DurableStoreError('CONTINUATION_EXPIRED');
        });
        return jsonCopy(await provider.draftPlan!({...jsonCopy(request),signal}));
      }),remaining,p.timing.collectionGraceMs,ctx.abort.signal);
      store.assertLease(p.workflowRunId);
      const result=collected.value;
      if(!result||result.completeness!=='COMPLETE'||!result.usage) {
        ledger.markReviewRequired(x,result?.completeness==='PARTIAL'?'PARTIAL':'UNKNOWN',result?.usage);
        throw new DurableStoreError('MODEL_REVIEW_REQUIRED');
      }
      const stopped=collected.aborted||this.#host.db.read(tx=>tx.get('SELECT status FROM recovery_invocations WHERE invocation_id=?',ctx.invocationId)?.status==='DRAINING');
      const row=ledger.settle(x,result.usage,!collected.timedOut&&!stopped);
      if(collected.timedOut||stopped){this.#finish(ctx,'STOPPED',stopped?'USER_STOP':'MODEL_TIMEOUT');return;}
      if(row.budget_violation){ledger.markDiscarded(x,'BUDGET_EXHAUSTED');throw new DurableStoreError('MODEL_BUDGET_EXHAUSTED');}
      let draft;
      try{draft=validateDraft(result.value);}catch{ledger.markDiscarded(x,'INVALID_RESPONSE');this.#finish(ctx,'STOPPED','PLAN_INCOMPLETE');return;}
      if(draft.kind==='read_requests'&&(p.mode!=='PLAN_READ_ONLY'||n+1>=p.limits.maxModelCalls||reads.length+draft.requests.length>p.limits.maxReadCalls)) {
        ledger.markDiscarded(x,'INVALID_RESPONSE');this.#finish(ctx,'STOPPED','PLAN_INCOMPLETE');return;
      }
      ctx.phase='APPLICATION';
      if(draft.kind==='plan') {
        const content=jsonCopy(draft.artifact),text=executionJson(content,96*1024);requireIntegrity(this.#policy().inspectContent(text,p.input!.dataClass));
        const summary:PlanArtifact['summary']={state:!p.requestSummary?'NOT_REQUESTED':!caps.summary?'NOT_SUPPORTED':!result.summary?'NOT_RETURNED':!this.#policy().storeReasoningSummary?'NOT_STORED':'AVAILABLE',source:'PROVIDER_SUMMARY'};
        if(summary.state==='AVAILABLE'){assertPlanningTextSafe(result.summary!);requireIntegrity(result.summary!.length<=16*1024&&this.#policy().inspectContent(result.summary!,p.input!.dataClass));summary.text=result.summary;}
        const artifact:PlanArtifact={artifactId:randomUUID(),version:p.previousArtifact?p.previousArtifact.version+1:1,schemaVersion:1,
          contentDigest:digest(content),workflowRunId:p.workflowRunId,ownerId:ctx.actor.actorId,requestId:p.requestId,invocationId:ctx.invocationId,
          modelCallId:x.modelCallId,mode:p.mode,previousArtifact:p.previousArtifact,content,providerId:caps.providerId,modelId:caps.modelId,adapterVersion:caps.adapterVersion,
          reasoning:p.reasoning??{},snapshots:planningSnapshots(request),
          summary,completeness:'COMPLETE',dataClass:p.input!.dataClass,createdAt:Date.now(),basisDigest:this.#host.db.read(tx=>artifactBasis(tx,p.workflowRunId))};
        const json=executionJson(artifact,128*1024);rejectEmbeddedCredentials(artifact);
        this.#host.write(ctx.lease,tx=>{
          tx.run('INSERT INTO planning_artifacts (artifact_id,workflow_run_id,invocation_id,model_call_id,owner_id,version,content_digest,artifact_json) VALUES(?,?,?,?,?,?,?,?)',artifact.artifactId,p.workflowRunId,ctx.invocationId,x.modelCallId,artifact.ownerId,artifact.version,artifact.contentDigest,json);
          if(p.previousArtifact)tx.run("INSERT INTO planning_reviews VALUES(?,?,?,?,?,?)",randomUUID(),p.workflowRunId,p.previousArtifact.artifactId,ctx.actor.actorId,'SUPERSEDED',recoveryTime(tx));
          this.#applyPlanning(tx,ctx,x,'PlanArtifactPublished',artifact.artifactId,artifact.contentDigest);
          this.#finish(ctx,'COMPLETED','AWAITING_PLAN_REVIEW',true,tx);
        });return;
      }
      if(draft.kind==='needs_input') {
        const questions=jsonCopy(draft.questions);
        requireIntegrity(this.#policy().inspectContent(executionJson(questions,96*1024),p.input!.dataClass));
        const inputRequest:PlanningInputRequest={inputRequestId:randomUUID(),schemaVersion:1,state:'AWAITING_INPUT',
          workflowRunId:p.workflowRunId,ownerId:ctx.actor.actorId,requestId:p.requestId,invocationId:ctx.invocationId,
          modelCallId:x.modelCallId,mode:p.mode,questions,contentDigest:digest(questions),snapshots:planningSnapshots(request),
          dataClass:p.input!.dataClass,createdAt:this.#host.db.read(recoveryTime)};
        const json=executionJson(inputRequest,128*1024);assertPlanningTextSafe(json);rejectEmbeddedCredentials(inputRequest);
        this.#host.write(ctx.lease,tx=>{
          tx.run('INSERT INTO planning_input_requests (input_request_id,workflow_run_id,invocation_id,model_call_id,owner_id,content_digest,request_json) VALUES(?,?,?,?,?,?,?)',
            inputRequest.inputRequestId,p.workflowRunId,ctx.invocationId,x.modelCallId,inputRequest.ownerId,inputRequest.contentDigest,json);
          this.#applyPlanning(tx,ctx,x,'PlanningInputRequested',inputRequest.inputRequestId,inputRequest.contentDigest);
          this.#finish(ctx,'STOPPED','PLAN_INCOMPLETE',undefined,tx);
        });return;
      }
      const requests=draft.requests;
      for(const r of requests){requireIntegrity(p.resources?.includes(r.resourceId)&&this.#options.reads?.describe(r.resourceId)?.digest===r.digest);}
      this.#host.write(ctx.lease,tx=>this.#applyPlanning(tx,ctx,x,'PlanningReadRequested',p.requestId,digest(requests)));
      for(const r of requests) {
        ctx.phase='READ';const id=randomUUID();
        this.#host.write(ctx.lease,tx=>{const step=this.#step(tx,ctx,'READ',id,'READ',zeroAmounts());
          tx.run("INSERT INTO planning_read_calls VALUES(?,?,?,?,?,?,?,'INTENT',NULL,NULL,0,?,?)",id,p.workflowRunId,ctx.invocationId,step,r.resourceId,digest(r),r.digest,recoveryTime(tx),recoveryTime(tx)+p.timing.readTimeoutMs);});
        const remainingRead=this.dispatchDeadline('READ',id);
        const value=await collectBoundedResponse(async()=>this.withoutAuthority(()=>this.#options.reads!.read(r.resourceId,r.digest)),remainingRead,p.timing.collectionGraceMs,ctx.abort.signal);
        store.assertLease(p.workflowRunId);
        this.#host.write(ctx.lease,tx=>tx.run('UPDATE planning_read_calls SET state=?,result_digest=?,size_bytes=? WHERE read_id=?',value.timedOut?'TIMED_OUT':value.value?'SUCCEEDED':'FAILED',value.value?.digest??null,value.value?.sizeBytes??null,id));
        if(!value.value||value.timedOut||value.aborted)throw new DurableStoreError('PLANNING_READ_DENIED');
        assertPlanningTextSafe(value.value.text);requireIntegrity(this.#policy().inspectContent(value.value.text,p.input!.dataClass));
        const metadata=this.#options.reads!.describe(r.resourceId)!;
        const snapshot={id:r.resourceId,digest:metadata.digest,revision:metadata.revision,observedAt:this.#host.db.read(recoveryTime)};
        requireIntegrity(snapshot.digest===value.value.digest&&this.#policy().canSend(ctx.actor,snapshot,p.input!.destination,p.input!.dataClass));
        reads.push({resourceId:r.resourceId,digest:snapshot.digest,revision:snapshot.revision,observedAt:snapshot.observedAt,text:value.value.text});
      }
    }
    this.#finish(ctx,'STOPPED','PLAN_INCOMPLETE');
  }
  #applyPlanning(tx:DurableTransaction,ctx:Context,x:ModelCallIdentity,type:'PlanArtifactPublished'|'PlanningReadRequested'|'PlanningInputRequested',referenceId:string,contentDigest:string):void {
    const store=new SqliteCoordinationRunnerStore(this.#host.db,ctx.lease),s=readJournal(tx,x.workflowRunId).snapshot;
    requireIntegrity(!ctx.abort.signal.aborted&&tx.get('SELECT status FROM recovery_invocations WHERE invocation_id=?',ctx.invocationId)?.status==='ACTIVE');
    const row=tx.get('SELECT * FROM model_call_ledger WHERE model_call_id=?',x.modelCallId)!;
    requireIntegrity(ctx.plan.operation==='PLANNING_ONLY'&&ctx.callId===x.modelCallId&&row.state==='SETTLED'&&row.application_status==='PENDING_APPLICATION'&&!row.budget_violation
      &&s.events.length===Number(row.request_cursor)+1&&s.events.at(-1)!.eventId===row.usage_event_id);
    const event=createRunnerEvent(s,type,{invocationId:ctx.invocationId,modelCallId:x.modelCallId,referenceId,contentDigest},{now:()=>recoveryTime(tx)},{nextId:()=>randomUUID()});
    store.appendInTransaction(tx,event);
    tx.run("UPDATE model_call_ledger SET application_status='APPLIED',application_event_id=?,application_digest=?,application_start_cursor=?,updated_at=? WHERE model_call_id=?",event.eventId,digest([event]),s.events.length,recoveryTime(tx),x.modelCallId);
  }
}

export class RecoveryContinuationCoordinator {
  constructor(readonly database:DurableDatabase,readonly lease?:WorkflowLease){}
  preview(input:ContinuationPlanInput,credential:unknown) {return this.database.previewContinuation(input,credential);}
  requestRevision(artifact:ArtifactRef,input:ContinuationPlanInput,credential:unknown):ContinuationPlan {requireIntegrity(input.operation==='PLANNING_ONLY');return this.createPlan({...input,previousArtifact:artifact},credential);}
  createPlan(input:ContinuationPlanInput,credential:unknown):ContinuationPlan {return this.database.continuationDecision(this.lease,credential,{kind:'CREATE_PLAN',input}) as ContinuationPlan;}
  authorize(plan:ContinuationPlan,credential:unknown):string {return this.database.continuationDecision(this.lease,credential,{kind:'AUTHORIZE',planId:plan.planId,planDigest:plan.planDigest}) as string;}
  revoke(grantId:string,credential:unknown):void {this.database.continuationDecision(this.lease,credential,{kind:'REVOKE',grantId});}
  inspect(planId:string,credential:unknown):ContinuationInspection {return this.database.continuationDecision(undefined,credential,{kind:'INSPECT',planId}) as ContinuationInspection;}
  startAuthorized(planId:string,credential:unknown,options:{signal?:AbortSignal}={}):Promise<ContinuationInspection> {return this.database.startContinuation(this.lease,planId,credential,options.signal);}
  requestStop(planId:string,credential:unknown):void {this.database.continuationDecision(this.lease,credential,{kind:'STOP',planId});}
  recordReview(artifact:ArtifactRef,decision:'ACCEPTED_FOR_SCOPE'|'REJECTED'|'SUPERSEDED',credential:unknown,expectedControlRevision:number):void {this.database.continuationDecision(this.lease,credential,{kind:'REVIEW',artifact,decision,expectedControlRevision});}
}
