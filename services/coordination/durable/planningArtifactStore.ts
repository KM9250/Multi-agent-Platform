import type { DurableTransaction } from './db';
import type { PlanArtifact, PlanContent, PlanDraftResponse, ArtifactRef } from './continuationTypes';
import { digest, jsonCopy, parseJson, requireIntegrity } from './integrity';
import { executionJson, rejectEmbeddedCredentials } from './executionIntegrity';

const textFields=['objective','conclusion','rationale','impact'] as const;
const listFields=['steps','assumptions','alternatives','risks','unknowns','requiredApprovals','changeTargets','validation','notPerformed'] as const;
export function validateDraft(input: unknown): PlanDraftResponse {
  executionJson(input,96*1024);rejectEmbeddedCredentials(input);
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
    && r.model_call_id===a.modelCallId && r.owner_id===a.ownerId);
  validateDraft({kind:'plan',artifact:a.content});return a;
}
