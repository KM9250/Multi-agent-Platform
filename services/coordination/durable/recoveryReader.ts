import type { CoordinationSnapshot } from '../types';
import { parseRunnerActionRef, runnerPendingApproval } from '../runner/policyGuard';
import { runnerActionApproved, runnerEvidenceReviewReason, runnerSecurityReviewReason } from '../runner/dispatchGuard';
import { parseVerifyEvidenceReviewRef, VERIFY_EVIDENCE_BLOCK_PREFIX } from '../runner/verifyEvidenceReview';
import type { DurableDatabase } from './db';
import { SqliteCoordinationRunnerStore } from './durableCoordinationStore';
import { SqliteRunnerPendingActionStore, validateActionOwner } from './pendingActionStore';
import { SqliteRunnerEvidenceStore } from './evidenceStore';
import { readExecution } from './executionLedger';
import type { DurableExecutionState } from './executionLedger';
import { executionOwner, inspectUncertainStop, readExecutionResult, recordedResultEvent } from './executionReader';
import { canonicalJson, DurableStoreError, requireIntegrity } from './integrity';
import { classifyRecovery } from './recoveryClassifier';
import { assertRecoverySchema, validateAuditRow } from './recoveryAudit';
import { RecoveryAuditReader } from './recoveryTimeline';
import type { ExecutionStateSummary, RecoveryAuthorizationRequirement, RecoveryInspection, TimelineQueryOptions } from './recoveryTypes';

/** No Runner, Coordinator, registry, model provider, or execution capability is accepted. */
export class RecoveryReader {
  private readonly store: SqliteCoordinationRunnerStore;
  private readonly actions: SqliteRunnerPendingActionStore;
  private readonly evidence: SqliteRunnerEvidenceStore;
  private readonly audit: RecoveryAuditReader;
  constructor(readonly database: DurableDatabase, private readonly clock = { now: Date.now }) {
    this.store = new SqliteCoordinationRunnerStore(database);
    this.actions = new SqliteRunnerPendingActionStore(database);
    this.evidence = new SqliteRunnerEvidenceStore(database);
    this.audit = new RecoveryAuditReader(database);
  }
  inspect(workflowRunId: string): RecoveryInspection {
    const inspectedAt = this.clock.now();
    requireIntegrity(typeof workflowRunId === 'string' && !!workflowRunId.trim() && Number.isFinite(inspectedAt) && inspectedAt >= 0);
    let snapshot: CoordinationSnapshot | undefined, reason = 'JOURNAL_INVALID';
    const executions: ExecutionStateSummary[] = [];
    try {
      return this.database.read(tx => {
        assertRecoverySchema(tx);
        snapshot = this.store.restoreWorkflowInTransaction(tx, workflowRunId);
        const s = snapshot;
        const authorizationRequirements: RecoveryAuthorizationRequirement[] = [];
        reason = 'EXECUTION_INTEGRITY_INVALID';
        const actions = tx.all('SELECT action_id FROM pending_actions WHERE workflow_run_id = ? ORDER BY action_id', workflowRunId);
        const ledgers = tx.all('SELECT action_id FROM execution_ledger WHERE workflow_run_id = ?', workflowRunId);
        requireIntegrity(actions.length === ledgers.length);
        const ownedTasks = new Set<string>();
        for (const item of actions) {
          const r = this.actions.getInTransaction(tx, workflowRunId, String(item.action_id)); requireIntegrity(r);
          validateActionOwner(s, r);
          const row = readExecution(tx, r), task = s.tasks[r.taskId], session = s.sessions[r.sessionId];
          const savedAction = tx.get('SELECT round_key FROM pending_actions WHERE workflow_run_id = ? AND action_id = ?', workflowRunId, r.action.actionId);
          requireIntegrity(savedAction?.round_key === session.contextRef);
          const result = readExecutionResult(tx, r, this.evidence);
          if (result?.safetyHold) authorizationRequirements.push({ kind: 'SECURITY_REVIEW', reference: result.safetyHold.reviewRef,
            effectState: result.safetyHold.effectState, satisfied: !runnerSecurityReviewReason(s) && row.finalized_event_id !== null });
          const approval = runnerPendingApproval(workflowRunId, r.action);
          if (s.events.some(event => event.type === 'WorkflowBlocked' && (event.payload as { reason?: string }).reason === `RUNNER_NEEDS_USER:${approval.approvalRef}`)) {
            authorizationRequirements.push({ kind: 'ACTION_APPROVAL', reference: approval.approvalRef, satisfied: runnerActionApproved(s, r.action) });
          }
          const results = tx.all('SELECT result_ref FROM execution_results WHERE workflow_run_id = ? AND action_id = ?', workflowRunId, r.action.actionId);
          requireIntegrity(results.length === (row.result_ref === null ? 0 : 1) && (!results.length || results[0].result_ref === row.result_ref));
          // Evidence saved before a crash can legitimately be unreferenced by a Result.
          for (const evidence of tx.all('SELECT evidence_ref FROM runner_evidence WHERE workflow_run_id = ? AND action_id = ?', workflowRunId, r.action.actionId)) {
            requireIntegrity(this.evidence.getOwnedInTransaction(tx, executionOwner(r), String(evidence.evidence_ref)));
          }
          if (row.finalized_event_id !== null) {
            requireIntegrity(result);
            const expected = recordedResultEvent(s, r, result, { now: () => inspectedAt });
            const event = s.events.find(e => e.eventId === row.finalized_event_id);
            requireIntegrity(event && event.eventId === expected.eventId && event.type === expected.type && event.sessionId === expected.sessionId
              && event.actorAgentId === expected.actorAgentId && event.idempotencyKey === expected.idempotencyKey
              && canonicalJson(event.payload) === canonicalJson(expected.payload)
              && task.status === (event.type === 'TaskCompleted' ? 'COMPLETED' : 'FAILED'));
          } else if (['RESULT_RECORDED','DISPATCH_RESERVED'].includes(String(row.state))) {
            requireIntegrity(task.status === 'ASSIGNED' || s.run.status === 'CANCELLED' && task.status === 'CANCELLED');
          }
          let safetyStopIncomplete = false;
          if (row.review_reason === 'EXECUTION_UNCERTAIN' && result) {
            requireIntegrity(result.status === 'uncertain' && !result.safetyHold);
            const stop = inspectUncertainStop(tx, s, r, row, result, { now: () => inspectedAt });
            safetyStopIncomplete = !stop?.block;
          }
          executions.push({ actionId: r.action.actionId, sessionId: r.sessionId, taskId: r.taskId,
            state: row.state as DurableExecutionState, taskStatus: task.status, sessionState: session.state,
            reviewReason: row.review_reason as string ?? undefined, finalizedEventId: row.finalized_event_id as string ?? undefined, safetyStopIncomplete });
          ownedTasks.add(r.taskId);
        }
        for (const task of Object.values(s.tasks)) {
          const ref = parseRunnerActionRef(task.inputRefs);
          if (ref && actions.some(a => a.action_id === ref.actionId)) requireIntegrity(ownedTasks.has(task.taskId));
        }
        requireIntegrity(!tx.get('SELECT r.action_id FROM runner_evidence r LEFT JOIN pending_actions p ON p.workflow_run_id = r.workflow_run_id AND p.action_id = r.action_id WHERE r.workflow_run_id = ? AND p.action_id IS NULL LIMIT 1', workflowRunId));
        requireIntegrity(!tx.get('SELECT r.action_id FROM execution_results r LEFT JOIN pending_actions p ON p.workflow_run_id = r.workflow_run_id AND p.action_id = r.action_id WHERE r.workflow_run_id = ? AND p.action_id IS NULL LIMIT 1', workflowRunId));
        requireIntegrity(Object.values(s.sessions).filter(session => ['OPEN','SUSPENDED'].includes(session.state)).length <= 1);
        reason = 'AUDIT_INTEGRITY_INVALID';
        requireIntegrity(!tx.get('SELECT audit_sequence FROM runtime_audit_events WHERE workflow_run_id = ? AND audit_sequence <= 0 LIMIT 1', workflowRunId));
        let after = 0;
        for (;;) {
          const rows = tx.all('SELECT * FROM runtime_audit_events WHERE workflow_run_id = ? AND audit_sequence > ? ORDER BY audit_sequence LIMIT 100', workflowRunId, after);
          for (const row of rows) { requireIntegrity(Number(row.audit_sequence) > after); validateAuditRow(tx, row); after = Number(row.audit_sequence); }
          if (rows.length < 100) break;
        }
        const evidenceBlock = [...s.events].reverse().find(event => event.type === 'WorkflowBlocked'
          && (event.payload as { reason?: string }).reason?.startsWith(VERIFY_EVIDENCE_BLOCK_PREFIX));
        if (evidenceBlock) {
          const reference = (evidenceBlock.payload as { reason: string }).reason.slice(VERIFY_EVIDENCE_BLOCK_PREFIX.length);
          const owner = parseVerifyEvidenceReviewRef(reference);
          if (owner?.workflowRunId === workflowRunId && s.tasks[owner.taskId]) authorizationRequirements.push({ kind: 'EVIDENCE_REVIEW', reference, satisfied: !runnerEvidenceReviewReason(s) });
        }
        if (['BLOCKED','SUSPENDED'].includes(s.run.status)) authorizationRequirements.push({ kind: 'EXPLICIT_RESUME', satisfied: false });
        return classifyRecovery({ workflowRunId, inspectedAt, snapshot: s, executions, authorizationRequirements,
          missingHistoricalLedger: Object.values(s.tasks).some(task => !ownedTasks.has(task.taskId)),
          unresolvedSecurityReview: !!runnerSecurityReviewReason(s)
            || executions.some(e => e.reviewReason === 'SECURITY_REVIEW_REQUIRED' && !e.finalizedEventId),
          unresolvedEvidenceReview: !!runnerEvidenceReviewReason(s) });
      });
    } catch (error) {
      if (!(error instanceof DurableStoreError) || ['DATABASE_ERROR','DATABASE_BUSY','SCHEMA_UNSUPPORTED','INVALID_TRANSACTION'].includes(error.code)) throw error;
      return classifyRecovery({ workflowRunId, inspectedAt, snapshot, executions: [],
        integrityReason: error.code === 'WORKFLOW_NOT_FOUND' ? 'WORKFLOW_NOT_FOUND' : reason });
    }
  }
  /** IDs are enumerated first; each Workflow gets its own consistent read transaction.
   * This is not a simultaneous database-wide Snapshot. Global DB errors propagate.
   */
  inspectAll(): RecoveryInspection[] {
    const ids = this.database.read(tx => { assertRecoverySchema(tx); return tx.all('SELECT workflow_run_id FROM workflow_seeds ORDER BY workflow_run_id').map(row => String(row.workflow_run_id)); });
    return ids.map(id => this.inspect(id));
  }
  getWorkflowTimeline(id: string, options?: TimelineQueryOptions) { return this.audit.getWorkflowTimeline(id, options); }
  getActionHistory(id: string, actionId: string, options?: TimelineQueryOptions) { return this.audit.getActionHistory(id, actionId, options); }
}
