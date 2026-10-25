import { RECOVERY_AUDIT_SQL } from './recoverySchema';

export const DATABASE_NOW_SQL = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";
const fence = (workflow: string) => `EXISTS (SELECT 1 FROM runtime_leases AS lease
  WHERE lease.workflow_run_id = ${workflow} AND map_fence_valid(lease.workflow_run_id,
    lease.owner_instance_id, lease.generation, lease.lease_capability_hash,
    lease.lease_state, lease.expires_at, ${DATABASE_NOW_SQL}) = 1)`;
const protect = (table: string, operation: 'INSERT' | 'UPDATE' | 'DELETE', bootstrap = '') => `
CREATE TRIGGER fence_${table}_${operation.toLowerCase()} BEFORE ${operation} ON ${table}
WHEN NOT (${fence(operation === 'DELETE' ? 'OLD.workflow_run_id' : 'NEW.workflow_run_id')}${operation === 'UPDATE' ? ` AND ${fence('OLD.workflow_run_id')}` : ''}${bootstrap ? ` OR (${bootstrap})` : ''})
BEGIN SELECT RAISE(ABORT, 'LEASE_FENCED'); END;`;
const bootstrap = (kind: string) => `map_bootstrap(NEW.workflow_run_id, '${kind}') = 1`;
// Keep 003 byte-for-byte unchanged. Only future trigger-owned records get metadata.
const auditTriggers = RECOVERY_AUDIT_SQL.slice(RECOVERY_AUDIT_SQL.indexOf('CREATE TRIGGER journal_audit_insert'))
  .replaceAll('occurred_at, recorded_at, schema_version', 'occurred_at, recorded_at, schema_version, runtime_instance_id, runtime_generation')
  .replaceAll(', 1);', ', 1, map_runtime_id(), map_runtime_generation());');

export const RUNTIME_LEASE_SQL = `
CREATE TABLE runtime_leases (
  workflow_run_id TEXT PRIMARY KEY NOT NULL REFERENCES workflow_seeds(workflow_run_id),
  owner_instance_id TEXT NOT NULL CHECK(length(trim(owner_instance_id)) > 0),
  generation INTEGER NOT NULL CHECK(generation BETWEEN 1 AND 9007199254740991),
  lease_state TEXT NOT NULL CHECK(lease_state IN ('ACTIVE','RELEASED')),
  acquired_at INTEGER NOT NULL CHECK(acquired_at >= 0),
  heartbeat_at INTEGER NOT NULL CHECK(heartbeat_at >= acquired_at),
  expires_at INTEGER NOT NULL CHECK(expires_at > heartbeat_at),
  lease_capability_hash TEXT NOT NULL CHECK(length(lease_capability_hash) = 64)
) STRICT;
CREATE INDEX leases_by_expiry ON runtime_leases(lease_state, expires_at);
CREATE TABLE runtime_fencing_boundary (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  legacy_audit_sequence INTEGER NOT NULL CHECK(legacy_audit_sequence >= 0)
) STRICT;
INSERT INTO runtime_fencing_boundary VALUES (1, (SELECT coalesce(max(audit_sequence), 0) FROM runtime_audit_events));
CREATE TRIGGER fencing_boundary_no_update BEFORE UPDATE ON runtime_fencing_boundary BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_BOUNDARY'); END;
CREATE TRIGGER fencing_boundary_no_delete BEFORE DELETE ON runtime_fencing_boundary BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_BOUNDARY'); END;
CREATE TRIGGER fencing_boundary_no_insert BEFORE INSERT ON runtime_fencing_boundary BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_BOUNDARY'); END;
CREATE TRIGGER leases_no_delete BEFORE DELETE ON runtime_leases BEGIN SELECT RAISE(ABORT, 'LEASE_FENCED'); END;
CREATE TRIGGER leases_insert BEFORE INSERT ON runtime_leases WHEN
  map_lease_change(NEW.workflow_run_id) <> 1 OR NEW.generation <> 1 OR NEW.lease_state <> 'ACTIVE'
BEGIN SELECT RAISE(ABORT, 'LEASE_FENCED'); END;
CREATE TRIGGER leases_update BEFORE UPDATE ON runtime_leases WHEN
  map_lease_change(NEW.workflow_run_id) <> 1 OR NEW.workflow_run_id <> OLD.workflow_run_id OR NOT (
    (OLD.lease_state = 'ACTIVE' AND OLD.expires_at > ${DATABASE_NOW_SQL}
      AND NEW.owner_instance_id = OLD.owner_instance_id AND NEW.generation = OLD.generation
      AND NEW.acquired_at = OLD.acquired_at AND NEW.lease_capability_hash = OLD.lease_capability_hash
      AND ((NEW.lease_state = 'RELEASED' AND NEW.heartbeat_at = OLD.heartbeat_at AND NEW.expires_at = OLD.expires_at)
        OR (NEW.lease_state = 'ACTIVE' AND NEW.heartbeat_at >= OLD.heartbeat_at AND NEW.expires_at >= OLD.expires_at)))
    OR ((OLD.lease_state = 'RELEASED' OR OLD.expires_at <= ${DATABASE_NOW_SQL})
      AND NEW.lease_state = 'ACTIVE' AND NEW.generation = OLD.generation + 1
      AND NEW.acquired_at >= OLD.acquired_at AND NEW.lease_capability_hash <> OLD.lease_capability_hash))
BEGIN SELECT RAISE(ABORT, 'LEASE_FENCED'); END;
${protect('workflow_seeds', 'INSERT', bootstrap('SEED'))}
${protect('workflow_seeds', 'UPDATE')}
${protect('journal_events', 'INSERT', `${bootstrap('JOURNAL')} AND NEW.sequence = 1 AND NEW.event_type = 'WorkflowRunCreated'
  AND NOT EXISTS (SELECT 1 FROM journal_events WHERE workflow_run_id = NEW.workflow_run_id)`)}
${['workflow_checkpoints','pending_actions','execution_ledger','execution_results','runner_evidence'].map(table => protect(table, 'INSERT')).join('\n')}
${protect('execution_ledger', 'UPDATE')}
${protect('workflow_checkpoints', 'UPDATE')}
${protect('workflow_checkpoints', 'DELETE')}
CREATE TRIGGER fence_runtime_audit_insert BEFORE INSERT ON runtime_audit_events WHEN NOT (
  (${fence('NEW.workflow_run_id')} AND NEW.runtime_instance_id IS map_runtime_id()
    AND NEW.runtime_generation IS map_runtime_generation() AND NEW.event_kind NOT LIKE 'LEASE_%') OR
  (${bootstrap('AUDIT')} AND NEW.event_kind = 'JOURNAL_APPENDED' AND NEW.journal_sequence = 1
    AND NEW.runtime_instance_id IS NULL AND NEW.runtime_generation IS NULL) OR
  (map_lease_change(NEW.workflow_run_id) = 1 AND NEW.event_kind IN ('LEASE_ACQUIRED','LEASE_TAKEN_OVER','LEASE_RELEASED')
    AND EXISTS (SELECT 1 FROM runtime_leases WHERE workflow_run_id = NEW.workflow_run_id
      AND owner_instance_id IS NEW.runtime_instance_id AND generation IS NEW.runtime_generation
      AND lease_state IS NEW.next_state)))
BEGIN SELECT RAISE(ABORT, 'LEASE_FENCED'); END;
CREATE TRIGGER audit_sequence_boundary BEFORE INSERT ON runtime_audit_events WHEN
  NEW.audit_sequence <> -1 AND NEW.audit_sequence <= (SELECT legacy_audit_sequence FROM runtime_fencing_boundary WHERE singleton = 1)
BEGIN SELECT RAISE(ABORT, 'LEASE_FENCED'); END;
CREATE TRIGGER audit_sequence_boundary_after AFTER INSERT ON runtime_audit_events WHEN
  NEW.audit_sequence <= (SELECT legacy_audit_sequence FROM runtime_fencing_boundary WHERE singleton = 1)
BEGIN SELECT RAISE(ABORT, 'LEASE_FENCED'); END;
DROP TRIGGER journal_audit_insert;
DROP TRIGGER ledger_audit_insert;
DROP TRIGGER ledger_audit_update;
${auditTriggers}
CREATE TRIGGER lease_audit_insert AFTER INSERT ON runtime_leases BEGIN
  INSERT INTO runtime_audit_events (audit_event_id, workflow_run_id, event_kind, entity_kind, entity_id,
    runtime_instance_id, runtime_generation, previous_state, next_state, reason_code, occurred_at, recorded_at, schema_version)
  VALUES (lower(hex(randomblob(16))), NEW.workflow_run_id, 'LEASE_ACQUIRED', 'RUNTIME', NEW.owner_instance_id,
    NEW.owner_instance_id, NEW.generation, NULL, 'ACTIVE', 'INITIAL_ACQUIRE', NEW.acquired_at, ${DATABASE_NOW_SQL}, 1);
END;
CREATE TRIGGER lease_audit_update AFTER UPDATE ON runtime_leases WHEN
  NEW.generation <> OLD.generation OR NEW.lease_state <> OLD.lease_state
BEGIN
  INSERT INTO runtime_audit_events (audit_event_id, workflow_run_id, event_kind, entity_kind, entity_id,
    runtime_instance_id, runtime_generation, previous_state, next_state, reason_code, occurred_at, recorded_at, schema_version)
  VALUES (lower(hex(randomblob(16))), NEW.workflow_run_id,
    CASE WHEN NEW.lease_state = 'RELEASED' THEN 'LEASE_RELEASED' WHEN OLD.lease_state = 'ACTIVE' THEN 'LEASE_TAKEN_OVER' ELSE 'LEASE_ACQUIRED' END,
    'RUNTIME', NEW.owner_instance_id, NEW.owner_instance_id, NEW.generation,
    CASE WHEN OLD.lease_state = 'ACTIVE' AND NEW.generation <> OLD.generation THEN 'EXPIRED' ELSE OLD.lease_state END,
    NEW.lease_state,
    CASE WHEN NEW.lease_state = 'RELEASED' THEN 'OWNER_RELEASE' WHEN OLD.lease_state = 'ACTIVE' THEN 'LEASE_EXPIRED' ELSE 'REACQUIRE_AFTER_RELEASE' END,
    ${DATABASE_NOW_SQL}, ${DATABASE_NOW_SQL}, 1);
END;
`;
