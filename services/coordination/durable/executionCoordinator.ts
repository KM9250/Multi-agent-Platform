import { randomUUID } from 'node:crypto';
import type { CoordinationEvent, CoordinationSnapshot, CoordinationTask } from '../types';
import { findExhaustedBudget } from '../policy';
import type { RunnerClock, RunnerDurableExecution, RunnerExecutionResult, RunnerExecutorRegistry, RunnerPendingActionRecord } from '../runner/types';
import { validatePreparedRunnerAction, validateRunnerExecution } from '../runner/model';
import { createRunnerEvent } from '../runner/eventFactory';
import { evaluateRunnerActionRisk, parseRunnerActionRef } from '../runner/policyGuard';
import { runnerActionApproved, runnerEvidenceReviewReason, runnerSecurityReviewReason } from '../runner/dispatchGuard';
import { parseSecurityReviewRef } from '../runner/securityHold';
import { SqliteCoordinationRunnerStore } from './durableCoordinationStore';
import type { DurableTransaction } from './db';
import { SqliteRunnerPendingActionStore, validateAction, validateActionOwner } from './pendingActionStore';
import { SqliteRunnerEvidenceStore } from './evidenceStore';
import type { EvidenceOwner } from './evidenceStore';
import { readExecution } from './executionLedger';
import type { DurableExecutionInspection, DurableExecutionState } from './executionLedger';
import { canonicalJson, digest, DurableStoreError, guarded, requireIntegrity } from './integrity';
import { EXECUTION_LIMITS, executionJson, rejectEmbeddedCredentials } from './executionIntegrity';
import { readJournal } from './restore';
import { readExecutionResult, recordedResultEvent, validateExecutionEvidence, inspectUncertainStop } from './executionReader';

export class DurableExecutionCoordinator implements RunnerDurableExecution {
  readonly pendingActions: SqliteRunnerPendingActionStore;
  readonly evidenceStore: SqliteRunnerEvidenceStore;
  private readonly clock: RunnerClock;
  constructor(readonly store: SqliteCoordinationRunnerStore, readonly executors: RunnerExecutorRegistry,
    options: { evidenceStore?: SqliteRunnerEvidenceStore; clock?: RunnerClock } = {}) {
    requireIntegrity(store instanceof SqliteCoordinationRunnerStore && !!executors?.get);
    this.pendingActions = new SqliteRunnerPendingActionStore(store.database);
    this.evidenceStore = options.evidenceStore ?? new SqliteRunnerEvidenceStore(store.database, store.lease);
    requireIntegrity(this.evidenceStore.database === store.database);
    this.clock = options.clock ?? { now: Date.now };
  }
  private assertNoUnknownExecution(tx: DurableTransaction, id: string): void {
    const unknown = tx.get("SELECT action_id FROM execution_ledger WHERE workflow_run_id = ? AND (state = 'DISPATCH_RESERVED' OR (state = 'REVIEW_REQUIRED' AND review_reason <> 'SECURITY_REVIEW_REQUIRED'))", id);
    if (unknown) throw new DurableStoreError('EXECUTION_REVIEW_REQUIRED');
  }
  assertLease(id: string): void { this.store.assertLease(id); }
  assertCanPlan(id: string): void {
    this.assertLease(id);
    this.store.database.read(tx => { readJournal(tx, id); this.assertNoUnknownExecution(tx, id); });
  }
  validatePreparedAction(input: unknown, executorId: string) {
    executionJson(input, EXECUTION_LIMITS.action);
    const action = guarded('INTEGRITY_ERROR', () => validatePreparedRunnerAction(input, executorId));
    executionJson(action.payload, EXECUTION_LIMITS.action);
    rejectEmbeddedCredentials(action.payload);
    return action;
  }
  private now(): number { const now = this.clock.now(); requireIntegrity(Number.isFinite(now) && now >= 0); return now; }
  private owner(r: RunnerPendingActionRecord): EvidenceOwner { return { workflowRunId: r.workflowRunId, sessionId: r.sessionId, taskId: r.taskId, actionId: r.action.actionId }; }
  private record(tx: DurableTransaction, id: string, task: CoordinationTask): RunnerPendingActionRecord {
    const ref = parseRunnerActionRef(task.inputRefs); requireIntegrity(task.workflowRunId === id && ref);
    const record = this.pendingActions.getInTransaction(tx, id, ref.actionId); requireIntegrity(record);
    requireIntegrity(record.taskId === task.taskId && record.sessionId === task.sessionId && record.action.fingerprint === ref.fingerprint);
    return record;
  }
  registerAction(input: RunnerPendingActionRecord, expected: CoordinationSnapshot, sessionEvent: CoordinationEvent, taskEvent: CoordinationEvent): RunnerPendingActionRecord {
    const record = validateAction(input), action = record.action;
    // Identity is stable across a lost response. No replacement Action or Round is generated here.
    const registrationDigest = digest([record, expected.events.at(-1), expected.policy, sessionEvent, taskEvent]);
    return this.store.writeWorkflow(record.workflowRunId, tx => {
      let s = readJournal(tx, record.workflowRunId).snapshot;
      const prior = tx.get('SELECT * FROM pending_actions WHERE workflow_run_id = ? AND (action_id = ? OR task_id = ? OR session_id = ? OR round_key = ?)',
        record.workflowRunId, action.actionId, record.taskId, record.sessionId, String((sessionEvent.payload as { contextRef?: string }).contextRef ?? ''));
      if (prior) {
        requireIntegrity(prior.registration_digest === registrationDigest && prior.action_id === action.actionId);
        const saved = this.pendingActions.getInTransaction(tx, record.workflowRunId, action.actionId)!;
        requireIntegrity(canonicalJson(saved) === canonicalJson(record)); validateActionOwner(s, saved); readExecution(tx, saved);
        return saved;
      }
      requireIntegrity(s.run.status === 'RUNNING' && s.run.executionMode === 'supervised_autonomous'
        && s.run.runId === expected.run.runId && canonicalJson(s.policy) === canonicalJson(expected.policy));
      if (canonicalJson(s.events.at(-1)) !== canonicalJson(expected.events.at(-1))) throw new DurableStoreError('SEQUENCE_CONFLICT');
      requireIntegrity(!s.tasks[record.taskId] && !s.sessions[record.sessionId]
        && !Object.values(s.sessions).some(session => ['OPEN','SUSPENDED'].includes(session.state))
        && !Object.values(s.tasks).some(task => parseRunnerActionRef(task.inputRefs)?.actionId === action.actionId));
      const session = sessionEvent.payload as { sessionId: string; contextRef: string }, task = taskEvent.payload as CoordinationTask;
      requireIntegrity(sessionEvent.type === 'SessionStarted' && taskEvent.type === 'TaskAssigned'
        && sessionEvent.workflowRunId === record.workflowRunId && taskEvent.workflowRunId === record.workflowRunId
        && sessionEvent.sessionId === record.sessionId && taskEvent.sessionId === record.sessionId
        && session.sessionId === record.sessionId && task.taskId === record.taskId
        && typeof session.contextRef === 'string' && session.contextRef.startsWith('map.runner.v1:') && !!session.contextRef.slice('map.runner.v1:'.length).trim());
      tx.run('INSERT INTO pending_actions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        record.workflowRunId, record.sessionId, record.taskId, action.actionId, action.executorId, action.operation, action.actionClass,
        action.fingerprint, action.retrySafety, executionJson(action, EXECUTION_LIMITS.action), digest(action), 1, this.now(), session.contextRef, registrationDigest);
      s = this.store.appendInTransaction(tx, sessionEvent);
      s = this.store.appendInTransaction(tx, taskEvent);
      validateActionOwner(s, record);
      requireIntegrity(s.tasks[record.taskId].status === 'ASSIGNED');
      tx.run('INSERT INTO execution_ledger VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, ?, 1, NULL, NULL)',
        record.workflowRunId, record.sessionId, record.taskId, action.actionId, action.fingerprint, action.executorId, 'PREPARED', this.now());
      return record;
    });
  }
  /** Only this successful, acknowledged COMMIT permits the immediately following dispatch. */
  reserveDispatch(id: string, task: CoordinationTask): { record: RunnerPendingActionRecord; attemptId: string } {
    return this.store.writeWorkflow(id, tx => {
      const s = readJournal(tx, id).snapshot, r = this.record(tx, id, task);
      validateActionOwner(s, r);
      requireIntegrity(s.run.status === 'RUNNING' && s.run.executionMode === 'supervised_autonomous'
        && s.sessions[r.sessionId].state === 'OPEN' && s.tasks[r.taskId].status === 'ASSIGNED'
        && Object.values(s.sessions).filter(session => ['OPEN','SUSPENDED'].includes(session.state)).length === 1);
      requireIntegrity(!findExhaustedBudget(s.run.budget, s.run.usage, Math.max(0, this.now() - s.run.createdAt)));
      requireIntegrity(!runnerSecurityReviewReason(s) && !runnerEvidenceReviewReason(s));
      this.assertNoUnknownExecution(tx, id);
      const risk = evaluateRunnerActionRisk(s, r.action);
      requireIntegrity(risk !== 'DENY' && (risk !== 'NEEDS_USER' || runnerActionApproved(s, r.action)));
      requireIntegrity(this.executors.get(r.action.executorId)?.id === r.action.executorId);
      const row = readExecution(tx, r);
      if (row.state !== 'PREPARED') throw new DurableStoreError('EXECUTION_REVIEW_REQUIRED');
      const attemptId = randomUUID(), now = this.now();
      tx.run("UPDATE execution_ledger SET state = 'DISPATCH_RESERVED', attempt_id = ?, reserved_at = ?, updated_at = ? WHERE workflow_run_id = ? AND action_id = ? AND state = 'PREPARED'",
        attemptId, now, now, id, r.action.actionId);
      return { record: r, attemptId };
    });
  }
  async dispatch(id: string, task: CoordinationTask, signal?: AbortSignal): Promise<RunnerExecutionResult> {
    // A historical reservation is NEVER reused to authorize a new Executor call.
    this.assertLease(id);
    const saved = this.getResult(id, task);
    if (saved) return saved;
    if (signal?.aborted) throw new DurableStoreError('EXECUTION_REVIEW_REQUIRED');
    const { record, attemptId } = this.reserveDispatch(id, task);
    const executor = this.executors.get(record.action.executorId);
    requireIntegrity(executor?.id === record.action.executorId);
    this.assertLease(id); // Reservation COMMIT acknowledged; recheck immediately before the external boundary.
    return this.evidenceStore.withOwner(this.owner(record), async () => {
      let raw: unknown, result: RunnerExecutionResult | undefined;
      try {
        raw = await executor.execute(structuredClone(record.action), { workflowRunId: id, sessionId: task.sessionId, taskId: task.taskId, signal });
      } catch {
        result = { status: 'uncertain', summary: 'Executor outcome could not be established.', errorCode: 'RUNNER_EXECUTOR_OUTCOME_UNKNOWN' };
      }
      if (!result) {
        try {
          executionJson(raw, EXECUTION_LIMITS.result);
          result = validateRunnerExecution(raw);
        } catch {
          result = { status: 'uncertain', summary: 'Executor returned an invalid result.', errorCode: 'RUNNER_INVALID_EXECUTION_RESULT' };
        }
      }
      if (result.status === 'aborted') result = { ...result, status: 'uncertain', errorCode: result.errorCode ?? 'RUNNER_EXECUTION_ABORTED' };
      if (result.safetyHold) {
        const binding = parseSecurityReviewRef(result.safetyHold.reviewRef);
        if (binding?.workflowRunId !== id || binding.taskId !== task.taskId || !['failed','succeeded'].includes(result.status)) {
          result = { status: 'uncertain', summary: 'Invalid security review ownership.', errorCode: 'RUNNER_SECURITY_REVIEW_OWNER_INVALID' };
        }
      }
      try {
        if (!result.resultRef) result = { ...result, resultRef: await this.evidenceStore.put({ kind: 'runner.execution', content: result, createdAt: this.now() }) };
        return this.recordResult(id, task, attemptId, result);
      } catch (error) {
        // Never translate persistence faults into TaskFailed or another planning round.
        // Database errors retain the committed reservation. Semantic failures can be diagnosed durably.
        if (error instanceof DurableStoreError && !['DATABASE_ERROR','DATABASE_BUSY','INVALID_TRANSACTION','LEASE_FENCED'].includes(error.code)) {
          this.requireReview(id, task, 'RESULT_INTEGRITY_UNAVAILABLE');
        }
        throw error;
      }
    }, this.store.lease);
  }
  recordResult(id: string, task: CoordinationTask, attemptId: string, input: RunnerExecutionResult): RunnerExecutionResult {
    executionJson(input, EXECUTION_LIMITS.result);
    const result = guarded('INTEGRITY_ERROR', () => validateRunnerExecution(input));
    requireIntegrity(result.status !== 'aborted');
    if (result.safetyHold) {
      const binding = parseSecurityReviewRef(result.safetyHold.reviewRef);
      requireIntegrity(binding?.workflowRunId === id && binding.taskId === task.taskId);
    }
    return this.store.writeWorkflow(id, tx => {
      const r = this.record(tx, id, task), row = readExecution(tx, r);
      validateActionOwner(readJournal(tx, id).snapshot, r);
      requireIntegrity(row.state === 'DISPATCH_RESERVED' && row.attempt_id === attemptId && row.result_ref === null);
      validateExecutionEvidence(tx, r, result, this.evidenceStore);
      const json = executionJson(result, EXECUTION_LIMITS.result), resultDigest = digest(result), ref = `map.runner.result.v1:${randomUUID()}`;
      const review = result.status === 'uncertain' || !!result.safetyHold;
      tx.run('INSERT INTO execution_results VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)', ref, id, r.sessionId, r.taskId,
        r.action.actionId, r.action.fingerprint, r.action.executorId, attemptId, json, resultDigest, this.now());
      tx.run('UPDATE execution_ledger SET state = ?, result_ref = ?, result_digest = ?, updated_at = ?, review_reason = ? WHERE workflow_run_id = ? AND action_id = ?',
        review ? 'REVIEW_REQUIRED' : 'RESULT_RECORDED', ref, resultDigest, this.now(), review ? (result.safetyHold ? 'SECURITY_REVIEW_REQUIRED' : 'EXECUTION_UNCERTAIN') : null, id, r.action.actionId);
      return result;
    });
  }
  requireReview(id: string, task: CoordinationTask, reason: 'RESULT_INTEGRITY_UNAVAILABLE' | 'EXECUTION_UNCERTAIN'): void {
    this.store.writeWorkflow(id, tx => {
      const r = this.record(tx, id, task), row = readExecution(tx, r);
      requireIntegrity(row.state === 'DISPATCH_RESERVED');
      tx.run("UPDATE execution_ledger SET state = 'REVIEW_REQUIRED', review_reason = ?, updated_at = ? WHERE workflow_run_id = ? AND action_id = ?", reason, this.now(), id, r.action.actionId);
    });
  }
  getResult(id: string, task: CoordinationTask): RunnerExecutionResult | undefined {
    return this.store.database.read(tx => {
      const r = this.record(tx, id, task); validateActionOwner(readJournal(tx, id).snapshot, r);
      const row = readExecution(tx, r), result = readExecutionResult(tx, r, this.evidenceStore);
      if (!result && row.state !== 'PREPARED') throw new DurableStoreError('EXECUTION_REVIEW_REQUIRED');
      return result;
    });
  }
  finalizeResult(id: string, task: CoordinationTask): void {
    this.store.writeWorkflow(id, tx => {
      const s = readJournal(tx, id).snapshot, r = this.record(tx, id, task); validateActionOwner(s, r);
      const row = readExecution(tx, r), result = readExecutionResult(tx, r, this.evidenceStore); requireIntegrity(result);
      const event = recordedResultEvent(s, r, result, this.clock);
      if (row.finalized_event_id) {
        const existing = s.events.find(e => e.eventId === row.finalized_event_id);
        requireIntegrity(existing && existing.eventId === event.eventId && existing.type === event.type && existing.sessionId === event.sessionId
          && existing.actorAgentId === event.actorAgentId && existing.idempotencyKey === event.idempotencyKey
          && canonicalJson(existing.payload) === canonicalJson(event.payload));
        return;
      }
      requireIntegrity(['RESULT_RECORDED','REVIEW_REQUIRED'].includes(String(row.state)) && s.run.status === 'RUNNING'
        && s.sessions[r.sessionId].state === 'OPEN' && s.tasks[r.taskId].status === 'ASSIGNED');
      this.store.appendInTransaction(tx, event);
      tx.run('UPDATE execution_ledger SET state = ?, finalized_event_id = ?, updated_at = ? WHERE workflow_run_id = ? AND action_id = ?',
        row.state === 'REVIEW_REQUIRED' ? 'REVIEW_REQUIRED' : 'FINALIZED', event.eventId, this.now(), id, r.action.actionId);
    });
  }
  /** Complete only a committed uncertain Task failure. Never dispatch, resume, or change its Ledger. */
  completeUncertainBlock(id: string): { reason: string; progressRecorded: boolean } | undefined {
    return this.store.writeWorkflow(id, tx => {
      let s = readJournal(tx, id).snapshot;
      if (s.run.status !== 'RUNNING') return;
      requireIntegrity(!runnerSecurityReviewReason(s) && !runnerEvidenceReviewReason(s));
      const rows = tx.all("SELECT action_id FROM execution_ledger WHERE workflow_run_id = ? AND state = 'REVIEW_REQUIRED' AND review_reason = 'EXECUTION_UNCERTAIN'", id);
      requireIntegrity(rows.length <= 1);
      if (!rows.length) return;
      const r = this.pendingActions.getInTransaction(tx, id, String(rows[0].action_id)); requireIntegrity(r);
      validateActionOwner(s, r);
      const row = readExecution(tx, r), result = readExecutionResult(tx, r, this.evidenceStore);
      requireIntegrity(result?.status === 'uncertain' && !result.safetyHold);
      const prefix = inspectUncertainStop(tx, s, r, row, result, this.clock);
      if (!prefix) return;
      let { reason, resolved, progress, block, resolveKey, progressKey, blockKey, failed, resolvePayload, progressPayload } = prefix;
      if (block) return { reason, progressRecorded: false };
      const append = (type: CoordinationEvent['type'], payload: unknown, idempotencyKey: string, sessionId?: string): CoordinationEvent => {
        const event = createRunnerEvent(s, type, payload, { now: () => this.now() },
          { nextId: () => `durable-uncertain-${digest([id, r.action.actionId, type])}` }, { sessionId, idempotencyKey });
        const count = s.events.length;
        s = this.store.appendInTransaction(tx, event);
        requireIntegrity(s.events.length === count + 1);
        return event;
      };
      if (!resolved) resolved = append('SessionResolved', resolvePayload, resolveKey, r.sessionId);
      const progressRecorded = !progress;
      if (!progress) progress = append('ProgressRecorded', progressPayload, progressKey);
      block = append('WorkflowBlocked', { reason }, blockKey);
      requireIntegrity(['BLOCKED'].includes(s.run.status) && s.run.statusReason === reason
        && s.sessions[r.sessionId].state === 'RESOLVED' && failed.sequence < resolved.sequence
        && resolved.sequence < progress.sequence && progress.sequence < block.sequence);
      return { reason, progressRecorded };
    });
  }
  async getOwnedEvidence(id: string, task: CoordinationTask, ref: string) {
    return this.store.database.read(tx => {
      const r = this.record(tx, id, task); validateActionOwner(readJournal(tx, id).snapshot, r);
      return this.evidenceStore.getOwnedInTransaction(tx, this.owner(r), ref);
    });
  }
  inspectExecution(id: string, actionId: string): DurableExecutionInspection | undefined {
    return this.store.database.read(tx => {
      const r = this.pendingActions.getInTransaction(tx, id, actionId); if (!r) return;
      const s = readJournal(tx, id).snapshot; validateActionOwner(s, r);
      const row = readExecution(tx, r), result = readExecutionResult(tx, r, this.evidenceStore);
      return { taskStatus: s.tasks[r.taskId].status, workflowStatus: s.run.status, sessionState: s.sessions[r.sessionId].state,
        roundKey: s.sessions[r.sessionId].contextRef!, journalCursor: s.events.at(-1)!.sequence, ...this.owner(r), fingerprint: r.action.fingerprint, executorId: r.action.executorId,
        state: row.state as DurableExecutionState, attemptId: row.attempt_id as string ?? undefined,
        reservedAt: row.reserved_at as number ?? undefined, resultRef: row.result_ref as string ?? undefined,
        resultDigest: row.result_digest as string ?? undefined, reviewReason: row.review_reason as string ?? undefined,
        finalizedEventId: row.finalized_event_id as string ?? undefined, updatedAt: Number(row.updated_at), result,
        dispatchMayHaveOccurred: row.state !== 'PREPARED' };
    });
  }
}
