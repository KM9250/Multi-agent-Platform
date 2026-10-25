import type { SQLInputValue } from 'node:sqlite';
import type { DurableDatabase, DurableTransaction, Row } from './db';
import { decodeEvent } from './restore';
import { digest, DurableStoreError, requireIntegrity } from './integrity';
import { assertRecoverySchema, validateAuditRow } from './recoveryAudit';
import { SqliteRunnerPendingActionStore } from './pendingActionStore';
import { readExecution } from './executionLedger';
import type { TimelineQueryOptions, WorkflowTimelineEntry, WorkflowTimelinePage } from './recoveryTypes';

interface Cursor { version: 1; query: string; phase: number; sequence: number; bounds: number[] }
function queryOptions(id: string, input: TimelineQueryOptions) {
  const limit = input.limit ?? 100;
  if (typeof id !== 'string' || !id.trim() || !Number.isSafeInteger(limit) || limit < 1 || limit > 100
    || input.eventKind !== undefined && (typeof input.eventKind !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(input.eventKind))
    || input.actionId !== undefined && (typeof input.actionId !== 'string' || !input.actionId.trim())
    || [input.fromTimestamp, input.toTimestamp].some(n => n !== undefined && (typeof n !== 'number' || !Number.isFinite(n) || n < 0))
    || input.fromTimestamp !== undefined && input.toTimestamp !== undefined && input.fromTimestamp > input.toTimestamp) throw new DurableStoreError('INVALID_CONFIGURATION');
  return { limit, binding: digest([id, input.actionId ?? null, input.eventKind ?? null, input.fromTimestamp ?? null, input.toTimestamp ?? null]) };
}
const optional = (row: Row, key: string): string | undefined => row[key] === null ? undefined : String(row[key]);
function journalEntry(tx: DurableTransaction, row: Row, actionId?: string): WorkflowTimelineEntry {
  const event = decodeEvent(row, String(row.workflow_run_id), Number(row.sequence));
  const taskId = ['TaskAssigned','TaskCompleted','TaskFailed','TaskCancelled'].includes(event.type)
    ? (event.payload as { taskId: string }).taskId : undefined;
  const assigned = taskId ? tx.get("SELECT payload FROM journal_events WHERE workflow_run_id = ? AND event_type = 'TaskAssigned' AND json_extract(payload, '$.payload.taskId') = ? ORDER BY sequence LIMIT 1", event.workflowRunId, taskId) : undefined;
  const subjectAgentId = assigned ? JSON.parse(String(assigned.payload)).payload.assigneeAgentId : undefined;
  return { source: 'JOURNAL', eventKind: event.type, workflowRunId: event.workflowRunId,
    sessionId: event.sessionId, taskId, actionId, actorAgentId: event.actorAgentId, subjectAgentId,
    journalEventId: event.eventId, journalSequence: event.sequence, occurredAt: event.timestamp, historicalCoverage: 'COMPLETE_FOR_SOURCE' };
}
/** Bounded SQL keyset paging. Sources have explicit order; timestamps are filters, not a global clock. */
export class RecoveryAuditReader {
  constructor(readonly database: DurableDatabase) {}
  getActionHistory(id: string, actionId: string, options: TimelineQueryOptions = {}): WorkflowTimelinePage {
    if (options.actionId !== undefined && options.actionId !== actionId) throw new DurableStoreError('INVALID_CONFIGURATION');
    return this.getWorkflowTimeline(id, { ...options, actionId });
  }
  getWorkflowTimeline(id: string, options: TimelineQueryOptions = {}): WorkflowTimelinePage {
    const { limit, binding } = queryOptions(id, options);
    return this.database.read(tx => {
      assertRecoverySchema(tx);
      if (!tx.get('SELECT workflow_run_id FROM workflow_seeds WHERE workflow_run_id = ?', id)) throw new DurableStoreError('WORKFLOW_NOT_FOUND');
      requireIntegrity(!tx.get('SELECT audit_sequence FROM runtime_audit_events WHERE workflow_run_id = ? AND audit_sequence <= 0 LIMIT 1', id));
      let cursor: Cursor = { version: 1, query: binding, phase: 0, sequence: 0, bounds: [
        Number(tx.get('SELECT coalesce(max(sequence),0) AS n FROM journal_events WHERE workflow_run_id = ?', id)!.n),
        Number(tx.get('SELECT coalesce(max(audit_sequence),0) AS n FROM runtime_audit_events WHERE workflow_run_id = ?', id)!.n),
        Number(tx.get('SELECT coalesce(max(rowid),0) AS n FROM execution_ledger WHERE workflow_run_id = ?', id)!.n),
      ] };
      if (options.cursor !== undefined) {
        try {
          if (typeof options.cursor !== 'string' || options.cursor.length > 2048) throw Error();
          cursor = JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8'));
          if (cursor.version !== 1 || cursor.query !== binding || ![0,1,2].includes(cursor.phase)
            || !Number.isSafeInteger(cursor.sequence) || cursor.sequence < 0 || !Array.isArray(cursor.bounds) || cursor.bounds.length !== 3
            || !cursor.bounds.every(n => Number.isSafeInteger(n) && n >= 0) || cursor.sequence > cursor.bounds[cursor.phase]) throw Error();
        } catch { throw new DurableStoreError('INVALID_CONFIGURATION'); }
      }
      const params: SQLInputValue[] = [id, cursor.bounds[0], id, cursor.bounds[1], id, cursor.bounds[2], cursor.phase, cursor.phase, cursor.sequence];
      const filters: string[] = [];
      if (options.actionId !== undefined) { filters.push('action_id = ?'); params.push(options.actionId); }
      if (options.eventKind !== undefined) { filters.push('kind = ?'); params.push(options.eventKind); }
      if (options.fromTimestamp !== undefined) { filters.push('occurred >= ?'); params.push(options.fromTimestamp); }
      if (options.toTimestamp !== undefined) { filters.push('occurred <= ?'); params.push(options.toTimestamp); }
      params.push(limit + 1);
      const rows = tx.all(`SELECT * FROM (
        SELECT 0 AS phase, j.sequence AS n, j.event_type AS kind, j.event_timestamp AS occurred,
          p.action_id AS action_id FROM journal_events j LEFT JOIN pending_actions p ON p.workflow_run_id = j.workflow_run_id
          AND p.task_id = json_extract(j.payload, '$.payload.taskId')
        WHERE j.workflow_run_id = ? AND j.sequence <= ? AND NOT EXISTS (SELECT 1 FROM runtime_audit_events a
          WHERE a.workflow_run_id = j.workflow_run_id AND a.event_kind = 'JOURNAL_APPENDED' AND a.journal_event_id = j.event_id)
        UNION ALL
        SELECT 1, a.audit_sequence, CASE WHEN a.event_kind = 'JOURNAL_APPENDED' THEN j.event_type ELSE a.event_kind END,
          a.occurred_at, coalesce(a.action_id,p.action_id) FROM runtime_audit_events a
          LEFT JOIN journal_events j ON j.workflow_run_id = a.workflow_run_id AND j.event_id = a.journal_event_id
          LEFT JOIN pending_actions p ON p.workflow_run_id = a.workflow_run_id AND p.task_id = a.task_id
        WHERE a.workflow_run_id = ? AND a.audit_sequence <= ?
        UNION ALL
        SELECT 2, rowid, 'EXECUTION_CURRENT', updated_at, action_id FROM execution_ledger
        WHERE workflow_run_id = ? AND rowid <= ?
      ) WHERE (phase > ? OR (phase = ? AND n > ?)) ${filters.length ? `AND ${filters.join(' AND ')}` : ''}
      ORDER BY phase, n LIMIT ?`, ...params);
      const entries = rows.slice(0, limit).map(key => {
        if (key.phase === 0) return journalEntry(tx, tx.get('SELECT * FROM journal_events WHERE workflow_run_id = ? AND sequence = ?', id, key.n)!, optional(key, 'action_id'));
        if (key.phase === 1) {
          const row = tx.get('SELECT * FROM runtime_audit_events WHERE workflow_run_id = ? AND audit_sequence = ?', id, key.n)!;
          validateAuditRow(tx, row);
          const audit = { auditEventId: String(row.audit_event_id), auditSequence: Number(row.audit_sequence), recordedAt: Number(row.recorded_at), runtimeInstanceId: optional(row, 'runtime_instance_id'),
            generation: row.runtime_generation === null ? undefined : Number(row.runtime_generation) };
          if (row.event_kind === 'JOURNAL_APPENDED') return { ...journalEntry(tx, tx.get('SELECT * FROM journal_events WHERE workflow_run_id = ? AND event_id = ?', id, row.journal_event_id)!, optional(key, 'action_id')), ...audit };
          return { source: row.event_kind === 'EXECUTION_CHANGED' ? 'EXECUTION_AUDIT' : 'RUNTIME_AUDIT', eventKind: String(row.event_kind), workflowRunId: id,
            sessionId: optional(row, 'session_id'), taskId: optional(row, 'task_id'), actionId: optional(row, 'action_id'), attemptId: optional(row, 'attempt_id'),
            actorAgentId: optional(row, 'actor_agent_id'), subjectAgentId: optional(row, 'subject_agent_id'), runtimeInstanceId: optional(row, 'runtime_instance_id'),
            generation: row.runtime_generation === null ? undefined : Number(row.runtime_generation), previousState: optional(row, 'previous_state'), nextState: optional(row, 'next_state'),
            reasonCode: optional(row, 'reason_code'), journalEventId: optional(row, 'journal_event_id'), journalSequence: row.journal_sequence === null ? undefined : Number(row.journal_sequence),
            occurredAt: Number(row.occurred_at), historicalCoverage: 'PARTIAL', ...audit } as WorkflowTimelineEntry;
        }
        const record = new SqliteRunnerPendingActionStore(this.database).getInTransaction(tx, id, String(key.action_id)); requireIntegrity(record);
        const row = readExecution(tx, record);
        return { source: 'CURRENT_SNAPSHOT', eventKind: 'EXECUTION_CURRENT', workflowRunId: id, sessionId: record.sessionId, taskId: record.taskId,
          actionId: record.action.actionId, attemptId: optional(row, 'attempt_id'), nextState: String(row.state), reasonCode: optional(row, 'review_reason'),
          occurredAt: Number(row.updated_at), historicalCoverage: 'CURRENT_ONLY' } as WorkflowTimelineEntry;
      });
      const last = rows[Math.min(rows.length, limit) - 1];
      return { workflowRunId: id, entries, nextCursor: rows.length > limit
        ? Buffer.from(JSON.stringify({ ...cursor, phase: last.phase, sequence: last.n })).toString('base64url') : undefined,
        ordering: 'LEGACY_JOURNAL_THEN_AUDIT_THEN_CURRENT', crossSourceClockOrderGuaranteed: false, ledgerHistoricalCoverage: 'PARTIAL' };
    });
  }
}
