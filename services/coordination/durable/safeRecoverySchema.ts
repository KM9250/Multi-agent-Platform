import { DATABASE_NOW_SQL as now } from './leaseSchema';

// Migration 007 is additive. The v4A grants and permanently disabled operation
// table retain their original contract and triggers.
const contract = 'COORD-5C-4B:EXECUTE:1';
const kinds = "'REFLECT_RECORDED_RESULT','CANCEL_UNSENT_MODEL','DISCARD_SETTLED_RESPONSE','COMPLETE_SAFETY_STOP'";
const immutable = (table: string) => `
CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'RECOVERY_IMMUTABLE'); END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'RECOVERY_IMMUTABLE'); END;`;
const fence = (table: string, op = 'INSERT') => `
CREATE TRIGGER ${table}_fence_${op} BEFORE ${op} ON ${table} WHEN NOT EXISTS (
 SELECT 1 FROM runtime_leases l WHERE l.workflow_run_id=NEW.workflow_run_id
 AND map_fence_valid(l.workflow_run_id,l.owner_instance_id,l.generation,l.lease_capability_hash,l.lease_state,l.expires_at,${now})=1)
BEGIN SELECT RAISE(ABORT,'LEASE_FENCED'); END;`;
const managed = (table: string, kind: string, id: string) => `
CREATE TRIGGER ${table}_managed BEFORE INSERT ON ${table}
WHEN map_safe_recovery_management(NEW.workflow_run_id,'${kind}',NEW.${id})<>1
BEGIN SELECT RAISE(ABORT,'RECOVERY_UNAUTHORIZED'); END;`;
const scoped = (table: string, op: string, target: string, detail: string) => `
CREATE TRIGGER ${table}_scope_${op} BEFORE ${op} ON ${table}
WHEN map_safe_recovery_write(NEW.workflow_run_id,'${table}','${op}',${target},${detail})<>1
BEGIN SELECT RAISE(ABORT,'RECOVERY_UNAUTHORIZED'); END;`;
const auditColumns = `audit_event_id,workflow_run_id,event_kind,entity_kind,entity_id,
 execution_plan_id,execution_authorization_id,recovery_operation_id,recovery_hold_revision,
 recovery_record_digest,recovery_actor_id,previous_state,next_state,reason_code,
 occurred_at,recorded_at,schema_version,runtime_instance_id,runtime_generation`;
const audit = (table: string, op: string, kind: string, plan: string, grant: string, operation: string,
  revision: string, hash: string, previous: string, next: string, reason = 'NULL') => `
CREATE TRIGGER ${table}_audit_${op} AFTER ${op} ON ${table} BEGIN
 INSERT INTO runtime_audit_events (${auditColumns}) VALUES (
 lower(hex(randomblob(16))),NEW.workflow_run_id,${kind},'WORKFLOW',NEW.workflow_run_id,
 ${plan},${grant},${operation},${revision},${hash},map_safe_recovery_actor(),${previous},${next},${reason},
 ${now},${now},1,map_runtime_id(),map_runtime_generation());
END;`;

export const SAFE_RECOVERY_SQL = `
CREATE TABLE recovery_execution_plans (
 execution_plan_id TEXT PRIMARY KEY NOT NULL,
 workflow_run_id TEXT NOT NULL REFERENCES workflow_seeds(workflow_run_id),
 operation_kind TEXT NOT NULL CHECK(operation_kind IN (${kinds})), target_id TEXT NOT NULL CHECK(length(target_id)>0),
 plan_json TEXT NOT NULL CHECK(json_valid(plan_json)), plan_digest TEXT NOT NULL CHECK(length(plan_digest)=64),
 runtime_instance_id TEXT NOT NULL, runtime_generation INTEGER NOT NULL CHECK(runtime_generation>=1),
 journal_cursor INTEGER NOT NULL CHECK(journal_cursor>=1), hold_revision INTEGER NOT NULL CHECK(hold_revision>=1),
 contract_version TEXT NOT NULL CHECK(contract_version='${contract}'),
 created_at INTEGER NOT NULL CHECK(created_at>=0),
 expires_at INTEGER NOT NULL CHECK(expires_at>created_at AND expires_at<=created_at+1800000),
 UNIQUE(workflow_run_id,execution_plan_id), UNIQUE(execution_plan_id,plan_digest),
 UNIQUE(workflow_run_id,execution_plan_id,operation_kind,target_id,plan_digest,runtime_instance_id,runtime_generation),
 CHECK(json_extract(plan_json,'$.operationContractVersion') IS contract_version),
 CHECK(json_extract(plan_json,'$.executionPlanId') IS execution_plan_id),
 CHECK(json_extract(plan_json,'$.workflowRunId') IS workflow_run_id),
 CHECK(json_extract(plan_json,'$.operationKind') IS operation_kind),
 CHECK(json_extract(plan_json,'$.targetId') IS target_id),
 CHECK(json_extract(plan_json,'$.planDigest') IS plan_digest),
 CHECK(json_extract(plan_json,'$.runtimeInstanceId') IS runtime_instance_id),
 CHECK(json_extract(plan_json,'$.runtimeGeneration') IS runtime_generation),
 CHECK(json_extract(plan_json,'$.journalCursor') IS journal_cursor),
 CHECK(json_extract(plan_json,'$.recoveryHoldRevision') IS hold_revision),
 CHECK(json_extract(plan_json,'$.createdAt') IS created_at),
 CHECK(json_extract(plan_json,'$.expiresAt') IS expires_at),
 CHECK(json_extract(plan_json,'$.authorizationRequirements.approvalPolicy.minimumApprovers') BETWEEN 1 AND 100)
) STRICT;
${immutable('recovery_execution_plans')}
${fence('recovery_execution_plans')}
${managed('recovery_execution_plans','CREATE_PLAN','execution_plan_id')}
CREATE TRIGGER recovery_execution_plans_binding BEFORE INSERT ON recovery_execution_plans WHEN
 NEW.runtime_instance_id IS NOT map_runtime_id() OR NEW.runtime_generation IS NOT map_runtime_generation()
 OR NEW.journal_cursor IS NOT (SELECT last_sequence FROM workflow_seeds WHERE workflow_run_id=NEW.workflow_run_id)
 OR NEW.hold_revision IS NOT coalesce((SELECT max(revision) FROM recovery_hold_transitions WHERE workflow_run_id=NEW.workflow_run_id),
 (SELECT revision FROM recovery_holds WHERE workflow_run_id=NEW.workflow_run_id))
BEGIN SELECT RAISE(ABORT,'RECOVERY_UNAUTHORIZED'); END;

CREATE TABLE recovery_execution_grants (
 authorization_id TEXT PRIMARY KEY NOT NULL, execution_plan_id TEXT NOT NULL, workflow_run_id TEXT NOT NULL,
 operation_kind TEXT NOT NULL CHECK(operation_kind IN (${kinds})), target_id TEXT NOT NULL, plan_digest TEXT NOT NULL,
 authorized_actor_id TEXT NOT NULL CHECK(length(authorized_actor_id)>0),
 authorizer_role TEXT NOT NULL CHECK(authorizer_role IN ('RECOVERY_APPROVER','RECOVERY_ADMIN')),
 authorization_source TEXT NOT NULL CHECK(length(authorization_source)>0), authorized_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL CHECK(expires_at>authorized_at AND expires_at<=authorized_at+1800000),
 runtime_instance_id TEXT NOT NULL, runtime_generation INTEGER NOT NULL CHECK(runtime_generation>=1),
 contract_version TEXT NOT NULL CHECK(contract_version='${contract}'),
 status TEXT NOT NULL CHECK(status IN ('AUTHORIZED','CONSUMED','REVOKED')),
 revocation_reason TEXT CHECK(revocation_reason IN ('OPERATOR_REVOKED','POLICY_CHANGED')),
 revoked_at INTEGER, revoked_actor_id TEXT,
 grant_digest TEXT NOT NULL CHECK(length(grant_digest)=64), consumed_operation_id TEXT,
 CHECK((status='REVOKED')=(revocation_reason IS NOT NULL AND revoked_at IS NOT NULL AND revoked_actor_id IS NOT NULL)),
 CHECK((status='CONSUMED')=(consumed_operation_id IS NOT NULL)),
 CHECK(status='REVOKED' OR (revocation_reason IS NULL AND revoked_at IS NULL AND revoked_actor_id IS NULL)),
 UNIQUE(execution_plan_id,authorized_actor_id), UNIQUE(workflow_run_id,authorization_id),
 UNIQUE(authorization_id,workflow_run_id,execution_plan_id,consumed_operation_id),
 FOREIGN KEY(workflow_run_id,execution_plan_id,operation_kind,target_id,plan_digest,runtime_instance_id,runtime_generation)
  REFERENCES recovery_execution_plans(workflow_run_id,execution_plan_id,operation_kind,target_id,plan_digest,runtime_instance_id,runtime_generation),
 FOREIGN KEY(workflow_run_id,consumed_operation_id) REFERENCES recovery_execution_operations(workflow_run_id,operation_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(authorization_id,workflow_run_id,execution_plan_id,consumed_operation_id)
  REFERENCES recovery_operation_grants(authorization_id,workflow_run_id,execution_plan_id,operation_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
${fence('recovery_execution_grants')}
${fence('recovery_execution_grants','UPDATE')}
${managed('recovery_execution_grants','AUTHORIZE','authorization_id')}
CREATE TRIGGER recovery_execution_grants_initial BEFORE INSERT ON recovery_execution_grants WHEN
 NEW.status<>'AUTHORIZED' OR NEW.consumed_operation_id IS NOT NULL OR NEW.revoked_at IS NOT NULL
 OR NEW.revocation_reason IS NOT NULL OR NEW.revoked_actor_id IS NOT NULL OR NOT EXISTS (
 SELECT 1 FROM recovery_execution_plans p WHERE p.execution_plan_id=NEW.execution_plan_id
 AND NEW.authorized_at>=p.created_at AND NEW.expires_at<=p.expires_at
 AND p.contract_version=NEW.contract_version AND p.runtime_instance_id IS map_runtime_id()
 AND p.runtime_generation IS map_runtime_generation()
 AND (json_extract(p.plan_json,'$.authorizationRequirements.approvalPolicy.forbidSelfApproval') IS NOT 1
 OR NEW.authorized_actor_id IS NOT json_extract(p.plan_json,'$.createdByActorId')))
BEGIN SELECT RAISE(ABORT,'RECOVERY_UNAUTHORIZED'); END;
CREATE TRIGGER recovery_execution_grants_transition BEFORE UPDATE ON recovery_execution_grants WHEN
 OLD.status<>'AUTHORIZED' OR NEW.status NOT IN ('CONSUMED','REVOKED') OR
 ${['authorization_id','execution_plan_id','workflow_run_id','operation_kind','target_id','plan_digest','authorized_actor_id','authorizer_role','authorization_source','authorized_at','expires_at','runtime_instance_id','runtime_generation','contract_version','grant_digest'].map(k=>`NEW.${k} IS NOT OLD.${k}`).join(' OR ')}
 OR (NEW.status='REVOKED' AND (NEW.revoked_at<OLD.authorized_at
 OR map_safe_recovery_management(NEW.workflow_run_id,'REVOKE',NEW.authorization_id)<>1))
 OR (NEW.status='CONSUMED' AND (NEW.expires_at<=${now}
 OR map_safe_recovery_write(NEW.workflow_run_id,'recovery_execution_grants','UPDATE',NEW.authorization_id,NEW.status)<>1))
BEGIN SELECT RAISE(ABORT,'RECOVERY_UNAUTHORIZED'); END;
CREATE TRIGGER recovery_execution_grants_no_delete BEFORE DELETE ON recovery_execution_grants BEGIN SELECT RAISE(ABORT,'RECOVERY_IMMUTABLE'); END;

CREATE TABLE recovery_execution_operations (
 operation_id TEXT PRIMARY KEY NOT NULL, execution_plan_id TEXT NOT NULL UNIQUE, workflow_run_id TEXT NOT NULL,
 operation_kind TEXT NOT NULL CHECK(operation_kind IN (${kinds})), target_id TEXT NOT NULL, plan_digest TEXT NOT NULL,
 receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)), receipt_digest TEXT NOT NULL CHECK(length(receipt_digest)=64),
 actor_id TEXT NOT NULL CHECK(length(actor_id)>0), runtime_instance_id TEXT NOT NULL,
 runtime_generation INTEGER NOT NULL CHECK(runtime_generation>=1), committed_at INTEGER NOT NULL CHECK(committed_at>=0),
 contract_version TEXT NOT NULL CHECK(contract_version='${contract}'),
 result_state TEXT NOT NULL DEFAULT 'COMMITTED' CHECK(result_state='COMMITTED'),
 UNIQUE(workflow_run_id,operation_id), UNIQUE(workflow_run_id,operation_id,execution_plan_id),
 FOREIGN KEY(workflow_run_id,execution_plan_id,operation_kind,target_id,plan_digest,runtime_instance_id,runtime_generation)
  REFERENCES recovery_execution_plans(workflow_run_id,execution_plan_id,operation_kind,target_id,plan_digest,runtime_instance_id,runtime_generation),
 FOREIGN KEY(workflow_run_id,operation_id) REFERENCES recovery_hold_transitions(workflow_run_id,operation_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
${immutable('recovery_execution_operations')}
${fence('recovery_execution_operations')}
${scoped('recovery_execution_operations','INSERT','NEW.operation_id','NEW.execution_plan_id')}
CREATE TRIGGER recovery_execution_operations_quorum BEFORE INSERT ON recovery_execution_operations WHEN
 NEW.runtime_instance_id IS NOT map_runtime_id() OR NEW.runtime_generation IS NOT map_runtime_generation()
 OR (SELECT count(DISTINCT g.authorized_actor_id) FROM recovery_execution_grants g
 WHERE g.workflow_run_id=NEW.workflow_run_id AND g.execution_plan_id=NEW.execution_plan_id
 AND g.status='CONSUMED' AND g.consumed_operation_id=NEW.operation_id AND g.expires_at>${now})
 < (SELECT json_extract(plan_json,'$.authorizationRequirements.approvalPolicy.minimumApprovers')
 FROM recovery_execution_plans WHERE execution_plan_id=NEW.execution_plan_id)
BEGIN SELECT RAISE(ABORT,'RECOVERY_UNAUTHORIZED'); END;
CREATE TRIGGER recovery_execution_operations_resolution BEFORE INSERT ON recovery_execution_operations WHEN
 (NEW.operation_kind IN ('CANCEL_UNSENT_MODEL','DISCARD_SETTLED_RESPONSE') AND NOT EXISTS (
 SELECT 1 FROM recovery_model_resolutions r WHERE r.workflow_run_id=NEW.workflow_run_id AND r.operation_id=NEW.operation_id
 AND r.model_call_id=NEW.target_id AND r.resolution_kind=CASE NEW.operation_kind
 WHEN 'CANCEL_UNSENT_MODEL' THEN 'CANCELLED_UNSENT' ELSE 'DISCARDED_BY_RECOVERY' END))
 OR (NEW.operation_kind IN ('REFLECT_RECORDED_RESULT','COMPLETE_SAFETY_STOP')
 AND EXISTS(SELECT 1 FROM recovery_model_resolutions WHERE operation_id=NEW.operation_id))
BEGIN SELECT RAISE(ABORT,'RECOVERY_UNAUTHORIZED'); END;

CREATE TABLE recovery_operation_grants (
 operation_id TEXT NOT NULL, authorization_id TEXT NOT NULL UNIQUE, workflow_run_id TEXT NOT NULL, execution_plan_id TEXT NOT NULL,
 PRIMARY KEY(operation_id,authorization_id), UNIQUE(authorization_id,workflow_run_id,execution_plan_id,operation_id),
 FOREIGN KEY(workflow_run_id,operation_id,execution_plan_id)
  REFERENCES recovery_execution_operations(workflow_run_id,operation_id,execution_plan_id),
 FOREIGN KEY(authorization_id,workflow_run_id,execution_plan_id,operation_id)
  REFERENCES recovery_execution_grants(authorization_id,workflow_run_id,execution_plan_id,consumed_operation_id)
) STRICT;
${immutable('recovery_operation_grants')}
${fence('recovery_operation_grants')}
${scoped('recovery_operation_grants','INSERT','NEW.authorization_id','NEW.operation_id')}

CREATE TABLE recovery_hold_transitions (
 workflow_run_id TEXT NOT NULL REFERENCES recovery_holds(workflow_run_id),
 revision INTEGER NOT NULL CHECK(revision BETWEEN 2 AND 9007199254740991),
 previous_revision INTEGER NOT NULL CHECK(previous_revision>=1 AND revision=previous_revision+1),
 operation_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL CHECK(state IN ('RECOVERY_STEP_APPLIED','READY_FOR_CONTINUATION_REVIEW')),
 created_at INTEGER NOT NULL CHECK(created_at>=0), PRIMARY KEY(workflow_run_id,revision), UNIQUE(workflow_run_id,operation_id),
 FOREIGN KEY(workflow_run_id,operation_id) REFERENCES recovery_execution_operations(workflow_run_id,operation_id)
) STRICT;
${immutable('recovery_hold_transitions')}
${fence('recovery_hold_transitions')}
${scoped('recovery_hold_transitions','INSERT','NEW.operation_id','json_array(NEW.previous_revision,NEW.revision,NEW.state)')}
CREATE TRIGGER recovery_hold_transitions_sequence BEFORE INSERT ON recovery_hold_transitions WHEN
 NEW.previous_revision IS NOT coalesce((SELECT max(revision) FROM recovery_hold_transitions WHERE workflow_run_id=NEW.workflow_run_id),
 (SELECT revision FROM recovery_holds WHERE workflow_run_id=NEW.workflow_run_id))
 OR NEW.previous_revision IS NOT (SELECT p.hold_revision FROM recovery_execution_operations o
 JOIN recovery_execution_plans p ON p.execution_plan_id=o.execution_plan_id WHERE o.operation_id=NEW.operation_id)
BEGIN SELECT RAISE(ABORT,'RECOVERY_UNAUTHORIZED'); END;

CREATE TABLE recovery_model_resolutions (
 model_call_id TEXT PRIMARY KEY NOT NULL, workflow_run_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
 operation_id TEXT NOT NULL UNIQUE,
 resolution_kind TEXT NOT NULL CHECK(resolution_kind IN ('CANCELLED_UNSENT','DISCARDED_BY_RECOVERY')),
 original_runtime_instance_id TEXT NOT NULL, original_generation INTEGER NOT NULL CHECK(original_generation>=1),
 source_digest TEXT NOT NULL CHECK(length(source_digest)=64), source_json TEXT NOT NULL CHECK(json_valid(source_json)),
 reservation_json TEXT NOT NULL CHECK(json_valid(reservation_json)), created_at INTEGER NOT NULL CHECK(created_at>=0),
 FOREIGN KEY(workflow_run_id,model_call_id) REFERENCES model_call_ledger(workflow_run_id,model_call_id),
 FOREIGN KEY(attempt_id) REFERENCES model_call_attempts(attempt_id),
 FOREIGN KEY(workflow_run_id,operation_id) REFERENCES recovery_execution_operations(workflow_run_id,operation_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
${immutable('recovery_model_resolutions')}
${fence('recovery_model_resolutions')}
${scoped('recovery_model_resolutions','INSERT','NEW.model_call_id','NEW.resolution_kind')}
CREATE TRIGGER recovery_model_resolutions_source BEFORE INSERT ON recovery_model_resolutions WHEN NOT EXISTS (
 SELECT 1 FROM model_call_ledger m JOIN model_call_attempts a ON a.model_call_id=m.model_call_id
 WHERE m.model_call_id=NEW.model_call_id AND m.workflow_run_id=NEW.workflow_run_id
 AND a.workflow_run_id=m.workflow_run_id AND a.attempt_id=m.attempt_id AND a.attempt_id=NEW.attempt_id
 AND m.runtime_instance_id=NEW.original_runtime_instance_id AND m.generation=NEW.original_generation
 AND a.runtime_instance_id=m.runtime_instance_id AND a.generation=m.generation AND a.attempt_number=1
 AND ((NEW.resolution_kind='CANCELLED_UNSENT' AND m.state='RESERVED' AND a.state='RESERVED' AND a.dispatch_intent_at IS NULL)
 OR (NEW.resolution_kind='DISCARDED_BY_RECOVERY' AND m.state='SETTLED' AND a.state='SETTLED'
 AND m.completeness='COMPLETE' AND a.completeness='COMPLETE' AND m.application_status='PENDING_APPLICATION'
 AND m.application_event_id IS NULL AND m.application_digest IS NULL AND m.application_start_cursor IS NULL
 AND EXISTS(SELECT 1 FROM journal_events j WHERE j.workflow_run_id=m.workflow_run_id AND j.event_id=m.usage_event_id AND j.event_type='UsageRecorded'))))
BEGIN SELECT RAISE(ABORT,'RECOVERY_UNAUTHORIZED'); END;
CREATE TRIGGER recovery_resolved_model_no_update BEFORE UPDATE ON model_call_ledger
WHEN EXISTS(SELECT 1 FROM recovery_model_resolutions WHERE model_call_id=OLD.model_call_id)
BEGIN SELECT RAISE(ABORT,'RECOVERY_IMMUTABLE'); END;
CREATE TRIGGER recovery_resolved_attempt_no_update BEFORE UPDATE ON model_call_attempts
WHEN EXISTS(SELECT 1 FROM recovery_model_resolutions WHERE model_call_id=OLD.model_call_id)
BEGIN SELECT RAISE(ABORT,'RECOVERY_IMMUTABLE'); END;

ALTER TABLE runtime_audit_events ADD COLUMN execution_plan_id TEXT REFERENCES recovery_execution_plans(execution_plan_id);
ALTER TABLE runtime_audit_events ADD COLUMN execution_authorization_id TEXT REFERENCES recovery_execution_grants(authorization_id);
ALTER TABLE runtime_audit_events ADD COLUMN recovery_operation_id TEXT REFERENCES recovery_execution_operations(operation_id) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX recovery_execution_audit_by_operation ON runtime_audit_events(recovery_operation_id,audit_sequence);
CREATE INDEX recovery_execution_audit_by_plan ON runtime_audit_events(execution_plan_id,audit_sequence);
${audit('recovery_execution_plans','INSERT',"'RECOVERY_EXECUTION_PLAN_CREATED'",'NEW.execution_plan_id','NULL','NULL','NULL','NEW.plan_digest','NULL',"'DRAFT'")}
${audit('recovery_execution_grants','INSERT',"'RECOVERY_EXECUTION_AUTHORIZED'",'NEW.execution_plan_id','NEW.authorization_id','NULL','NULL','NEW.grant_digest',"'DRAFT'","'AUTHORIZED'")}
${audit('recovery_execution_grants','UPDATE',"CASE WHEN NEW.status='CONSUMED' THEN 'RECOVERY_GRANT_CONSUMED' ELSE 'RECOVERY_EXECUTION_REVOKED' END",'NEW.execution_plan_id','NEW.authorization_id','NEW.consumed_operation_id','NULL','NEW.grant_digest',"'AUTHORIZED'",'NEW.status','NEW.revocation_reason')}
${audit('recovery_execution_operations','INSERT',"'RECOVERY_OPERATION_COMMITTED'",'NEW.execution_plan_id','NULL','NEW.operation_id','NULL','NEW.receipt_digest','NULL',"'COMMITTED'")}
CREATE TRIGGER recovery_execution_operation_detail_audit AFTER INSERT ON recovery_execution_operations
WHEN NEW.operation_kind IN ('CANCEL_UNSENT_MODEL','DISCARD_SETTLED_RESPONSE','COMPLETE_SAFETY_STOP') BEGIN
 INSERT INTO runtime_audit_events (${auditColumns}) VALUES (
 lower(hex(randomblob(16))),NEW.workflow_run_id,CASE NEW.operation_kind
 WHEN 'CANCEL_UNSENT_MODEL' THEN 'RECOVERY_MODEL_CANCELLED_UNSENT'
 WHEN 'DISCARD_SETTLED_RESPONSE' THEN 'RECOVERY_MODEL_RESPONSE_DISCARDED' ELSE 'RECOVERY_SAFETY_STOP_COMPLETED' END,
 'WORKFLOW',NEW.workflow_run_id,NEW.execution_plan_id,NULL,NEW.operation_id,NULL,NEW.receipt_digest,
 map_safe_recovery_actor(),NULL,'COMMITTED',NULL,${now},${now},1,map_runtime_id(),map_runtime_generation());
END;
${audit('recovery_hold_transitions','INSERT',"'RECOVERY_HOLD_STEP_APPLIED'",
 '(SELECT execution_plan_id FROM recovery_execution_operations WHERE operation_id=NEW.operation_id)','NULL','NEW.operation_id','NEW.revision',
 '(SELECT receipt_digest FROM recovery_execution_operations WHERE operation_id=NEW.operation_id)',"'HELD'",'NEW.state')}
DROP TRIGGER recovery_audit_guard;
CREATE TRIGGER recovery_audit_guard BEFORE INSERT ON runtime_audit_events WHEN
 (NEW.event_kind LIKE 'RECOVERY_%' OR NEW.recovery_plan_id IS NOT NULL OR NEW.recovery_authorization_id IS NOT NULL
 OR NEW.recovery_hold_revision IS NOT NULL OR NEW.recovery_record_digest IS NOT NULL OR NEW.recovery_actor_id IS NOT NULL
 OR NEW.execution_plan_id IS NOT NULL OR NEW.execution_authorization_id IS NOT NULL OR NEW.recovery_operation_id IS NOT NULL)
 AND NOT (
 (NEW.execution_plan_id IS NULL AND NEW.execution_authorization_id IS NULL AND NEW.recovery_operation_id IS NULL
 AND map_recovery_audit(NEW.workflow_run_id,NEW.event_kind,NEW.recovery_plan_id,NEW.recovery_authorization_id,NEW.recovery_hold_revision)=1)
 OR (NEW.recovery_plan_id IS NULL AND NEW.recovery_authorization_id IS NULL
 AND map_safe_recovery_audit(NEW.workflow_run_id,NEW.event_kind,NEW.execution_plan_id,NEW.execution_authorization_id,NEW.recovery_operation_id,NEW.recovery_hold_revision)=1))
BEGIN SELECT RAISE(ABORT,'RECOVERY_UNAUTHORIZED'); END;

-- Hold exceptions are transaction-local, target-bound and limited to fixed
-- recorded-result/safety-stop events. All other v6 hold guards remain in force.
DROP TRIGGER recovery_hold_journal_events_INSERT;
CREATE TRIGGER recovery_hold_journal_events_INSERT BEFORE INSERT ON journal_events
WHEN EXISTS(SELECT 1 FROM recovery_holds WHERE workflow_run_id=NEW.workflow_run_id)
 AND map_safe_recovery_write(NEW.workflow_run_id,'journal_events','INSERT',NEW.event_id,NEW.payload)<>1
BEGIN SELECT RAISE(ABORT,'RECOVERY_HELD'); END;
DROP TRIGGER recovery_hold_workflow_seeds_UPDATE;
CREATE TRIGGER recovery_hold_workflow_seeds_UPDATE BEFORE UPDATE ON workflow_seeds
WHEN (EXISTS(SELECT 1 FROM recovery_holds WHERE workflow_run_id=NEW.workflow_run_id)
 OR EXISTS(SELECT 1 FROM recovery_holds WHERE workflow_run_id=OLD.workflow_run_id))
 AND map_safe_recovery_write(NEW.workflow_run_id,'workflow_seeds','UPDATE',NEW.workflow_run_id,json_array(NEW.last_sequence,NEW.journal_anchor))<>1
BEGIN SELECT RAISE(ABORT,'RECOVERY_HELD'); END;
DROP TRIGGER recovery_hold_execution_ledger_UPDATE;
CREATE TRIGGER recovery_hold_execution_ledger_UPDATE BEFORE UPDATE ON execution_ledger
WHEN (EXISTS(SELECT 1 FROM recovery_holds WHERE workflow_run_id=NEW.workflow_run_id)
 OR EXISTS(SELECT 1 FROM recovery_holds WHERE workflow_run_id=OLD.workflow_run_id))
 AND map_safe_recovery_write(NEW.workflow_run_id,'execution_ledger','UPDATE',NEW.action_id,
 json_object('old',json_array(OLD.state,OLD.review_reason,OLD.finalized_event_id,OLD.result_ref,OLD.result_digest,OLD.attempt_id,OLD.reserved_at,OLD.updated_at),
 'next',json_array(NEW.state,NEW.review_reason,NEW.finalized_event_id,NEW.result_ref,NEW.result_digest,NEW.attempt_id,NEW.reserved_at,NEW.updated_at)))<>1
BEGIN SELECT RAISE(ABORT,'RECOVERY_HELD'); END;
`;
