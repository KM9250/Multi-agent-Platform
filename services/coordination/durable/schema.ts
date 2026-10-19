export const SCHEMA_VERSION = 1;
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
` }] as const;
