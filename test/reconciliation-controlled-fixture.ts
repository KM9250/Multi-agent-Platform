import type { TestContext } from 'node:test';
import type { RunnerExecutionResult } from '../services/coordination/runner/types.ts';
import type { ReconciliationClaim, ReconciliationTarget, ReconciliationVerifierResult } from '../services/coordination/durable/reconciliationTypes.ts';
import { ReconciliationEvidenceService } from '../services/coordination/durable/reconciliationEvidenceStore.ts';
import { readReconciliationTarget } from '../services/coordination/durable/reconciliationVerifier.ts';
import { dispatchFixture } from './recovery-dispatch-fixture.ts';
import { signedSyntheticVerifier, syntheticSource, actionClaim } from './reconciliation-fixture.ts';

/** Real 4B-2A A/B transactions; the Executor waits until the test releases it.
 * Evidence is submitted through the public authenticated service while waiting. */
export async function controlledConflictFixture(t:Pick<TestContext,'after'>,location?:{path:string;dir:string},onExecute=()=>{}) {
  const synthetic=signedSyntheticVerifier();
  const cleanups:Array<()=>unknown>=[];
  const f=dispatchFixture({after:fn=>{cleanups.push(fn as ()=>unknown);}},{...location,reconciliation:{policy:{version:'synthetic-controlled-conflict:1',authorityDomain:syntheticSource.authorityDomain,
    approvals:{},canAccess:()=>true,inspectContent:()=>true},verifiers:{get:id=>id===synthetic.binding.verifierId?synthetic.binding:undefined}}});
  const plan=f.plan(),grant=f.authorize(plan);
  let entered!:()=>void,release!:(result:RunnerExecutionResult)=>void;
  const waiting=new Promise<void>(resolve=>{entered=resolve;}),response=new Promise<RunnerExecutionResult>(resolve=>{release=resolve;});
  f.hook(async()=>{onExecute();entered();return response;});
  const pending=f.execute(plan);
  t.after(async()=>{release({status:'uncertain',summary:'Synthetic fixture cleanup'});await pending.catch(()=>{});for(const cleanup of cleanups)await cleanup();});
  await waiting;
  const inspection=f.api().reader.inspectDispatch(plan.planId,f.credential),intent=inspection.intent!;
  const target:ReconciliationTarget={workflowRunId:intent.workflowRunId,targetKind:'ACTION',targetId:intent.actionId,attemptId:intent.attemptId};
  const evidence=new ReconciliationEvidenceService(f.db,f.lease);
  const submit=(claim:ReconciliationClaim=actionClaim(),overrides:Partial<ReconciliationVerifierResult>={})=>{
    const state=f.db.read(tx=>readReconciliationTarget(tx,target));
    return evidence.submitCandidate({target,contentType:'application/json',dataClass:'synthetic',body:synthetic.sign({target,targetDigest:state.targetDigest,
      source:{...syntheticSource,externalOperationId:'controlled-synthetic-effect',effectUnit:'action-effect'},claim,status:'VERIFIED',reasonCodes:[],expiresAt:Date.now()+600000,...overrides})},f.credential);
  };
  const verify=async(claim:ReconciliationClaim=actionClaim())=>{const candidate=submit(claim);return evidence.verify({evidenceId:candidate.evidenceId,verifierId:synthetic.binding.verifierId},f.credential);};
  return {f,synthetic,plan,grant,target,intent,evidence,submit,verify,pending,release};
}
