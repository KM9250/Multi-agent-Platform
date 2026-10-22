import { randomUUID } from 'node:crypto';
import type { DurableDatabase, DurableTransaction, Row } from './db';
import { DurableStoreError, requireIntegrity } from './integrity';

const states = ['PREPARED','DISPATCH_RESERVED','RESULT_RECORDED','FINALIZED','REVIEW_REQUIRED'];
export function validExecutionTransition(previous: unknown, next: unknown): boolean {
  return previous === null && next === 'PREPARED' || previous === 'PREPARED' && next === 'DISPATCH_RESERVED'
    || previous === 'DISPATCH_RESERVED' && ['RESULT_RECORDED','REVIEW_REQUIRED'].includes(String(next))
    || previous === 'RESULT_RECORDED' && next === 'FINALIZED' || previous === 'REVIEW_REQUIRED' && next === 'REVIEW_REQUIRED';
}
export function assertRecoverySchema(tx: DurableTransaction): void {
  const rows = tx.all('SELECT schema_version, migration_id FROM schema_migrations ORDER BY schema_version');
  if (tx.get('SELECT user_version FROM pragma_user_version')?.user_version !== 3
    || rows.length !== 3 || rows[0].schema_version !== 1 || rows[1].schema_version !== 2
    || rows[0].migration_id !== '001_durable_coordination' || rows[1].migration_id !== '002_durable_execution'
    || rows[2].schema_version !== 3 || rows[2].migration_id !== '003_recovery_audit_foundation') throw new DurableStoreError('SCHEMA_UNSUPPORTED');
}
export function validateAuditRow(tx: DurableTransaction, row: Row): void {
  requireIntegrity(Number.isSafeInteger(row.audit_sequence) && Number(row.audit_sequence) > 0 && row.schema_version === 1);
  for (const key of ['audit_event_id','workflow_run_id','event_kind','entity_kind','entity_id']) requireIntegrity(typeof row[key] === 'string' && !!String(row[key]).trim());
  requireIntegrity(/^[A-Z][A-Z0-9_]{0,79}$/.test(String(row.event_kind))
    && ['WORKFLOW','SESSION','TASK','ACTION','RUNTIME'].includes(String(row.entity_kind)));
  requireIntegrity(typeof row.occurred_at === 'number' && Number.isFinite(row.occurred_at) && row.occurred_at >= 0
    && typeof row.recorded_at === 'number' && Number.isFinite(row.recorded_at) && row.recorded_at >= 0);
  for (const key of ['session_id','task_id','action_id','attempt_id','actor_agent_id','subject_agent_id','runtime_instance_id','previous_state','next_state','reason_code','journal_event_id']) {
    requireIntegrity(row[key] === null || typeof row[key] === 'string' && !!String(row[key]).trim() && String(row[key]).length <= 4096);
  }
  requireIntegrity(row.runtime_generation === null || Number.isSafeInteger(row.runtime_generation) && Number(row.runtime_generation) >= 0);
  requireIntegrity(row.reason_code === null || /^[A-Z][A-Z0-9_]{0,79}$/.test(String(row.reason_code)));
  for (const key of ['previous_state','next_state']) requireIntegrity(row[key] === null || /^[A-Z][A-Z0-9_]{0,79}$/.test(String(row[key])));
  requireIntegrity((row.journal_event_id === null) === (row.journal_sequence === null));
  if (row.journal_event_id !== null) {
    requireIntegrity(Number.isSafeInteger(row.journal_sequence) && Number(row.journal_sequence) > 0);
    const event = tx.get('SELECT * FROM journal_events WHERE workflow_run_id = ? AND event_id = ?', row.workflow_run_id, row.journal_event_id);
    requireIntegrity(event && event.sequence === row.journal_sequence);
  }
  if (row.session_id !== null) requireIntegrity(tx.get("SELECT sequence FROM journal_events WHERE workflow_run_id = ? AND session_id = ? AND event_type = 'SessionStarted'", row.workflow_run_id, row.session_id));
  if (row.task_id !== null) requireIntegrity(tx.get("SELECT sequence FROM journal_events WHERE workflow_run_id = ? AND session_id IS ? AND event_type = 'TaskAssigned' AND json_extract(payload, '$.payload.taskId') = ?", row.workflow_run_id, row.session_id, row.task_id));
  if (row.task_id !== null) {
    const task = tx.get("SELECT json_extract(payload, '$.payload.assigneeAgentId') AS agent FROM journal_events WHERE workflow_run_id = ? AND event_type = 'TaskAssigned' AND json_extract(payload, '$.payload.taskId') = ? ORDER BY sequence LIMIT 1", row.workflow_run_id, row.task_id);
    requireIntegrity(row.subject_agent_id === task?.agent || row.subject_agent_id === null && !['EXECUTION_CHANGED','JOURNAL_APPENDED'].includes(String(row.event_kind)));
  }
  if (row.action_id !== null) {
    const action = tx.get('SELECT * FROM pending_actions WHERE workflow_run_id = ? AND action_id = ?', row.workflow_run_id, row.action_id);
    requireIntegrity(action && action.session_id === row.session_id && action.task_id === row.task_id);
  }
  if (row.event_kind === 'JOURNAL_APPENDED') {
    requireIntegrity(row.journal_event_id !== null && row.action_id === null);
    const event = tx.get('SELECT * FROM journal_events WHERE workflow_run_id = ? AND event_id = ?', row.workflow_run_id, row.journal_event_id)!;
    requireIntegrity(row.session_id === event.session_id && row.actor_agent_id === event.actor_agent_id && row.occurred_at === event.event_timestamp);
  }
  if (row.event_kind === 'EXECUTION_CHANGED') {
    requireIntegrity(row.action_id !== null && row.entity_kind === 'ACTION' && row.entity_id === row.action_id
      && states.includes(String(row.next_state)) && validExecutionTransition(row.previous_state, row.next_state)
      && row.actor_agent_id === null && row.runtime_instance_id === null && row.runtime_generation === null);
    const ledger = tx.get('SELECT * FROM execution_ledger WHERE workflow_run_id = ? AND action_id = ?', row.workflow_run_id, row.action_id);
    requireIntegrity(ledger && (row.attempt_id === null || row.attempt_id === ledger.attempt_id));
    if (row.journal_event_id !== null) {
      const event = tx.get('SELECT event_type, session_id, json_extract(payload, \'$.payload.taskId\') AS task FROM journal_events WHERE workflow_run_id = ? AND event_id = ?', row.workflow_run_id, row.journal_event_id);
      requireIntegrity(event && ['TaskCompleted','TaskFailed'].includes(String(event.event_type)) && event.session_id === row.session_id && event.task === row.task_id);
    }
    const prior = tx.get("SELECT * FROM runtime_audit_events WHERE workflow_run_id = ? AND action_id = ? AND event_kind = 'EXECUTION_CHANGED' AND audit_sequence < ? ORDER BY audit_sequence DESC LIMIT 1", row.workflow_run_id, row.action_id, row.audit_sequence);
    requireIntegrity(!prior || prior.next_state === row.previous_state);
    const next = tx.get("SELECT audit_sequence FROM runtime_audit_events WHERE workflow_run_id = ? AND action_id = ? AND event_kind = 'EXECUTION_CHANGED' AND audit_sequence > ? LIMIT 1", row.workflow_run_id, row.action_id, row.audit_sequence);
    if (!next) requireIntegrity(ledger.state === row.next_state && ledger.review_reason === row.reason_code && ledger.finalized_event_id === row.journal_event_id);
  }
}

/** Internal, trusted transaction participant. Future callers must validate actors/ownership first.
 * No arbitrary payload/metadata field is accepted. Journal/Ledger events are trigger-owned.
 */
export interface RuntimeAuditInput {
  workflowRunId: string; eventKind: string; entityKind: 'WORKFLOW' | 'SESSION' | 'TASK' | 'ACTION' | 'RUNTIME'; entityId: string;
  sessionId?: string; taskId?: string; actionId?: string; attemptId?: string;
  actorAgentId?: string; subjectAgentId?: string; runtimeInstanceId?: string; runtimeGeneration?: number;
  previousState?: string; nextState?: string; reasonCode?: string;
  journalEventId?: string; journalSequence?: number; occurredAt: number;
}
export function appendRuntimeAuditInTransaction(db: DurableDatabase, tx: DurableTransaction, input: RuntimeAuditInput): void {
  db.assertTransaction(tx, true);
  requireIntegrity(!['JOURNAL_APPENDED','EXECUTION_CHANGED'].includes(input.eventKind));
  const columns: Record<string, keyof RuntimeAuditInput> = { workflow_run_id: 'workflowRunId', event_kind: 'eventKind', entity_kind: 'entityKind', entity_id: 'entityId',
    session_id: 'sessionId', task_id: 'taskId', action_id: 'actionId', attempt_id: 'attemptId', actor_agent_id: 'actorAgentId', subject_agent_id: 'subjectAgentId',
    runtime_instance_id: 'runtimeInstanceId', runtime_generation: 'runtimeGeneration', previous_state: 'previousState', next_state: 'nextState', reason_code: 'reasonCode',
    journal_event_id: 'journalEventId', journal_sequence: 'journalSequence', occurred_at: 'occurredAt' };
  requireIntegrity(Object.keys(input).every(key => Object.values(columns).includes(key as keyof RuntimeAuditInput)));
  const row: Row = { audit_sequence: 1, audit_event_id: randomUUID(), schema_version: 1, recorded_at: Date.now() };
  for (const [column, key] of Object.entries(columns)) row[column] = input[key] ?? null;
  requireIntegrity(tx.get('SELECT workflow_run_id FROM workflow_seeds WHERE workflow_run_id = ?', input.workflowRunId));
  validateAuditRow(tx, row);
  const keys = Object.keys(row).filter(key => key !== 'audit_sequence');
  tx.run(`INSERT INTO runtime_audit_events (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map(key => row[key]));
}
