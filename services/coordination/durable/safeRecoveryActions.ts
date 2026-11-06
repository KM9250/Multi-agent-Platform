import type { CoordinationEvent, CoordinationSnapshot } from '../types';
import type { RunnerExecutionResult, RunnerPendingActionRecord } from '../runner/types';
import { appendEvent } from '../kernel';
import { createRunnerEvent } from '../runner/eventFactory';
import { runnerActionApproved, runnerEvidenceReviewReason, runnerSecurityReviewReason } from '../runner/dispatchGuard';
import { evaluateRunnerActionRisk } from '../runner/policyGuard';
import type { DurableDatabase, DurableTransaction, Row } from './db';
import type { SqliteCoordinationRunnerStore } from './durableCoordinationStore';
import { SqliteRunnerPendingActionStore, readPendingActionInTransaction, validateActionOwner } from './pendingActionStore';
import { SqliteRunnerEvidenceStore, readOwnedEvidenceInTransaction } from './evidenceStore';
import { readExecution } from './executionLedger';
import { finalizeRecordedResultInTransaction, inspectUncertainStop, readExecutionResult, recordedResultEvent } from './executionReader';
import { canonicalJson, digest, guarded, requireIntegrity } from './integrity';
import { readJournal } from './restore';

export type SafeRecoveryActionKind = 'REFLECT_RECORDED_RESULT' | 'COMPLETE_SAFETY_STOP';
export interface SafeRecoveryActionInspection {
  record: RunnerPendingActionRecord;
  row: Row;
  result: RunnerExecutionResult;
  snapshot: CoordinationSnapshot;
  journalEvents: CoordinationEvent[];
  finalState: 'FINALIZED' | 'REVIEW_REQUIRED';
  finalizedEventId: string;
  timestamp: number;
}

/** Revalidate the saved action/result/evidence and final event without minting any scope.
 * Receipt inspection uses this after COMMIT and never calls an execution participant. */
export function readValidatedRecoveryActionReceipt(tx: DurableTransaction, snapshot: CoordinationSnapshot, actionId: string) {
  const record = readPendingActionInTransaction(tx, snapshot.run.runId, actionId);
  requireIntegrity(record);
  validateActionOwner(snapshot, record);
  const row = readExecution(tx, record);
  const result = readExecutionResult(tx, record, { getOwnedInTransaction: readOwnedEvidenceInTransaction });
  requireIntegrity(result && row.finalized_event_id);
  const expected = recordedResultEvent(snapshot, record, result, { now: () => snapshot.events.at(-1)!.timestamp });
  const event = snapshot.events.find(e => e.eventId === row.finalized_event_id);
  const completions = snapshot.events.filter(e => ['TaskCompleted','TaskFailed'].includes(e.type)
    && (e.payload as { taskId?: string }).taskId === record.taskId);
  requireIntegrity(event && completions.length === 1 && completions[0] === event && event.eventId === expected.eventId
    && event.type === expected.type && event.sessionId === record.sessionId && event.actorAgentId === expected.actorAgentId
    && event.idempotencyKey === expected.idempotencyKey && canonicalJson(event.payload) === canonicalJson(expected.payload)
    && snapshot.tasks[record.taskId].status === (event.type === 'TaskCompleted' ? 'COMPLETED' : 'FAILED'));
  return { record, row, result };
}

/** Effect-free eligibility and exact event preview. Saved timestamps keep Plan bindings stable. */
export function inspectSafeRecoveryAction(database: DurableDatabase, tx: DurableTransaction, workflowRunId: string,
  actionId: string, kind: SafeRecoveryActionKind): SafeRecoveryActionInspection {
  database.assertTransaction(tx);
  requireIntegrity(kind === 'REFLECT_RECORDED_RESULT' || kind === 'COMPLETE_SAFETY_STOP');
  const snapshot = readJournal(tx, workflowRunId).snapshot;
  const record = new SqliteRunnerPendingActionStore(database).getInTransaction(tx, workflowRunId, actionId);
  requireIntegrity(record);
  validateActionOwner(snapshot, record);
  const row = readExecution(tx, record);
  const result = readExecutionResult(tx, record, new SqliteRunnerEvidenceStore(database));
  requireIntegrity(result && !result.safetyHold && !runnerSecurityReviewReason(snapshot) && !runnerEvidenceReviewReason(snapshot));
  // Recovery approval does not replace the action's policy or user approval.
  const risk = evaluateRunnerActionRisk(snapshot, record.action);
  requireIntegrity(risk !== 'DENY' && (risk !== 'NEEDS_USER' || runnerActionApproved(snapshot, record.action)));
  const timestamp = Math.max(snapshot.events.at(-1)!.timestamp, Number(row.updated_at));
  const clock = { now: () => timestamp };
  const journalEvents: CoordinationEvent[] = [];
  const completions = snapshot.events.filter(e => (e.type === 'TaskCompleted' || e.type === 'TaskFailed')
    && (e.payload as { taskId?: string }).taskId === record.taskId);
  if (kind === 'REFLECT_RECORDED_RESULT') {
    requireIntegrity(row.state === 'RESULT_RECORDED' && !row.finalized_event_id
      && ['succeeded','failed'].includes(result.status) && completions.length === 0
      && snapshot.run.status === 'RUNNING' && snapshot.sessions[record.sessionId].state === 'OPEN'
      && snapshot.tasks[record.taskId].status === 'ASSIGNED');
    const event = recordedResultEvent(snapshot, record, result, clock);
    guarded('INTEGRITY_ERROR', () => appendEvent(snapshot, event));
    return { record, row, result, snapshot, journalEvents: [event], finalState: 'FINALIZED', finalizedEventId: event.eventId, timestamp };
  }

  requireIntegrity(row.state === 'REVIEW_REQUIRED' && row.review_reason === 'EXECUTION_UNCERTAIN'
    && result.status === 'uncertain' && snapshot.run.status === 'RUNNING');
  let provisional = snapshot;
  let inspectedRow = row;
  if (!row.finalized_event_id) {
    requireIntegrity(completions.length === 0 && snapshot.sessions[record.sessionId].state === 'OPEN'
      && snapshot.tasks[record.taskId].status === 'ASSIGNED');
    const failed = recordedResultEvent(provisional, record, result, clock);
    provisional = guarded('INTEGRITY_ERROR', () => appendEvent(provisional, failed));
    journalEvents.push(failed);
    inspectedRow = { ...row, finalized_event_id: failed.eventId };
  } else {
    requireIntegrity(completions.length === 1 && completions[0].eventId === row.finalized_event_id);
  }
  const prefix = inspectUncertainStop(tx, provisional, record, inspectedRow, result, clock);
  requireIntegrity(prefix && !prefix.block);
  // Only an exact committed prefix is eligible: interleaved work or a later resume
  // cannot be interpreted as the missing tail of this safety stop.
  const expectedPrefix = [prefix.failed, prefix.resolved, prefix.progress].filter((e): e is CoordinationEvent => !!e);
  requireIntegrity(canonicalJson(provisional.events.slice(prefix.failed.sequence - 1)) === canonicalJson(expectedPrefix));
  const append = (type: CoordinationEvent['type'], payload: unknown, idempotencyKey: string, sessionId?: string) => {
    const event = createRunnerEvent(provisional, type, payload, clock,
      { nextId: () => `durable-uncertain-${digest([workflowRunId, actionId, type])}` }, { sessionId, idempotencyKey });
    const count = provisional.events.length;
    provisional = guarded('INTEGRITY_ERROR', () => appendEvent(provisional, event));
    requireIntegrity(provisional.events.length === count + 1);
    journalEvents.push(event);
  };
  if (!prefix.resolved) append('SessionResolved', prefix.resolvePayload, prefix.resolveKey, record.sessionId);
  if (!prefix.progress) append('ProgressRecorded', prefix.progressPayload, prefix.progressKey);
  append('WorkflowBlocked', { reason: prefix.reason }, prefix.blockKey);
  requireIntegrity(provisional.run.status === 'BLOCKED' && provisional.run.statusReason === prefix.reason
    && provisional.sessions[record.sessionId].state === 'RESOLVED'
    && provisional.tasks[record.taskId].status === 'FAILED'
    && provisional.tasks[record.taskId].failureReason === 'EXECUTION_UNCERTAIN');
  return { record, row, result, snapshot, journalEvents, finalState: 'REVIEW_REQUIRED',
    finalizedEventId: prefix.failed.eventId, timestamp };
}

/** This closed participant performs only the inspected action operation. It cannot mint scope. */
export function applySafeRecoveryAction(store: SqliteCoordinationRunnerStore, tx: DurableTransaction, workflowRunId: string,
  actionId: string, kind: SafeRecoveryActionKind) {
  store.database.assertWorkflowWrite(tx, workflowRunId);
  const inspection = inspectSafeRecoveryAction(store.database, tx, workflowRunId, actionId, kind);
  const { record, row, journalEvents, finalizedEventId, timestamp } = inspection;
  if (!row.finalized_event_id) {
    const event = finalizeRecordedResultInTransaction(store, tx, record,
      new SqliteRunnerEvidenceStore(store.database), { now: () => timestamp });
    requireIntegrity(canonicalJson(event) === canonicalJson(journalEvents[0]));
  }
  for (const event of journalEvents) {
    if (event.eventId === finalizedEventId) continue;
    store.appendInTransaction(tx, event);
  }
  const after = readJournal(tx, workflowRunId).snapshot;
  const saved = readExecution(tx, record);
  requireIntegrity(saved.finalized_event_id === finalizedEventId && saved.state === inspection.finalState
    && canonicalJson(after.events.slice(inspection.snapshot.events.length)) === canonicalJson(journalEvents));
  return { finalizedEventId, journalEventIds: journalEvents.map(e => e.eventId), journalDigest: digest(journalEvents),
    state: inspection.finalState, resultRef: String(saved.result_ref), resultDigest: String(saved.result_digest) };
}
