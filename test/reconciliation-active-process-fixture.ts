import { continuationFixture, content } from './continuation-fixture.ts';
import { signedSyntheticVerifier, syntheticSource, reconciliationContents, completeClaim } from './reconciliation-fixture.ts';
import { ReconciliationEvidenceService } from '../services/coordination/durable/reconciliationEvidenceStore.ts';
import { readReconciliationTarget } from '../services/coordination/durable/reconciliationVerifier.ts';
import type { ReconciliationPolicy, ReconciliationTarget } from '../services/coordination/durable/reconciliationTypes.ts';
import type { TestContext } from 'node:test';

/** A real bounded Invocation owns the pending synthetic model call. Verification
 * runs while its provider waits, with no positive reconciliation permission. */
export async function activeDispute(t:Pick<TestContext,'after'>,action:(context:{
  f:ReturnType<typeof continuationFixture>; synthetic:ReturnType<typeof signedSyntheticVerifier>;
  target:ReconciliationTarget; evidenceId:string; verify:()=>Promise<unknown>;
  before:ReturnType<typeof reconciliationContents>; aborts:()=>number;
})=>Promise<void>,location?:{dir:string;path:string}) {
  const synthetic=signedSyntheticVerifier();synthetic.binding.pricingIds=['synthetic-price-v1','test:1'];
  const policy:ReconciliationPolicy={version:'synthetic-policy:1',authorityDomain:syntheticSource.authorityDomain,approvals:{},canAccess:()=>true,inspectContent:()=>true};
  const f=continuationFixture(t,{},location,{policy,verifiers:{get:id=>id===synthetic.binding.verifierId?synthetic.binding:undefined}});
  let aborts=0,hookRan=false;
  f.hook(async request=>{
    hookRan=true;request.signal.addEventListener('abort',()=>{aborts++;},{once:true});
    const row=f.raw.prepare("SELECT * FROM model_call_ledger WHERE state='DISPATCH_INTENT'").get()!;
    const target:ReconciliationTarget={workflowRunId:'run',targetKind:'MODEL',targetId:String(row.model_call_id),attemptId:String(row.attempt_id)};
    const service=new ReconciliationEvidenceService(f.db,f.lease);
    const submit=(inputTokens:number)=>{
      const targetState=f.db.read(tx=>readReconciliationTarget(tx,target));
      const claim={...completeClaim(),pricingId:'test:1',usage:{llmCalls:1,inputTokens,outputTokens:1,estimatedCost:0}};
      return service.submitCandidate({target,contentType:'application/json',dataClass:'synthetic',body:synthetic.sign({target,targetDigest:targetState.targetDigest,
        source:{...syntheticSource,externalOperationId:'active-model-operation',effectUnit:'model-usage'},claim,status:'VERIFIED',reasonCodes:[],expiresAt:Date.now()+600000})},f.credential);
    };
    const first=submit(1);await service.verify({evidenceId:first.evidenceId,verifierId:synthetic.binding.verifierId},f.credential);
    const second=submit(2),before=reconciliationContents(f.raw);
    await action({f,synthetic,target,evidenceId:second.evidenceId,verify:()=>service.verify({evidenceId:second.evidenceId,verifierId:synthetic.binding.verifierId},f.credential),before,aborts:()=>aborts});
    return {value:{kind:'plan',artifact:content},usage:{llmCalls:1,inputTokens:1,outputTokens:1,estimatedCost:0},completeness:'COMPLETE'};
  });
  const plan=f.api().createPlan(f.input(),f.credential);
  const result=await f.api().startAuthorized(plan.planId,f.credential);
  if(!hookRan)throw Error('Active dispute fixture never reached the synthetic provider');
  return {f,synthetic,aborts,result};
}

export async function unknownInvocation(t:Pick<TestContext,'after'>) {
  const synthetic=signedSyntheticVerifier();synthetic.binding.pricingIds=['synthetic-price-v1','test:1'];
  const policy:ReconciliationPolicy={version:'synthetic-policy:1',authorityDomain:syntheticSource.authorityDomain,
    approvals:{SETTLE_VERIFIED_MODEL_USAGE:{minimumApprovers:1,forbidSelfApproval:true}},canAccess:()=>true,inspectContent:()=>true};
  const f=continuationFixture(t,{},undefined,{policy,verifiers:{get:id=>id===synthetic.binding.verifierId?synthetic.binding:undefined}});
  f.hook(async()=>{throw Error('Synthetic response unavailable');});
  const originalPlan=f.api().createPlan(f.input(),f.credential),initial=await f.api().startAuthorized(originalPlan.planId,f.credential);
  f.reacquire(); // New administrative generation establishes a Hold without restarting the stopped Invocation.
  const row=f.raw.prepare('SELECT * FROM model_call_ledger').get()!;
  const target:ReconciliationTarget={workflowRunId:'run',targetKind:'MODEL',targetId:String(row.model_call_id),attemptId:String(row.attempt_id)};
  const service=new ReconciliationEvidenceService(f.db,f.lease);
  const verify=async(claim:ReturnType<typeof completeClaim>,status:'VERIFIED'|'INCOMPLETE'='VERIFIED')=>{
    const state=f.db.read(tx=>readReconciliationTarget(tx,target));
    const evidence=service.submitCandidate({target,contentType:'application/json',dataClass:'synthetic',body:synthetic.sign({target,targetDigest:state.targetDigest,
      source:{...syntheticSource,externalOperationId:'completed-unknown-invocation',effectUnit:'model-usage'},claim:{...claim,pricingId:'test:1'},status,reasonCodes:[],expiresAt:Date.now()+600000})},f.credential);
    return service.verify({evidenceId:evidence.evidenceId,verifierId:synthetic.binding.verifierId},f.credential);
  };
  return {f,synthetic,originalPlan,initial,target,verify};
}
