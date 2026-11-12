import { randomUUID } from 'node:crypto';
import { types as utilTypes } from 'node:util';
import type { DurableTransaction, Row, DurableDatabase } from './db';
import type { WorkflowLease } from './runtimeLease';
import type { VerifiedRecoveryIdentity } from './recoveryDecisionTypes';
import { verifyRecoveryIdentity } from './recoveryAuthorization';
import { canonicalJson, digest, DurableStoreError, parseJson, requireIntegrity } from './integrity';
import { recoveryTime } from './recoveryPlanner';
import { reconciliationData, validateReconciliationTarget, readReconciliationTarget, ReconciliationVerifiers, nativeVerifierPromise, validateVerifierResult } from './reconciliationVerifier';
import type { ReconciliationHost, ReconciliationOptions, ReconciliationLimits, ReconciliationPolicy, ReconciliationPermission, ReconciliationTarget, ReconciliationEvidence, ReconciliationVerification, ReconciliationEvidenceCommand, ReconciliationOperationCommand, ReconciliationOperationContext, SubmitReconciliationEvidence, VerifyReconciliationEvidence } from './reconciliationTypes';
import { persistReconciliationDecision, recordVerifiedConflict, recordVerificationRevocation, readReconciliationReceipt } from './reconciliationStore';
import { reconciliationRunnerFacts } from './reconciliationRunnerContext';
import { inspectReconciliationInTransaction } from './reconciliationReader';

export type ReconciliationRuntimeOptions=ReconciliationOptions;
const signalAbortedGetter=Object.getOwnPropertyDescriptor(AbortSignal.prototype,'aborted')!.get!;
function callerAborted(signal?:AbortSignal):boolean {if(!signal)return false;if(utilTypes.isProxy(signal))throw new DurableStoreError('RECOVERY_UNAUTHORIZED');try{return signalAbortedGetter.call(signal);}catch{throw new DurableStoreError('RECOVERY_UNAUTHORIZED');}}
const DEFAULT_LIMITS:ReconciliationLimits={maxCandidateBytes:262144,maxClaimBytes:65536,maxReceiptBytes:131072,maxDepth:32,
  maxCandidatesPerWorkflow:200,maxStoredBytesPerWorkflow:8*1024*1024,maxConcurrentVerifications:4,
  verificationTimeoutMs:10000,collectionGraceMs:1000,planTtlMs:600000,maxPlanTtlMs:1800000};
function limitsFor(input:Partial<ReconciliationLimits>={}):ReconciliationLimits {
  const limits={...DEFAULT_LIMITS,...input};
  for(const [key,value] of Object.entries(limits))requireIntegrity(Object.hasOwn(DEFAULT_LIMITS,key)&&Number.isSafeInteger(value)&&value>0&&value<=DEFAULT_LIMITS[key as keyof ReconciliationLimits]);
  requireIntegrity(limits.planTtlMs<=limits.maxPlanTtlMs);return Object.freeze(limits);
}
export function readReconciliationEvidence(tx:DurableTransaction,id:string):ReconciliationEvidence {
  const r=tx.get('SELECT * FROM reconciliation_evidence WHERE evidence_id=?',id);requireIntegrity(r);
  return {evidenceId:String(r.evidence_id),logicalId:String(r.logical_id),version:Number(r.version),target:{workflowRunId:String(r.workflow_run_id),targetKind:r.target_kind as 'ACTION'|'MODEL',targetId:String(r.target_id),attemptId:String(r.attempt_id)},candidateDigest:String(r.digest),evidenceOwnerId:String(r.owner_id),submittedBy:String(r.submitted_by),dataClass:String(r.data_class),contentType:r.content_type as 'application/json'|'text/plain',sizeBytes:Number(r.size_bytes),createdAt:Number(r.created_at)};
}
export function readReconciliationVerification(tx:DurableTransaction,id:string):ReconciliationVerification {
  const r=tx.get('SELECT * FROM reconciliation_verifications WHERE verification_id=?',id);requireIntegrity(r);
  const v=parseJson<ReconciliationVerification>(r.receipt_json),{receiptDigest,...body}=v;
  requireIntegrity(receiptDigest===r.digest&&digest(body)===receiptDigest&&v.verificationId===id&&v.evidenceId===r.evidence_id&&v.evidenceVersion===r.evidence_version&&v.target.workflowRunId===r.workflow_run_id&&v.target.targetKind===r.target_kind&&v.target.targetId===r.target_id&&v.target.attemptId===r.attempt_id&&v.bindingDigest===r.binding_digest&&v.status===r.status&&canonicalJson(v.claim)===r.claim_json&&digest(v.claim)===v.claimDigest&&v.sourceEffectKey===r.source_effect_key);
  const e=readReconciliationEvidence(tx,v.evidenceId);requireIntegrity(e.candidateDigest===v.candidateDigest&&e.version===v.evidenceVersion&&canonicalJson(e.target)===canonicalJson(v.target));
  const audits=tx.all("SELECT * FROM reconciliation_audit WHERE event_kind='RECONCILIATION_VERIFICATION_RECORDED' AND record_id=?",id);
  requireIntegrity(audits.length===1&&audits[0].record_digest===v.receiptDigest&&audits[0].actor_id===v.verifiedBy);return v;
}
/** Owned by DurableDatabase. The host closures never cross a public API boundary. */
export class ReconciliationRuntime {
  readonly #host:ReconciliationHost; readonly #options:ReconciliationOptions; readonly #limits:ReconciliationLimits; readonly #registry:ReconciliationVerifiers;
  readonly #credentials=new Map<string,unknown>(); #policyFunctions?:{canAccess:unknown;inspectContent:unknown;canSend:unknown}; #policyRevision=1; #writing=false;
  constructor(host:ReconciliationHost,options:ReconciliationOptions={}) {
    this.#host=host;this.#options=options;this.#limits=limitsFor(options.limits);this.#registry=new ReconciliationVerifiers(options.verifiers);
    if(options.policy) {const p=options.policy;this.#policyFunctions={canAccess:p.canAccess,inspectContent:p.inspectContent,canSend:p.canSend};requireIntegrity(typeof p.version==='string'&&p.version.length>0&&typeof p.authorityDomain==='string'&&p.authorityDomain.length>0&&typeof p.canAccess==='function'&&typeof p.inspectContent==='function');
      for(const a of Object.values(p.approvals))requireIntegrity(Number.isSafeInteger(a.minimumApprovers)&&a.minimumApprovers>=1&&a.minimumApprovers<=100&&typeof a.forbidSelfApproval==='boolean');}
  }
  get protecting(){return this.#writing;}
  #policy():ReconciliationPolicy {const p=this.#options.policy;if(!p)throw new DurableStoreError('RECOVERY_UNAUTHORIZED');if(this.#policyFunctions?.canAccess!==p.canAccess||this.#policyFunctions?.inspectContent!==p.inspectContent||this.#policyFunctions?.canSend!==p.canSend){this.#policyRevision++;this.#policyFunctions={canAccess:p.canAccess,inspectContent:p.inspectContent,canSend:p.canSend};}return p;}
  #access(actor:VerifiedRecoveryIdentity,target:ReconciliationTarget,permission:ReconciliationPermission,ownerId?:string):void {
    const roles=permission==='APPROVE_RECONCILIATION'||permission==='REVOKE_GRANT'?['RECOVERY_APPROVER','RECOVERY_ADMIN']
      :['VIEW_CASE','VIEW_EVIDENCE_BODY','USE_EVIDENCE','SEND_RECONCILED_FACT'].includes(permission)?['RECOVERY_VIEWER','RECOVERY_OPERATOR','RECOVERY_APPROVER','RECOVERY_ADMIN']:['RECOVERY_OPERATOR','RECOVERY_ADMIN'];
    let allowed=false;try{allowed=this.#host.outside(()=>this.#policy().canAccess(actor,target,permission,ownerId))===true;}catch{}
    if(!actor.roles.some(r=>roles.includes(r))||!allowed)throw new DurableStoreError('RECOVERY_UNAUTHORIZED');
  }
  #identity(tx:DurableTransaction,credential:unknown,target:ReconciliationTarget,permission:ReconciliationPermission,ownerId?:string):VerifiedRecoveryIdentity {
    const identity=this.#host.outside(()=>verifyRecoveryIdentity(this.#host.identityVerifier,credential,recoveryTime(tx),'VIEW'));
    this.#access(identity,target,permission,ownerId);this.#credentials.set(`${identity.source}\u0000${identity.actorId}`,credential);return identity;
  }
  #content(value:unknown,evidence:Pick<ReconciliationEvidence,'target'|'dataClass'|'evidenceOwnerId'>,stage:'ACCEPT'|'VERIFY'|'NORMALIZED'|'OUTPUT'):void {
    let allowed=false;try{allowed=this.#host.outside(()=>this.#policy().inspectContent(value,{stage,target:evidence.target,dataClass:evidence.dataClass,ownerId:evidence.evidenceOwnerId}))===true;}catch{}
    if(!allowed)throw new DurableStoreError(stage==='OUTPUT'?'RECOVERY_UNAUTHORIZED':'EVIDENCE_STORAGE_UNSUPPORTED');
  }
  #write<T>(lease:WorkflowLease,fn:(tx:DurableTransaction)=>T):T {
    requireIntegrity(!this.#writing);this.#writing=true;try{return this.#host.write(lease,fn);}finally{this.#writing=false;}
  }
  #draining(tx:DurableTransaction,verificationId:string):string[] {return tx.all("SELECT DISTINCT i.invocation_id FROM recovery_invocations i JOIN reconciliation_disputes d ON d.workflow_run_id=i.workflow_run_id WHERE d.verification_id=? AND i.status='DRAINING'",verificationId).map(row=>String(row.invocation_id));}
  #writer(tx:DurableTransaction,lease:WorkflowLease,actorId:string) {return (table:string,row:Row,old?:Row)=>this.#host.scopedWrite(tx,lease,actorId,table,row,old);}
  #audit(tx:DurableTransaction,lease:WorkflowLease,actorId:string,eventKind:string,recordId:string,recordDigest:string):void {
    this.#writer(tx,lease,actorId)('reconciliation_audit',{audit_id:randomUUID(),workflow_run_id:lease.workflowRunId,event_kind:eventKind,record_id:recordId,actor_id:actorId,record_digest:recordDigest,runtime_instance_id:lease.runtimeInstanceId,generation:lease.generation,recorded_at:recoveryTime(tx)});
  }
  #body(tx:DurableTransaction,e:ReconciliationEvidence):unknown {
    const row=tx.get('SELECT body_json FROM reconciliation_evidence_bodies WHERE evidence_id=? AND workflow_run_id=?',e.evidenceId,e.target.workflowRunId);requireIntegrity(row);
    const body=reconciliationData(parseJson(row.body_json),this.#limits.maxCandidateBytes,this.#limits.maxDepth);requireIntegrity(digest(body)===e.candidateDigest&&Buffer.byteLength(canonicalJson(body))===e.sizeBytes);return body;
  }
  #viewVerification(tx:DurableTransaction,id:string,credential:unknown):ReconciliationVerification {
    const v=readReconciliationVerification(tx,id),e=readReconciliationEvidence(tx,v.evidenceId);
    const actor=this.#identity(tx,credential,v.target,'VIEW_CASE');this.#access(actor,v.target,'USE_EVIDENCE',e.evidenceOwnerId);
    this.#content(v,e,'OUTPUT');return v;
  }
  #currentVerification(tx:DurableTransaction,id:string,target:ReconciliationTarget,actor:VerifiedRecoveryIdentity,adoptedAction=false):ReconciliationVerification {
    const v=readReconciliationVerification(tx,id),e=readReconciliationEvidence(tx,v.evidenceId);
    this.#access(actor,target,'VIEW_CASE');this.#access(actor,target,'USE_EVIDENCE',e.evidenceOwnerId);
    requireIntegrity(canonicalJson(v.target)===canonicalJson(target)&&v.status==='VERIFIED');
    if(adoptedAction) {
      requireIntegrity(target.targetKind==='ACTION');
      const outcome=tx.get('SELECT o.*,p.plan_id FROM reconciled_action_outcomes o JOIN reconciliation_operations p ON p.operation_id=o.operation_id WHERE o.workflow_run_id=? AND o.action_id=? AND o.attempt_id=?',target.workflowRunId,target.targetId,target.attemptId);
      requireIntegrity(outcome&&outcome.verification_id===id&&outcome.source_effect_key===v.sourceEffectKey);
      const receipt=readReconciliationReceipt(tx,String(outcome.plan_id));
      requireIntegrity(receipt?.operationKind==='RECORD_VERIFIED_ACTION_OUTCOME'&&receipt.verificationId===id&&receipt.committedAt<v.expiresAt);
    } else {
      requireIntegrity(v.expiresAt>recoveryTime(tx));
      const latest=tx.get('SELECT max(version) version FROM reconciliation_evidence WHERE workflow_run_id=? AND logical_id=?',target.workflowRunId,e.logicalId);
      requireIntegrity(latest?.version===e.version);
    }
    const current=this.#host.outside(()=>this.#registry.get(v.verifierId));requireIntegrity(current.bindingDigest===v.bindingDigest&&current.binding.authorityDomain===this.#policy().authorityDomain&&!this.#host.outside(()=>this.#registry.isRevoked(v.verifierId,v.bindingDigest)));
    requireIntegrity(readReconciliationTarget(tx,target).targetDigest===v.targetDigest);
    this.#content(v,e,'OUTPUT');return v;
  }
  #context(tx:DurableTransaction,lease:WorkflowLease,actor:VerifiedRecoveryIdentity):ReconciliationOperationContext {
    return {db:this.#host.db,tx,lease,actor,policy:this.#policy(),policyRevision:this.#policyRevision,limits:this.#limits,
      authorize:(credential,target,permission,owner)=>this.#identity(tx,credential,target,permission,owner),
      checkAccess:(who,target,permission,owner)=>this.#access(who,target,permission,owner),
      validateVerification:(id,target,who=actor)=>this.#currentVerification(tx,id,target,who),
      validateAdoptedActionVerification:(id,target,who=actor)=>this.#currentVerification(tx,id,target,who,true),
      revalidateApproval:(actorId,source,target)=>{const credential=this.#credentials.get(`${source}\u0000${actorId}`);if(credential===undefined)throw new DurableStoreError('RECOVERY_UNAUTHENTICATED');const who=this.#identity(tx,credential,target,'APPROVE_RECONCILIATION');requireIntegrity(who.actorId===actorId&&who.source===source);return who;},
      write:this.#writer(tx,lease,actor.actorId)};
  }
  command(lease:WorkflowLease|undefined,credential:unknown,input:ReconciliationEvidenceCommand|ReconciliationOperationCommand):unknown {
    const command=reconciliationData(input,this.#limits.maxCandidateBytes+8192,this.#limits.maxDepth+4);
    const read=command.kind==='VIEW_EVIDENCE'||command.kind==='VIEW_EVIDENCE_BODY'||command.kind==='VIEW_VERIFICATION'||command.kind==='PREVIEW'||command.kind==='INSPECT'||command.kind==='RECEIPT'||command.kind==='RUNNER_CONTEXT';
    let draining:string[]=[];
    const handle=(tx:DurableTransaction)=>{
      if(command.kind==='INSPECT') {
        const target=validateReconciliationTarget(command.target);this.#identity(tx,credential,target,'VIEW_CASE');
        for(const row of tx.all('SELECT model_call_id target_id,attempt_id FROM model_call_ledger WHERE workflow_run_id=?',target.workflowRunId))this.#identity(tx,credential,{workflowRunId:target.workflowRunId,targetKind:'MODEL',targetId:String(row.target_id),attemptId:String(row.attempt_id)},'VIEW_CASE');
        for(const row of tx.all('SELECT action_id target_id,attempt_id FROM execution_ledger WHERE workflow_run_id=?',target.workflowRunId))this.#identity(tx,credential,{workflowRunId:target.workflowRunId,targetKind:'ACTION',targetId:String(row.target_id),attemptId:String(row.attempt_id)},'VIEW_CASE');
        for(const row of tx.all('SELECT verification_id FROM reconciliation_verifications WHERE workflow_run_id=? AND target_kind=? AND target_id=? AND attempt_id=?',target.workflowRunId,target.targetKind,target.targetId,target.attemptId)){const v=readReconciliationVerification(tx,String(row.verification_id)),e=readReconciliationEvidence(tx,v.evidenceId);const actor=this.#identity(tx,credential,target,'VIEW_CASE');this.#access(actor,target,'USE_EVIDENCE',e.evidenceOwnerId);this.#content(v.claim,e,'OUTPUT');}
        return inspectReconciliationInTransaction(tx,target);
      }
      if(command.kind==='RUNNER_CONTEXT') {
        if(!tx.get('SELECT operation_id FROM reconciled_action_outcomes WHERE workflow_run_id=? LIMIT 1',command.workflowRunId))return [];
        return reconciliationRunnerFacts(tx,command.workflowRunId,command.destination,this.#policy(),(target,permission,owner)=>this.#identity(tx,credential,target,permission,owner));
      }
      if(command.kind==='VIEW_EVIDENCE'||command.kind==='VIEW_EVIDENCE_BODY') {
        const e=readReconciliationEvidence(tx,command.evidenceId);this.#identity(tx,credential,e.target,command.kind==='VIEW_EVIDENCE_BODY'?'VIEW_EVIDENCE_BODY':'VIEW_CASE',e.evidenceOwnerId);
        if(command.kind==='VIEW_EVIDENCE')return e;const body=this.#body(tx,e);this.#content(body,e,'OUTPUT');return body;
      }
      if(command.kind==='VIEW_VERIFICATION')return this.#viewVerification(tx,command.verificationId,credential);
      if(command.kind==='SUBMIT_EVIDENCE') {
        requireIntegrity(lease);const x=command.input,target=validateReconciliationTarget(x.target);requireIntegrity(target.workflowRunId===lease.workflowRunId);
        const actor=this.#identity(tx,credential,target,'SUBMIT_EVIDENCE');readReconciliationTarget(tx,target);
        requireIntegrity(Object.keys(x).every(k=>['target','logicalId','body','dataClass','contentType'].includes(k))&&['application/json','text/plain'].includes(x.contentType)&&typeof x.dataClass==='string'&&/^[A-Za-z0-9_.:-]{1,80}$/.test(x.dataClass));
        if(x.contentType==='text/plain')requireIntegrity(typeof x.body==='string');
        const body=reconciliationData(x.body,this.#limits.maxCandidateBytes,this.#limits.maxDepth),bodyJson=canonicalJson(body),sizeBytes=Buffer.byteLength(bodyJson);
        this.#content(body,{target,dataClass:x.dataClass,evidenceOwnerId:actor.actorId},'ACCEPT');
        const count=tx.get('SELECT count(*) n,coalesce(sum(size_bytes),0) bytes FROM reconciliation_evidence WHERE workflow_run_id=?',target.workflowRunId)!;
        const logicalId=x.logicalId??`evidence-${digest([target,actor.actorId,x.dataClass,x.contentType,digest(body)])}`;requireIntegrity(/^[A-Za-z0-9_.:@/-]{1,160}$/.test(logicalId));
        const prior=tx.get('SELECT * FROM reconciliation_evidence WHERE workflow_run_id=? AND logical_id=? ORDER BY version DESC LIMIT 1',target.workflowRunId,logicalId);
        if(prior)requireIntegrity(prior.owner_id===actor.actorId&&prior.target_kind===target.targetKind&&prior.target_id===target.targetId&&prior.attempt_id===target.attemptId);
        if(prior&&prior.digest===digest(body)&&prior.data_class===x.dataClass&&prior.content_type===x.contentType)return readReconciliationEvidence(tx,String(prior.evidence_id));
        requireIntegrity(Number(count.n)<this.#limits.maxCandidatesPerWorkflow&&Number(count.bytes)+sizeBytes<=this.#limits.maxStoredBytesPerWorkflow);
        const e:ReconciliationEvidence={evidenceId:randomUUID(),logicalId,version:prior?Number(prior.version)+1:1,target,candidateDigest:digest(body),evidenceOwnerId:actor.actorId,submittedBy:actor.actorId,dataClass:x.dataClass,contentType:x.contentType,sizeBytes,createdAt:recoveryTime(tx)};
        const write=this.#writer(tx,lease,actor.actorId);write('reconciliation_evidence',{evidence_id:e.evidenceId,logical_id:e.logicalId,workflow_run_id:target.workflowRunId,target_kind:target.targetKind,target_id:target.targetId,attempt_id:target.attemptId,version:e.version,digest:e.candidateDigest,owner_id:e.evidenceOwnerId,submitted_by:e.submittedBy,data_class:e.dataClass,content_type:e.contentType,size_bytes:e.sizeBytes,created_at:e.createdAt});
        write('reconciliation_evidence_bodies',{evidence_id:e.evidenceId,workflow_run_id:target.workflowRunId,body_json:bodyJson});this.#audit(tx,lease,actor.actorId,'RECONCILIATION_EVIDENCE_SUBMITTED',e.evidenceId,digest(e));return e;
      }
      if(command.kind==='REVOKE_VERIFICATION') {
        requireIntegrity(lease);const v=readReconciliationVerification(tx,command.verificationId),e=readReconciliationEvidence(tx,v.evidenceId);requireIntegrity(v.target.workflowRunId===lease.workflowRunId);
        const actor=this.#identity(tx,credential,v.target,'VERIFY_EVIDENCE',e.evidenceOwnerId);this.#access(actor,v.target,'USE_EVIDENCE',e.evidenceOwnerId);
        requireIntegrity(this.#host.outside(()=>this.#registry.isRevoked(v.verifierId,v.bindingDigest)));
        recordVerificationRevocation(this.#context(tx,lease,actor),v);draining=this.#draining(tx,v.verificationId);return;
      }
      if(command.kind==='CANCEL_VERIFICATION') {
        requireIntegrity(lease);const job=tx.get('SELECT * FROM reconciliation_verification_jobs WHERE job_id=?',command.jobId);requireIntegrity(job&&job.workflow_run_id===lease.workflowRunId);
        const e=readReconciliationEvidence(tx,String(job.evidence_id)),actor=this.#identity(tx,credential,e.target,'VERIFY_EVIDENCE',e.evidenceOwnerId);
        requireIntegrity(job.status==='PENDING');this.#writer(tx,lease,actor.actorId)('reconciliation_verification_jobs',{...job,status:'CANCELLED'},job);this.#audit(tx,lease,actor.actorId,'RECONCILIATION_VERIFICATION_CANCELLED',command.jobId,digest({jobId:command.jobId}));return;
      }
      const target=command.kind==='CREATE_PLAN'?command.input.target:command.kind==='PREVIEW'?command.target:
        (()=>{const planId=command.kind==='REVOKE'?tx.get('SELECT plan_id FROM reconciliation_grants WHERE grant_id=?',command.grantId)?.plan_id:command.planId;
          const row=tx.get('SELECT plan_json FROM reconciliation_plans WHERE plan_id=?',String(planId));requireIntegrity(row);return parseJson<{target:ReconciliationTarget}>(row.plan_json).target;})();
      const permission=command.kind==='AUTHORIZE'?'APPROVE_RECONCILIATION':command.kind==='REVOKE'?'REVOKE_GRANT':command.kind==='EXECUTE'?'APPLY_RECONCILIATION':command.kind==='CREATE_PLAN'?'CREATE_RECONCILIATION_PLAN':'VIEW_CASE';
      const actor=this.#identity(tx,credential,target,permission);if(!read)requireIntegrity(lease&&target.workflowRunId===lease.workflowRunId);
      return persistReconciliationDecision(this.#context(tx,lease??{workflowRunId:target.workflowRunId} as WorkflowLease,actor),command);
    };
    if(read)return this.#host.outside(()=>this.#host.db.read(handle));if(!lease)throw new DurableStoreError('LEASE_FENCED');try{const result=this.#write(lease,handle);this.#host.notifyDrained(draining);return result;}catch(error){
      if(command.kind==='REVOKE_VERIFICATION'){try{const ids=this.#host.db.read(tx=>{const v=readReconciliationVerification(tx,command.verificationId),e=readReconciliationEvidence(tx,v.evidenceId);const actor=this.#identity(tx,credential,v.target,'VIEW_CASE');this.#access(actor,v.target,'USE_EVIDENCE',e.evidenceOwnerId);requireIntegrity(tx.get("SELECT dispute_id FROM reconciliation_disputes WHERE verification_id=? AND reason_code='TRUST_REVOKED'",v.verificationId));return this.#draining(tx,v.verificationId);});this.#host.notifyDrained(ids);return;}catch{}}throw error;}
  }
  async verify(lease:WorkflowLease|undefined,credential:unknown,input:VerifyReconciliationEvidence,signal?:AbortSignal):Promise<ReconciliationVerification> {
    if(!lease)throw new DurableStoreError('LEASE_FENCED');const x=reconciliationData(input,2048);requireIntegrity(Object.keys(x).length===2);
    if(callerAborted(signal))throw new DurableStoreError('RECOVERY_UNAUTHORIZED');
    const prepared=this.#write(lease,tx=>{
      const e=readReconciliationEvidence(tx,x.evidenceId);requireIntegrity(e.target.workflowRunId===lease.workflowRunId);
      const actor=this.#identity(tx,credential,e.target,'VERIFY_EVIDENCE',e.evidenceOwnerId);this.#access(actor,e.target,'USE_EVIDENCE',e.evidenceOwnerId);
      const registered=this.#host.outside(()=>this.#registry.get(x.verifierId));requireIntegrity(registered.binding.authorityDomain===this.#policy().authorityDomain&&!this.#host.outside(()=>this.#registry.isRevoked(x.verifierId,registered.bindingDigest)));
      const existing=tx.get('SELECT verification_id FROM reconciliation_verifications WHERE evidence_id=? AND verifier_id=? AND binding_digest=?',e.evidenceId,x.verifierId,registered.bindingDigest);
      if(existing)return {saved:String(existing.verification_id)};
      const current=readReconciliationTarget(tx,e.target),body=this.#body(tx,e);this.#content({body,targetSnapshot:current.targetSnapshot},e,'VERIFY');
      const now=recoveryTime(tx),jobs=tx.get("SELECT count(*) n FROM reconciliation_verification_jobs WHERE workflow_run_id=? AND status='PENDING' AND expires_at>?",e.target.workflowRunId,now)!;
      const total=tx.get('SELECT count(*) n FROM reconciliation_verification_jobs WHERE workflow_run_id=?',e.target.workflowRunId)!;
      requireIntegrity(Number(jobs.n)<this.#limits.maxConcurrentVerifications&&Number(total.n)<this.#limits.maxCandidatesPerWorkflow*4);
      const job:Row={job_id:randomUUID(),evidence_id:e.evidenceId,workflow_run_id:e.target.workflowRunId,status:'PENDING',created_at:now,expires_at:now+this.#limits.verificationTimeoutMs+this.#limits.collectionGraceMs,receipt_id:null};
      this.#writer(tx,lease,actor.actorId)('reconciliation_verification_jobs',job);this.#audit(tx,lease,actor.actorId,'RECONCILIATION_VERIFICATION_STARTED',String(job.job_id),digest({evidenceId:e.evidenceId,bindingDigest:registered.bindingDigest,targetDigest:current.targetDigest}));
      return {e,actor,registered,current,body,job};
    });
    if(prepared.saved){this.#host.notifyDrained(this.#host.db.read(tx=>this.#draining(tx,prepared.saved!)));return this.#host.db.read(tx=>this.#viewVerification(tx,prepared.saved!,credential));}
    const {e,registered,current,body,job}=prepared;requireIntegrity(e&&registered&&current&&job);
    const start=performance.now(),wall=Date.now(),controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;let aborted=false;let rejectCancellation:((error:DurableStoreError)=>void)|undefined;
    const cancelled=new Promise<never>((_,reject)=>{rejectCancellation=reject;});let committed:ReconciliationVerification|undefined;
    const cancel=()=>this.#host.outside(()=>{aborted=true;controller.abort();rejectCancellation?.(new DurableStoreError('RECOVERY_UNAUTHORIZED'));});
    try {
      if(signal)this.#host.outside(()=>EventTarget.prototype.addEventListener.call(signal,'abort',cancel,{once:true}));
      if(callerAborted(signal))cancel();
      // Recheck the entire payload's ACL immediately before releasing it to the verifier.
      this.#host.db.read(tx=>{const who=this.#identity(tx,credential,e.target,'VERIFY_EVIDENCE',e.evidenceOwnerId);this.#access(who,e.target,'USE_EVIDENCE',e.evidenceOwnerId);this.#content({body,targetSnapshot:current.targetSnapshot},e,'VERIFY');});
      const result=await this.#host.outside(()=>Promise.race([cancelled,
        (async()=>{let returned;try{if(aborted||callerAborted(signal))throw new DurableStoreError('RECOVERY_UNAUTHORIZED');returned=registered.binding.verify({target:e.target,targetDigest:current.targetDigest,targetSnapshot:current.targetSnapshot,evidenceId:e.evidenceId,evidenceVersion:e.version,candidateDigest:e.candidateDigest,body,signal:controller.signal});return await nativeVerifierPromise(returned);}catch{throw new DurableStoreError('RECOVERY_UNAUTHORIZED');}})(),
        new Promise<never>((_,reject)=>{timer=setTimeout(()=>{cancel();reject(new DurableStoreError('RECOVERY_UNAUTHORIZED'));},this.#limits.verificationTimeoutMs);})]));
      if(aborted||callerAborted(signal)||performance.now()-start>=this.#limits.verificationTimeoutMs||Date.now()-wall>=this.#limits.verificationTimeoutMs)throw new DurableStoreError('RECOVERY_UNAUTHORIZED');
      let draining:string[]=[];
      const saved=this.#write(lease,tx=>{
        const actor=this.#identity(tx,credential,e.target,'VERIFY_EVIDENCE',e.evidenceOwnerId);this.#access(actor,e.target,'USE_EVIDENCE',e.evidenceOwnerId);
        const actual=readReconciliationEvidence(tx,e.evidenceId),now=recoveryTime(tx),pending=tx.get('SELECT * FROM reconciliation_verification_jobs WHERE job_id=?',job.job_id);
        requireIntegrity(pending?.status==='PENDING'&&Number(pending.expires_at)>now&&canonicalJson(actual)===canonicalJson(e)&&!callerAborted(signal)&&!aborted&&performance.now()-start<this.#limits.verificationTimeoutMs);
        requireIntegrity(readReconciliationTarget(tx,e.target).targetDigest===current.targetDigest&&this.#host.outside(()=>this.#registry.get(x.verifierId)).bindingDigest===registered.bindingDigest&&!this.#host.outside(()=>this.#registry.isRevoked(x.verifierId,registered.bindingDigest)));
        this.#content({body:this.#body(tx,e),targetSnapshot:current.targetSnapshot},e,'VERIFY');const validated=validateVerifierResult(result,registered.binding,e.target,current.targetDigest,now,this.#limits);
        this.#content(validated.claim,e,'NORMALIZED');
        if(validated.claim.kind==='MODEL_USAGE'&&validated.claim.completeness==='COMPLETE') {const quote=parseJson<{pricingId:string}>(current.ledger.quote_json);requireIntegrity(validated.claim.pricingId===quote.pricingId);}
        const receipt={verificationId:randomUUID(),evidenceId:e.evidenceId,evidenceVersion:e.version,candidateDigest:e.candidateDigest,target:e.target,targetDigest:current.targetDigest,verifierId:x.verifierId,verifierContract:registered.binding.contractVersion,bindingDigest:registered.bindingDigest,status:validated.status,source:validated.source,sourceEffectKey:digest([validated.source,validated.claim.kind]),claim:validated.claim,claimDigest:digest(validated.claim),reasonCodes:validated.reasonCodes,verifiedAt:now,expiresAt:validated.expiresAt,verifiedBy:actor.actorId};
        const verification:ReconciliationVerification={...receipt,receiptDigest:digest(receipt)};reconciliationData(verification,this.#limits.maxReceiptBytes,this.#limits.maxDepth);
        const write=this.#writer(tx,lease,actor.actorId);write('reconciliation_verifications',{verification_id:verification.verificationId,evidence_id:e.evidenceId,evidence_version:e.version,workflow_run_id:e.target.workflowRunId,target_kind:e.target.targetKind,target_id:e.target.targetId,attempt_id:e.target.attemptId,verifier_id:x.verifierId,binding_digest:registered.bindingDigest,status:verification.status,claim_json:canonicalJson(verification.claim),source_effect_key:verification.sourceEffectKey,verified_at:now,expires_at:verification.expiresAt,receipt_json:canonicalJson(verification),digest:verification.receiptDigest});
        write('reconciliation_verification_jobs',{...pending,status:'COMPLETE',receipt_id:verification.verificationId},pending);this.#audit(tx,lease,actor.actorId,'RECONCILIATION_VERIFICATION_RECORDED',verification.verificationId,verification.receiptDigest);
        draining=recordVerifiedConflict(this.#context(tx,lease,actor),verification);return verification;
      });
      committed=saved;
      this.#host.notifyDrained(draining);
      return this.#host.db.read(tx=>this.#viewVerification(tx,saved.verificationId,credential));
    } catch(error) {
      if(committed)throw error instanceof DurableStoreError?error:new DurableStoreError('RECOVERY_UNAUTHORIZED');
      // A completed job/immutable receipt is the only recovery after a lost COMMIT ACK.
      let recovered:{v:ReconciliationVerification;ids:string[]}|undefined;
      try{recovered=this.#host.db.read(tx=>{const pending=tx.get('SELECT * FROM reconciliation_verification_jobs WHERE job_id=?',job.job_id);requireIntegrity(pending?.status==='COMPLETE'&&pending.receipt_id);const v=readReconciliationVerification(tx,String(pending.receipt_id));requireIntegrity(v.evidenceId===e.evidenceId&&v.verifierId===x.verifierId&&v.bindingDigest===registered.bindingDigest);return {v,ids:this.#draining(tx,v.verificationId)};});}catch{}
      if(recovered){this.#host.notifyDrained(recovered.ids);return this.#host.db.read(tx=>this.#viewVerification(tx,recovered!.v.verificationId,credential));}
      throw error instanceof DurableStoreError?error:new DurableStoreError('RECOVERY_UNAUTHORIZED');
    }
    finally {if(timer)clearTimeout(timer);if(signal)this.#host.outside(()=>EventTarget.prototype.removeEventListener.call(signal,'abort',cancel));this.#host.outside(()=>controller.abort());}
  }
}
export class ReconciliationEvidenceService {
  constructor(readonly database:DurableDatabase,readonly lease?:WorkflowLease){}
  submitCandidate(input:SubmitReconciliationEvidence,credential:unknown):ReconciliationEvidence {return this.database.reconciliationDecision(this.lease,credential,{kind:'SUBMIT_EVIDENCE',input}) as ReconciliationEvidence;}
  verify(input:VerifyReconciliationEvidence,credential:unknown,signal?:AbortSignal){return this.database.verifyReconciliationEvidence(this.lease,credential,input,signal);}
  readEvidence(evidenceId:string,credential:unknown):ReconciliationEvidence{return this.database.reconciliationDecision(this.lease,credential,{kind:'VIEW_EVIDENCE',evidenceId}) as ReconciliationEvidence;}
  readBody(evidenceId:string,credential:unknown):unknown{return this.database.reconciliationDecision(this.lease,credential,{kind:'VIEW_EVIDENCE_BODY',evidenceId});}
  readVerification(verificationId:string,credential:unknown):ReconciliationVerification{return this.database.reconciliationDecision(this.lease,credential,{kind:'VIEW_VERIFICATION',verificationId}) as ReconciliationVerification;}
  revokeVerification(verificationId:string,credential:unknown):void{this.database.reconciliationDecision(this.lease,credential,{kind:'REVOKE_VERIFICATION',verificationId});}
  cancelVerification(jobId:string,credential:unknown):void{this.database.reconciliationDecision(this.lease,credential,{kind:'CANCEL_VERIFICATION',jobId});}
}
