import { RECOVERY_AUDIT_SQL } from './recoverySchema';

export const SCHEMA_VERSION = 3;
// Persisted seed/checkpoint format is unchanged by the additive execution migration.
export const JOURNAL_SCHEMA_VERSION = 1;
export const MIGRATIONS = [{ version: 1, id: '001_durable_coordination', sql: `
CREATE TABLE workflow_seeds (
  workflow_run_id TEXT PRIMARY KEY NOT NULL,
  schema_version INTEGER NOT NULL,
  seed_payload TEXT NOT NULL,
  policy_payload TEXT NOT NULL,
  seed_digest TEXT NOT NULL,
  policy_digest TEXT NOT NULL,
  created_at REAL NOT NULL,
  last_sequence INTEGER NOT NULL CHECK(last_sequence >= 1),
  journal_anchor TEXT NOT NULL
) STRICT;
CREATE TABLE journal_events (
  workflow_run_id TEXT NOT NULL REFERENCES workflow_seeds(workflow_run_id),
  sequence INTEGER NOT NULL CHECK(sequence >= 1),
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  session_id TEXT,
  actor_agent_id TEXT,
  event_timestamp REAL NOT NULL,
  idempotency_key TEXT,
  payload TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  UNIQUE(workflow_run_id, sequence),
  UNIQUE(workflow_run_id, event_id),
  UNIQUE(workflow_run_id, idempotency_key)
) STRICT;
CREATE TABLE workflow_checkpoints (
  checkpoint_id TEXT PRIMARY KEY NOT NULL,
  workflow_run_id TEXT NOT NULL REFERENCES workflow_seeds(workflow_run_id),
  schema_version INTEGER NOT NULL,
  last_sequence INTEGER NOT NULL,
  snapshot_payload TEXT NOT NULL,
  snapshot_digest TEXT NOT NULL,
  journal_anchor TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(workflow_run_id, last_sequence) REFERENCES journal_events(workflow_run_id, sequence)
) STRICT;
CREATE INDEX checkpoints_by_workflow ON workflow_checkpoints(workflow_run_id, last_sequence DESC, created_at DESC);
CREATE TRIGGER journal_no_update BEFORE UPDATE ON journal_events BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_JOURNAL'); END;
CREATE TRIGGER journal_no_delete BEFORE DELETE ON journal_events BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_JOURNAL'); END;
CREATE TRIGGER seed_no_delete BEFORE DELETE ON workflow_seeds BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_SEED'); END;
CREATE TRIGGER seed_immutable BEFORE UPDATE OF workflow_run_id, schema_version, seed_payload, policy_payload, seed_digest, policy_digest, created_at
ON workflow_seeds BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_SEED'); END;
` }, { version: 2, id: '002_durable_execution', sql: `
CREATE TABLE pending_actions (
  workflow_run_id TEXT NOT NULL REFERENCES workflow_seeds(workflow_run_id),
  session_id TEXT NOT NULL CHECK(length(trim(session_id)) > 0),
  task_id TEXT NOT NULL CHECK(length(trim(task_id)) > 0),
  action_id TEXT NOT NULL CHECK(length(trim(action_id)) > 0),
  executor_id TEXT NOT NULL CHECK(length(trim(executor_id)) > 0),
  operation TEXT NOT NULL CHECK(length(trim(operation)) > 0),
  action_class TEXT NOT NULL CHECK(length(trim(action_class)) > 0),
  fingerprint TEXT NOT NULL CHECK(length(trim(fingerprint)) > 0),
  retry_safety TEXT NOT NULL CHECK(retry_safety IN ('safe','never')),
  prepared_action_json TEXT NOT NULL,
  prepared_action_digest TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK(schema_version = 1),
  created_at REAL NOT NULL,
  round_key TEXT NOT NULL CHECK(length(trim(round_key)) > 0),
  registration_digest TEXT NOT NULL,
  PRIMARY KEY(workflow_run_id, action_id),
  UNIQUE(workflow_run_id, task_id),
  UNIQUE(workflow_run_id, session_id),
  UNIQUE(workflow_run_id, round_key),
  UNIQUE(workflow_run_id, session_id, task_id, action_id),
  UNIQUE(workflow_run_id, session_id, task_id, action_id, fingerprint, executor_id)
) STRICT;
CREATE TABLE execution_results (
  result_ref TEXT PRIMARY KEY NOT NULL,
  workflow_run_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  executor_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL UNIQUE,
  result_json TEXT NOT NULL,
  result_digest TEXT NOT NULL,
  created_at REAL NOT NULL,
  schema_version INTEGER NOT NULL CHECK(schema_version = 1),
  UNIQUE(workflow_run_id, action_id),
  UNIQUE(workflow_run_id, action_id, result_ref, result_digest),
  FOREIGN KEY(workflow_run_id, session_id, task_id, action_id, fingerprint, executor_id)
    REFERENCES pending_actions(workflow_run_id, session_id, task_id, action_id, fingerprint, executor_id),
  FOREIGN KEY(workflow_run_id, action_id, attempt_id) REFERENCES execution_ledger(workflow_run_id, action_id, attempt_id)
) STRICT;
CREATE TABLE execution_ledger (
  workflow_run_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  executor_id TEXT NOT NULL,
  attempt_id TEXT UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('PREPARED','DISPATCH_RESERVED','RESULT_RECORDED','FINALIZED','REVIEW_REQUIRED')),
  reserved_at REAL,
  result_ref TEXT,
  result_digest TEXT,
  updated_at REAL NOT NULL,
  schema_version INTEGER NOT NULL CHECK(schema_version = 1),
  review_reason TEXT CHECK(review_reason IN ('EXECUTION_UNCERTAIN','SECURITY_REVIEW_REQUIRED','RESULT_INTEGRITY_UNAVAILABLE')),
  finalized_event_id TEXT,
  PRIMARY KEY(workflow_run_id, action_id),
  UNIQUE(workflow_run_id, task_id),
  UNIQUE(workflow_run_id, action_id, attempt_id),
  CHECK((state = 'REVIEW_REQUIRED') = (review_reason IS NOT NULL)),
  CHECK(state NOT IN ('PREPARED','DISPATCH_RESERVED') OR (result_ref IS NULL AND finalized_event_id IS NULL)),
  CHECK(state <> 'RESULT_RECORDED' OR finalized_event_id IS NULL),
  CHECK((state = 'PREPARED' AND attempt_id IS NULL AND reserved_at IS NULL) OR
    (state <> 'PREPARED' AND attempt_id IS NOT NULL AND reserved_at IS NOT NULL)),
  CHECK((result_ref IS NULL) = (result_digest IS NULL)),
  CHECK(state NOT IN ('RESULT_RECORDED','FINALIZED') OR result_ref IS NOT NULL),
  CHECK(state <> 'FINALIZED' OR finalized_event_id IS NOT NULL),
  FOREIGN KEY(workflow_run_id, session_id, task_id, action_id, fingerprint, executor_id)
    REFERENCES pending_actions(workflow_run_id, session_id, task_id, action_id, fingerprint, executor_id),
  FOREIGN KEY(workflow_run_id, action_id, result_ref, result_digest)
    REFERENCES execution_results(workflow_run_id, action_id, result_ref, result_digest),
  FOREIGN KEY(workflow_run_id, finalized_event_id) REFERENCES journal_events(workflow_run_id, event_id)
) STRICT;
CREATE TABLE runner_evidence (
  evidence_ref TEXT PRIMARY KEY NOT NULL CHECK(evidence_ref LIKE 'map.runner.evidence.v1:%'),
  workflow_run_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(length(trim(kind)) > 0),
  content_json TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  created_at REAL NOT NULL,
  schema_version INTEGER NOT NULL CHECK(schema_version = 1),
  FOREIGN KEY(workflow_run_id, session_id, task_id, action_id) REFERENCES pending_actions(workflow_run_id, session_id, task_id, action_id)
) STRICT;
CREATE TRIGGER pending_actions_no_update BEFORE UPDATE ON pending_actions BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_ACTION'); END;
CREATE TRIGGER pending_actions_no_delete BEFORE DELETE ON pending_actions BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_ACTION'); END;
CREATE TRIGGER execution_results_no_update BEFORE UPDATE ON execution_results BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_RESULT'); END;
CREATE TRIGGER execution_results_no_delete BEFORE DELETE ON execution_results BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_RESULT'); END;
CREATE TRIGGER runner_evidence_no_update BEFORE UPDATE ON runner_evidence BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_EVIDENCE'); END;
CREATE TRIGGER runner_evidence_no_delete BEFORE DELETE ON runner_evidence BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_EVIDENCE'); END;
CREATE TRIGGER ledger_no_delete BEFORE DELETE ON execution_ledger BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_EXECUTION'); END;
CREATE TRIGGER ledger_transition BEFORE UPDATE ON execution_ledger WHEN
  NOT ((OLD.state = 'PREPARED' AND NEW.state = 'DISPATCH_RESERVED') OR
    (OLD.state = 'DISPATCH_RESERVED' AND NEW.state IN ('RESULT_RECORDED','REVIEW_REQUIRED')) OR
    (OLD.state = 'RESULT_RECORDED' AND NEW.state = 'FINALIZED') OR
    (OLD.state = 'REVIEW_REQUIRED' AND NEW.state = 'REVIEW_REQUIRED')) OR
  NEW.workflow_run_id <> OLD.workflow_run_id OR NEW.session_id <> OLD.session_id OR
  NEW.task_id <> OLD.task_id OR NEW.action_id <> OLD.action_id OR NEW.fingerprint <> OLD.fingerprint OR
  NEW.executor_id <> OLD.executor_id OR NEW.schema_version <> OLD.schema_version OR
  (OLD.attempt_id IS NOT NULL AND (NEW.attempt_id IS NOT OLD.attempt_id OR NEW.reserved_at IS NOT OLD.reserved_at)) OR
  (OLD.result_ref IS NOT NULL AND (NEW.result_ref IS NOT OLD.result_ref OR NEW.result_digest IS NOT OLD.result_digest)) OR
  (OLD.finalized_event_id IS NOT NULL AND NEW.finalized_event_id IS NOT OLD.finalized_event_id)
BEGIN SELECT RAISE(ABORT, 'INVALID_EXECUTION_TRANSITION'); END;
` }, { version: 3, id: '003_recovery_audit_foundation', sql: RECOVERY_AUDIT_SQL }] as const;
