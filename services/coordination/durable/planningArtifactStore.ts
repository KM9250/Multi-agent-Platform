import type { DurableTransaction } from './db';
import type { PlanArtifact, PlanContent, PlanDraftResponse, ArtifactRef, PlanningInputRequest, PlanningReviewTarget } from './continuationTypes';
import { digest, jsonCopy, parseJson, requireIntegrity } from './integrity';
import { executionJson, rejectEmbeddedCredentials } from './executionIntegrity';
import { readWorkflowControl } from './recoveryHoldLifecycle';

export function assertPlanningTextSafe(text:string):void {
  requireIntegrity(!/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bsk-(?:proj-|live-)?[A-Za-z0-9_-]{24,}|\b(?:api[_-]?key|password|authorization)\s*[:=]\s*["']?[^\s"']{12,}|Bearer\s+[A-Za-z0-9_.-]{16,}/i.test(text));
}
const textFields=['objective','conclusion','rationale','impact'] as const;
const listFields=['steps','assumptions','alternatives','risks','unknowns','requiredApprovals','changeTargets','validation','notPerformed'] as const;
export function validateDraft(input: unknown): PlanDraftResponse {
  assertPlanningTextSafe(executionJson(input,96*1024));rejectEmbeddedCredentials(input);
  const r=jsonCopy(input) as PlanDraftResponse; requireIntegrity(r&&typeof r==='object');
  if(r.kind==='plan') {
    requireIntegrity(Object.keys(r).every(k=>['kind','artifact'].includes(k)));
    const p=r.artifact;requireIntegrity(p&&Object.keys(p).length===textFields.length+listFields.length
      && Object.keys(p).every(k=>[...textFields,...listFields].includes(k as keyof PlanContent)));
    for(const key of textFields) requireIntegrity(typeof p[key]==='string' && p[key].trim().length>0 && p[key].length<=16_384);
    for(const key of listFields) requireIntegrity(Array.isArray(p[key]) && p[key].length<=64 && p[key].every(v=>typeof v==='string'&&v.trim().length>0&&v.length<=8192));
  } else if(r.kind==='read_requests') {
    requireIntegrity(Object.keys(r).every(k=>['kind','requests'].includes(k)) && Array.isArray(r.requests)&&r.requests.length>0&&r.requests.length<=32);
    for(const q of r.requests) requireIntegrity(Object.keys(q).length===2 && typeof q.resourceId==='string'&&/^[a-f0-9]{64}$/.test(q.digest));
  } else {requireIntegrity(r.kind==='needs_input'&&Object.keys(r).every(k=>['kind','questions'].includes(k)) && Array.isArray(r.questions)&&r.questions.length>0&&r.questions.length<=20&&r.questions.every(v=>typeof v==='string'&&v.trim()&&v.length<=4096));}
  return r;
}
export function readArtifact(tx:DurableTransaction, ref:ArtifactRef):PlanArtifact {
  const r=tx.get('SELECT * FROM planning_artifacts WHERE artifact_id=?',ref.artifactId);requireIntegrity(r);
  const a=parseJson<PlanArtifact>(r.artifact_json);
  requireIntegrity(a.artifactId===ref.artifactId && a.version===ref.version && a.contentDigest===ref.contentDigest
    && r.content_digest===a.contentDigest && digest(a.content)===a.contentDigest && r.workflow_run_id===a.workflowRunId
    && r.model_call_id===a.modelCallId && r.owner_id===a.ownerId && r.version===a.version && r.invocation_id===a.invocationId);
  const call=tx.get('SELECT * FROM model_call_ledger WHERE workflow_run_id=? AND model_call_id=?',a.workflowRunId,a.modelCallId);
  const event=call&&tx.get('SELECT payload,event_type FROM journal_events WHERE workflow_run_id=? AND event_id=?',a.workflowRunId,call.application_event_id);
  requireIntegrity(call?.application_status==='APPLIED'&&event?.event_type==='PlanArtifactPublished');
  const published=parseJson<{payload:{referenceId:string;contentDigest:string}}>(event.payload);
  requireIntegrity(published.payload.referenceId===a.artifactId&&published.payload.contentDigest===a.contentDigest);
  assertPlanningTextSafe(executionJson(a,128*1024));rejectEmbeddedCredentials(a);
  validateDraft({kind:'plan',artifact:a.content});return a;
}

/** Single pending review, derived from immutable publication/review history in this transaction.
 * A revision keeps its predecessor pending until the new Artifact is atomically published.
 * Independent publications cannot start while a review is pending. Never fall back to an older Artifact.
 */
export function readPlanningReviewTarget(tx:DurableTransaction, workflowRunId:string):PlanningReviewTarget|undefined {
  const c=readWorkflowControl(tx,workflowRunId);if(!c.planning_review_pending)return;
  const r=tx.get('SELECT * FROM planning_artifacts WHERE workflow_run_id=? ORDER BY rowid DESC LIMIT 1',workflowRunId);requireIntegrity(r);
  const a=readArtifact(tx,{artifactId:String(r.artifact_id),version:Number(r.version),contentDigest:String(r.content_digest)});
  const review=tx.get('SELECT decision FROM planning_reviews WHERE artifact_id=? ORDER BY rowid DESC LIMIT 1',a.artifactId);
  requireIntegrity(!review||review.decision==='ACCEPTED_FOR_SCOPE');
  return {artifactId:a.artifactId,version:a.version,contentDigest:a.contentDigest,ownerId:a.ownerId,controlRevision:Number(c.control_revision)};
}

export function readPlanningInputRequest(tx:DurableTransaction, id:string):PlanningInputRequest {
  const r=tx.get('SELECT * FROM planning_input_requests WHERE input_request_id=?',id);requireIntegrity(r);
  const q=parseJson<PlanningInputRequest>(r.request_json);
  requireIntegrity(q.inputRequestId===id&&q.schemaVersion===1&&q.state==='AWAITING_INPUT'
    &&q.workflowRunId===r.workflow_run_id&&q.invocationId===r.invocation_id&&q.modelCallId===r.model_call_id
    &&q.ownerId===r.owner_id&&q.contentDigest===r.content_digest&&digest(q.questions)===q.contentDigest);
  assertPlanningTextSafe(executionJson(q,128*1024));rejectEmbeddedCredentials(q);
  validateDraft({kind:'needs_input',questions:q.questions});
  const i=tx.get('SELECT * FROM recovery_invocations WHERE workflow_run_id=? AND invocation_id=?',q.workflowRunId,q.invocationId);
  const p=i&&tx.get('SELECT * FROM recovery_continuation_plans WHERE workflow_run_id=? AND plan_id=?',q.workflowRunId,i.plan_id);
  requireIntegrity(i?.status==='STOPPED'&&i.outcome==='PLAN_INCOMPLETE'&&p?.operation==='PLANNING_ONLY'
    &&p.mode===q.mode&&p.created_by===q.ownerId&&p.request_id===q.requestId);
  const call=tx.get('SELECT * FROM model_call_ledger WHERE workflow_run_id=? AND model_call_id=?',q.workflowRunId,q.modelCallId);
  const event=call&&tx.get('SELECT payload,event_type FROM journal_events WHERE workflow_run_id=? AND event_id=?',q.workflowRunId,call.application_event_id);
  requireIntegrity(call?.application_status==='APPLIED'&&event?.event_type==='PlanningInputRequested');
  const published=parseJson<{payload:{referenceId:string;contentDigest:string;invocationId:string;modelCallId:string}}>(event.payload).payload;
  requireIntegrity(published.referenceId===id&&published.contentDigest===q.contentDigest&&published.invocationId===q.invocationId&&published.modelCallId===q.modelCallId);
  return q;
}
