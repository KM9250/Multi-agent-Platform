import type { CoordinationEvent } from '../types';
import type { RunnerExecutionResult } from '../runner/types';
import type { DurableTransaction, Row } from './db';
import type { ReconciliationOperationContext, ReconciliationTarget } from './reconciliationTypes';
import { appendEvent } from '../kernel';
import { validateCoordinationSnapshot } from '../validation';
import { validateRunnerExecution } from '../runner/model';
import { runnerActionApproved, runnerEvidenceReviewReason, runnerSecurityReviewReason } from '../runner/dispatchGuard';
import { evaluateRunnerActionRisk } from '../runner/policyGuard';
import { readPendingActionInTransaction, validateActionOwner } from './pendingActionStore';
import { readOwnedEvidenceInTransaction } from './evidenceStore';
import { recordedResultEvent } from './executionReader';
import { canonicalJson, digest, guarded, parseJson, requireIntegrity } from './integrity';
import { nextAnchor, readJournal } from './restore';

export const reconciledResultRef = (operationId:string) => `map.reconciliation.result.v1:${operationId}`;

/** Result content is a verified claim. Its durable reference is host-generated;
 * client references cannot redirect the result to another target. */
export function normalizeReconciledResult(tx:DurableTransaction,target:ReconciliationTarget,operationId:string,input:RunnerExecutionResult):RunnerExecutionResult {
  const record=readPendingActionInTransaction(tx,target.workflowRunId,target.targetId);requireIntegrity(record);
  const checked=guarded('INTEGRITY_ERROR',()=>validateRunnerExecution(input));
  requireIntegrity(['succeeded','failed'].includes(checked.status)&&!checked.safetyHold);
  const owner={workflowRunId:target.workflowRunId,sessionId:record.sessionId,taskId:record.taskId,actionId:target.targetId};
  // Preserve only actual, owned evidence references. A supplied result reference
  // is also evidence and must be owned; no arbitrary URL/path is dereferenced.
  const refs=[...new Set([...(checked.resultRef?[checked.resultRef]:[]),...(checked.evidenceRefs??[])])];
  for(const ref of refs)requireIntegrity(readOwnedEvidenceInTransaction(tx,owner,ref));
  return {...checked,resultRef:reconciledResultRef(operationId),evidenceRefs:refs};
}

export function inspectReconciledActionApplication(tx:DurableTransaction,target:ReconciliationTarget,outcome:Row,now:number) {
  const journal=readJournal(tx,target.workflowRunId),snapshot=journal.snapshot;
  const record=readPendingActionInTransaction(tx,target.workflowRunId,target.targetId);requireIntegrity(record);
  validateActionOwner(snapshot,record);
  requireIntegrity(outcome.workflow_run_id===target.workflowRunId&&outcome.action_id===target.targetId&&outcome.attempt_id===target.attemptId
    &&['EXECUTED_FINAL','NOT_EXECUTED_FINAL'].includes(String(outcome.outcome_kind))&&outcome.result_json);
  const result=parseJson<RunnerExecutionResult>(outcome.result_json);
  requireIntegrity(canonicalJson(validateRunnerExecution(result))===canonicalJson(result)&&result.resultRef===reconciledResultRef(String(outcome.operation_id))
    &&['succeeded','failed'].includes(result.status)&&!result.safetyHold);
  if(outcome.outcome_kind==='NOT_EXECUTED_FINAL')requireIntegrity(result.status==='failed');
  const owner={workflowRunId:target.workflowRunId,sessionId:record.sessionId,taskId:record.taskId,actionId:target.targetId};
  for(const ref of result.evidenceRefs??[])requireIntegrity(readOwnedEvidenceInTransaction(tx,owner,ref));
  requireIntegrity(snapshot.run.status==='RUNNING'&&snapshot.sessions[record.sessionId]?.state==='OPEN'&&snapshot.tasks[record.taskId]?.status==='ASSIGNED'
    &&!snapshot.events.some(e=>['TaskCompleted','TaskFailed','TaskCancelled'].includes(e.type)&&(e.payload as {taskId?:string}).taskId===record.taskId)
    &&!tx.get('SELECT operation_id FROM reconciled_action_applications WHERE workflow_run_id=? AND task_id=?',target.workflowRunId,record.taskId)
    &&!runnerSecurityReviewReason(snapshot)&&!runnerEvidenceReviewReason(snapshot));
  const risk=evaluateRunnerActionRisk(snapshot,record.action);
  requireIntegrity(risk!=='DENY'&&(risk!=='NEEDS_USER'||runnerActionApproved(snapshot,record.action)));
  const event=recordedResultEvent(snapshot,record,result,{now:()=>Math.max(now,snapshot.events.at(-1)!.timestamp)});
  const next=guarded('INVALID_EVENT',()=>appendEvent(snapshot,event));validateCoordinationSnapshot(next);
  return {record,result,event,next,journal};
}

/** Fixed single-event participant. The original execution ledger/result remain untouched. */
export function applyReconciledAction(context:ReconciliationOperationContext,target:ReconciliationTarget,outcome:Row,operationId:string,now:number):Row {
  const {tx}=context,{record,result,event,journal}=inspectReconciledActionApplication(tx,target,outcome,now);
  const application:Row={operation_id:operationId,workflow_run_id:target.workflowRunId,action_id:target.targetId,attempt_id:target.attemptId,
    outcome_operation_id:outcome.operation_id,task_id:record.taskId,event_id:event.eventId,result_ref:result.resultRef!,result_json:canonicalJson(result),result_digest:digest(result),created_at:now};
  context.write('reconciled_action_applications',application);
  const eventRow:Row={workflow_run_id:event.workflowRunId,sequence:event.sequence,event_id:event.eventId,event_type:event.type,
    session_id:event.sessionId??null,actor_agent_id:event.actorAgentId??null,event_timestamp:event.timestamp,idempotency_key:event.idempotencyKey??null,payload:canonicalJson(event),payload_digest:digest(event)};
  context.write('journal_events',eventRow);
  const seed=tx.get('SELECT * FROM workflow_seeds WHERE workflow_run_id=?',target.workflowRunId);requireIntegrity(seed);
  context.write('workflow_seeds',{...seed,last_sequence:event.sequence,journal_anchor:nextAnchor(journal.anchors.at(-1)!,event)},seed);
  return application;
}

export function validateReconciledApplicationHistory(tx:DurableTransaction,row:Row,events:CoordinationEvent[]):void {
  const result=parseJson<RunnerExecutionResult>(row.result_json);
  requireIntegrity(row.result_digest===digest(result)&&row.result_ref===result.resultRef&&row.result_ref===reconciledResultRef(String(row.outcome_operation_id)));
  const event=events.find(e=>e.eventId===row.event_id),record=readPendingActionInTransaction(tx,String(row.workflow_run_id),String(row.action_id));
  requireIntegrity(event&&record&&event.sessionId===record.sessionId&&row.task_id===record.taskId);
  const snapshot=readJournal(tx,String(row.workflow_run_id)).snapshot;
  const expected=recordedResultEvent(snapshot,record,result,{now:()=>event.timestamp});
  requireIntegrity(event.type===expected.type&&event.eventId===expected.eventId&&event.actorAgentId===expected.actorAgentId
    &&canonicalJson(event.payload)===canonicalJson(expected.payload)&&event.idempotencyKey===expected.idempotencyKey);
}
