import type { DurableDatabase } from './db';
import type { ContinuationInspection } from './continuationTypes';
/** Authenticated, persistent observations only. Neither inspection nor timeline grants execution. */
export class RecoveryContinuationReader {
  constructor(readonly database:DurableDatabase){}
  inspect(planId:string,credential:unknown):ContinuationInspection {
    return this.database.continuationDecision(undefined,credential,{kind:'INSPECT',planId}) as ContinuationInspection;
  }
  timeline(planId:string,credential:unknown):Array<{source:'BOUNDED'|'RUNTIME';sequence:number;kind:string;referenceId:string;recordedAt:number}> {
    const saved=this.inspect(planId,credential),id=saved.plan.workflowRunId,invocation=saved.invocation?.invocationId;
    return this.database.read(tx=>{
      const refs=new Set([planId,...(invocation?[invocation]:[]),...(saved.artifact?[saved.artifact.artifactId]:[]),...(saved.inputRequest?[saved.inputRequest.inputRequestId]:[])]);
      for(const r of tx.all('SELECT grant_id FROM recovery_continuation_grants WHERE plan_id=?',planId))refs.add(String(r.grant_id));
      for(const r of tx.all('SELECT receipt_id FROM recovery_continuation_receipts WHERE plan_id=?',planId))refs.add(String(r.receipt_id));
      for(const r of tx.all('SELECT step_id,target_id FROM recovery_invocation_steps WHERE invocation_id=?',invocation??'')){refs.add(String(r.step_id));refs.add(String(r.target_id));}
      if(saved.artifact)for(const r of tx.all('SELECT review_id FROM planning_reviews WHERE artifact_id=?',saved.artifact.artifactId))refs.add(String(r.review_id));
      const bounded=tx.all('SELECT * FROM bounded_audit WHERE workflow_run_id=? ORDER BY audit_id',id).filter(r=>refs.has(String(r.record_id)))
        .map(r=>({source:'BOUNDED' as const,sequence:Number(r.audit_id),kind:`${r.entity_table}:${r.operation}`,referenceId:String(r.record_id),recordedAt:Number(r.recorded_at)}));
      const runtime=tx.all('SELECT * FROM runtime_audit_events WHERE workflow_run_id=? ORDER BY audit_sequence',id).filter(r=>refs.has(String(r.model_call_id))||refs.has(String(r.action_id)))
        .map(r=>({source:'RUNTIME' as const,sequence:Number(r.audit_sequence),kind:String(r.event_kind),referenceId:String(r.model_call_id??r.action_id),recordedAt:Number(r.recorded_at)}));
      return [...bounded,...runtime].sort((a,b)=>a.recordedAt-b.recordedAt||a.sequence-b.sequence);
    });
  }
}
