// Additive migration: no historical backfill and no changes to existing artifacts.
const recordedAt = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";
const subjectAgent = `(SELECT json_extract(payload, '$.payload.assigneeAgentId') FROM journal_events
  WHERE workflow_run_id = NEW.workflow_run_id AND event_type = 'TaskAssigned'
    AND json_extract(payload, '$.payload.taskId') = NEW.task_id ORDER BY sequence DESC LIMIT 1)`;
const ledgerColumns = `audit_event_id, workflow_run_id, event_kind, entity_kind, entity_id,
  session_id, task_id, action_id, attempt_id, subject_agent_id, previous_state, next_state,
  reason_code, journal_event_id, journal_sequence, occurred_at, recorded_at, schema_version`;
const ledgerValues = (previous: string) => `lower(hex(randomblob(16))), NEW.workflow_run_id,
  'EXECUTION_CHANGED', 'ACTION', NEW.action_id, NEW.session_id, NEW.task_id, NEW.action_id,
  NEW.attempt_id, ${subjectAgent}, ${previous}, NEW.state, NEW.review_reason,
  NEW.finalized_event_id, (SELECT sequence FROM journal_events WHERE workflow_run_id = NEW.workflow_run_id
    AND event_id = NEW.finalized_event_id), NEW.updated_at, ${recordedAt}, 1`;

export const RECOVERY_AUDIT_SQL = `
CREATE TABLE runtime_audit_events (
  audit_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  audit_event_id TEXT NOT NULL UNIQUE CHECK(length(trim(audit_event_id)) > 0),
  workflow_run_id TEXT NOT NULL REFERENCES workflow_seeds(workflow_run_id),
  event_kind TEXT NOT NULL CHECK(length(event_kind) BETWEEN 1 AND 80),
  entity_kind TEXT NOT NULL CHECK(entity_kind IN ('WORKFLOW','SESSION','TASK','ACTION','RUNTIME')),
  entity_id TEXT NOT NULL CHECK(length(trim(entity_id)) > 0),
  session_id TEXT, task_id TEXT, action_id TEXT, attempt_id TEXT,
  actor_agent_id TEXT, subject_agent_id TEXT, runtime_instance_id TEXT,
  runtime_generation INTEGER CHECK(runtime_generation >= 0),
  previous_state TEXT, next_state TEXT, reason_code TEXT,
  journal_event_id TEXT, journal_sequence INTEGER CHECK(journal_sequence >= 1),
  occurred_at REAL NOT NULL CHECK(occurred_at >= 0),
  recorded_at REAL NOT NULL CHECK(recorded_at >= 0),
  schema_version INTEGER NOT NULL CHECK(schema_version = 1),
  CHECK((journal_event_id IS NULL) = (journal_sequence IS NULL)),
  FOREIGN KEY(workflow_run_id, action_id) REFERENCES pending_actions(workflow_run_id, action_id),
  FOREIGN KEY(workflow_run_id, journal_event_id) REFERENCES journal_events(workflow_run_id, event_id),
  FOREIGN KEY(workflow_run_id, journal_sequence) REFERENCES journal_events(workflow_run_id, sequence)
) STRICT;
CREATE INDEX audit_by_workflow ON runtime_audit_events(workflow_run_id, audit_sequence);
CREATE INDEX audit_by_action ON runtime_audit_events(workflow_run_id, action_id, audit_sequence);
CREATE INDEX audit_by_kind_time ON runtime_audit_events(event_kind, recorded_at);
CREATE UNIQUE INDEX audit_journal_reference ON runtime_audit_events(workflow_run_id, journal_event_id)
  WHERE event_kind = 'JOURNAL_APPENDED';
CREATE TRIGGER audit_no_update BEFORE UPDATE ON runtime_audit_events
  BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_AUDIT'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON runtime_audit_events
  BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_AUDIT'); END;
CREATE TRIGGER audit_validate BEFORE INSERT ON runtime_audit_events WHEN
  (NEW.event_kind = 'JOURNAL_APPENDED' AND (NEW.journal_event_id IS NULL OR NEW.action_id IS NOT NULL OR
    NOT EXISTS (SELECT 1 FROM journal_events WHERE workflow_run_id = NEW.workflow_run_id
      AND event_id = NEW.journal_event_id AND session_id IS NEW.session_id AND actor_agent_id IS NEW.actor_agent_id
      AND event_timestamp IS NEW.occurred_at))) OR
  (NEW.journal_event_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM journal_events
    WHERE workflow_run_id = NEW.workflow_run_id AND event_id = NEW.journal_event_id AND sequence = NEW.journal_sequence)) OR
  (NEW.action_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pending_actions
    WHERE workflow_run_id = NEW.workflow_run_id AND action_id = NEW.action_id
      AND session_id IS NEW.session_id AND task_id IS NEW.task_id)) OR
  (NEW.event_kind = 'EXECUTION_CHANGED' AND (
    NEW.entity_kind <> 'ACTION' OR NEW.entity_id IS NOT NEW.action_id OR
    NOT EXISTS (SELECT 1 FROM execution_ledger WHERE workflow_run_id = NEW.workflow_run_id
      AND action_id = NEW.action_id AND state IS NEW.next_state AND attempt_id IS NEW.attempt_id
      AND review_reason IS NEW.reason_code AND finalized_event_id IS NEW.journal_event_id) OR
    NOT coalesce(((NEW.previous_state IS NULL AND NEW.next_state = 'PREPARED') OR
      (NEW.previous_state = 'PREPARED' AND NEW.next_state = 'DISPATCH_RESERVED') OR
      (NEW.previous_state = 'DISPATCH_RESERVED' AND NEW.next_state IN ('RESULT_RECORDED','REVIEW_REQUIRED')) OR
      (NEW.previous_state = 'RESULT_RECORDED' AND NEW.next_state = 'FINALIZED') OR
      (NEW.previous_state = 'REVIEW_REQUIRED' AND NEW.next_state = 'REVIEW_REQUIRED')), 0)))
  BEGIN SELECT RAISE(ABORT, 'INVALID_AUDIT'); END;
CREATE TRIGGER journal_audit_insert AFTER INSERT ON journal_events BEGIN
  INSERT INTO runtime_audit_events (audit_event_id, workflow_run_id, event_kind, entity_kind, entity_id,
    session_id, task_id, actor_agent_id, subject_agent_id, journal_event_id, journal_sequence,
    occurred_at, recorded_at, schema_version)
  VALUES (lower(hex(randomblob(16))), NEW.workflow_run_id, 'JOURNAL_APPENDED',
    CASE WHEN NEW.event_type IN ('TaskAssigned','TaskCompleted','TaskFailed','TaskCancelled') THEN 'TASK'
      WHEN NEW.session_id IS NOT NULL THEN 'SESSION' ELSE 'WORKFLOW' END,
    CASE WHEN NEW.event_type IN ('TaskAssigned','TaskCompleted','TaskFailed','TaskCancelled')
      THEN json_extract(NEW.payload, '$.payload.taskId') ELSE coalesce(NEW.session_id, NEW.workflow_run_id) END,
    NEW.session_id,
    CASE WHEN NEW.event_type IN ('TaskAssigned','TaskCompleted','TaskFailed','TaskCancelled')
      THEN json_extract(NEW.payload, '$.payload.taskId') END,
    NEW.actor_agent_id,
    CASE WHEN NEW.event_type IN ('TaskAssigned','TaskCompleted','TaskFailed','TaskCancelled') THEN
      (SELECT json_extract(payload, '$.payload.assigneeAgentId') FROM journal_events
        WHERE workflow_run_id = NEW.workflow_run_id AND event_type = 'TaskAssigned'
          AND json_extract(payload, '$.payload.taskId') = json_extract(NEW.payload, '$.payload.taskId')
        ORDER BY sequence DESC LIMIT 1) END,
    NEW.event_id, NEW.sequence, NEW.event_timestamp, ${recordedAt}, 1);
END;
CREATE TRIGGER ledger_audit_insert AFTER INSERT ON execution_ledger BEGIN
  INSERT INTO runtime_audit_events (${ledgerColumns}) VALUES (${ledgerValues('NULL')});
END;
CREATE TRIGGER ledger_audit_update AFTER UPDATE ON execution_ledger WHEN
  NEW.state IS NOT OLD.state OR NEW.review_reason IS NOT OLD.review_reason OR
  NEW.result_ref IS NOT OLD.result_ref OR NEW.result_digest IS NOT OLD.result_digest OR
  NEW.finalized_event_id IS NOT OLD.finalized_event_id OR NEW.attempt_id IS NOT OLD.attempt_id
BEGIN
  INSERT INTO runtime_audit_events (${ledgerColumns}) VALUES (${ledgerValues('OLD.state')});
END;
`;
