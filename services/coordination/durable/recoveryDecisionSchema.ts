import { DATABASE_NOW_SQL as now } from './leaseSchema';
import { RECOVERY_CONTRACT, RECOVERY_OPERATIONS, RECOVERY_REASONS } from './recoveryDecisionTypes';
const quoted = (values: readonly string[]) => values.map(v => `'${v}'`).join(',');
const operations = quoted(RECOVERY_OPERATIONS);
const immutable = (table: string) => `
CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'RECOVERY_IMMUTABLE'); END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'RECOVERY_IMMUTABLE'); END;`;
const managed = (table: string, operation: string, kind: string, id: string) => `
CREATE TRIGGER ${table}_guard_${operation} BEFORE ${operation} ON ${table}
WHEN map_recovery_management(NEW.workflow_run_id,'${kind}',NEW.${id}) <> 1
BEGIN SELECT RAISE(ABORT,'RECOVERY_UNAUTHORIZED'); END;`;
const audit = (table: string, op: string, kind: string, plan: string, auth: string, revision: string, previous: string, next: string, reason: string) => `
CREATE TRIGGER ${table}_audit_${op} AFTER ${op} ON ${table} BEGIN
 INSERT INTO runtime_audit_events (audit_event_id,workflow_run_id,event_kind,entity_kind,entity_id,
 recovery_plan_id,recovery_authorization_id,recovery_hold_revision,recovery_record_digest,recovery_actor_id,previous_state,next_state,reason_code,
 occurred_at,recorded_at,schema_version,runtime_instance_id,runtime_generation)
 VALUES(lower(hex(randomblob(16))),NEW.workflow_run_id,'${kind}','WORKFLOW',NEW.workflow_run_id,
 ${plan},${auth},${revision},
 ${table === 'recovery_authorizations' ? 'NEW.grant_digest' : '(SELECT plan_digest FROM recovery_plans WHERE recovery_plan_id=NEW.recovery_plan_id)'},
 map_recovery_actor(),
 ${previous},${next},${reason},${now},${now},1,map_runtime_id(),map_runtime_generation());
END;`;

export const RECOVERY_DECISION_SQL = `
CREATE TABLE recovery_holds (
 workflow_run_id TEXT PRIMARY KEY NOT NULL REFERENCES workflow_seeds(workflow_run_id),
 revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
 reason_code TEXT NOT NULL CHECK(reason_code IN (${quoted(RECOVERY_REASONS)})),
 created_generation INTEGER CHECK(created_generation>=1), created_at INTEGER NOT NULL CHECK(created_at>=0),
 origin TEXT NOT NULL CHECK(origin IN ('MIGRATION','TAKEOVER','ACQUIRE','GATE')),
 active INTEGER NOT NULL CHECK(active=1)
) STRICT;
-- Pre-v6 records have no live invocation proof. Their persisted risk is retained.
INSERT INTO recovery_holds SELECT s.workflow_run_id,1,
 CASE WHEN c.coverage IS NOT 'TRACKED_FROM_CREATION' THEN 'LEGACY_COVERAGE' ELSE 'INTEGRITY_UNVERIFIED' END,
 l.generation,${now},'MIGRATION',1 FROM workflow_seeds s
 LEFT JOIN model_call_coverage c ON c.workflow_run_id=s.workflow_run_id
 LEFT JOIN runtime_leases l ON l.workflow_run_id=s.workflow_run_id
 WHERE c.coverage IS NOT 'TRACKED_FROM_CREATION'
 OR (l.lease_state='ACTIVE' AND l.expires_at<=${now})
 OR EXISTS(SELECT 1 FROM execution_ledger e WHERE e.workflow_run_id=s.workflow_run_id AND e.state IN ('DISPATCH_RESERVED','RESULT_RECORDED','REVIEW_REQUIRED'))
 OR EXISTS(SELECT 1 FROM model_call_ledger m WHERE m.workflow_run_id=s.workflow_run_id AND (m.state IN ('RESERVED','DISPATCH_INTENT','REVIEW_REQUIRED') OR m.application_status='PENDING_APPLICATION' OR m.budget_violation=1))
 OR EXISTS(SELECT 1 FROM journal_events j WHERE j.workflow_run_id=s.workflow_run_id AND j.event_type IN ('WorkflowBlocked','WorkflowSuspended'));
${immutable('recovery_holds')}
CREATE TRIGGER recovery_holds_guard BEFORE INSERT ON recovery_holds WHEN NOT (
 (NEW.origin='GATE' AND map_recovery_management(NEW.workflow_run_id,'HOLD',NEW.workflow_run_id)=1) OR
 (NEW.origin IN ('TAKEOVER','ACQUIRE') AND map_lease_change(NEW.workflow_run_id)=1
 AND EXISTS(SELECT 1 FROM runtime_leases WHERE workflow_run_id=NEW.workflow_run_id AND generation=NEW.created_generation)))
BEGIN SELECT RAISE(ABORT,'RECOVERY_UNAUTHORIZED'); END;
-- This trigger participates in the same COMMIT as LEASE_TAKEN_OVER. No grant is issued.
CREATE TRIGGER recovery_takeover AFTER UPDATE ON runtime_leases
WHEN OLD.lease_state='ACTIVE' AND NEW.generation=OLD.generation+1
BEGIN INSERT INTO recovery_holds SELECT NEW.workflow_run_id,1,'LEASE_TAKEOVER',NEW.generation,${now},'TAKEOVER',1
 WHERE NOT EXISTS(SELECT 1 FROM recovery_holds WHERE workflow_run_id=NEW.workflow_run_id); END;
CREATE TRIGGER recovery_risky_acquire AFTER UPDATE ON runtime_leases
WHEN NEW.generation=OLD.generation+1 AND OLD.lease_state='RELEASED' AND (
 EXISTS(SELECT 1 FROM model_call_coverage WHERE workflow_run_id=NEW.workflow_run_id AND coverage='LEGACY_UNTRACKED') OR
 EXISTS(SELECT 1 FROM execution_ledger WHERE workflow_run_id=NEW.workflow_run_id AND state IN ('DISPATCH_RESERVED','RESULT_RECORDED','REVIEW_REQUIRED')) OR
 EXISTS(SELECT 1 FROM model_call_ledger WHERE workflow_run_id=NEW.workflow_run_id AND (state IN ('RESERVED','DISPATCH_INTENT','REVIEW_REQUIRED') OR application_status='PENDING_APPLICATION' OR budget_violation=1)) OR
 EXISTS(SELECT 1 FROM journal_events WHERE workflow_run_id=NEW.workflow_run_id AND event_type IN ('WorkflowBlocked','WorkflowSuspended')))
BEGIN INSERT INTO recovery_holds SELECT NEW.workflow_run_id,1,'INTEGRITY_UNVERIFIED',NEW.generation,${now},'ACQUIRE',1
 WHERE NOT EXISTS(SELECT 1 FROM recovery_holds WHERE workflow_run_id=NEW.workflow_run_id); END;

CREATE TABLE recovery_plans (
 recovery_plan_id TEXT PRIMARY KEY NOT NULL, workflow_run_id TEXT NOT NULL REFERENCES workflow_seeds(workflow_run_id),
 operation_kind TEXT NOT NULL CHECK(operation_kind IN (${operations})), target_id TEXT NOT NULL CHECK(length(target_id)>0),
 plan_json TEXT NOT NULL CHECK(json_valid(plan_json)), plan_digest TEXT NOT NULL CHECK(length(plan_digest)=64),
 runtime_instance_id TEXT NOT NULL, runtime_generation INTEGER NOT NULL CHECK(runtime_generation>=1),
 journal_cursor INTEGER NOT NULL CHECK(journal_cursor>=1), hold_revision INTEGER NOT NULL CHECK(hold_revision>=0),
 contract_version TEXT NOT NULL CHECK(contract_version='${RECOVERY_CONTRACT}'),
 created_at INTEGER NOT NULL CHECK(created_at>=0), expires_at INTEGER NOT NULL CHECK(expires_at>created_at AND expires_at<=created_at+1800000),
 UNIQUE(workflow_run_id,recovery_plan_id), UNIQUE(recovery_plan_id,plan_digest)
) STRICT;
${immutable('recovery_plans')}
${managed('recovery_plans','INSERT','CREATE_PLAN','recovery_plan_id')}
CREATE TABLE recovery_plan_invalidations (
 recovery_plan_id TEXT PRIMARY KEY NOT NULL, workflow_run_id TEXT NOT NULL,
 reason_code TEXT NOT NULL CHECK(reason_code='STATE_CHANGED'), invalidated_at INTEGER NOT NULL, invalidated_actor_id TEXT NOT NULL,
 FOREIGN KEY(workflow_run_id,recovery_plan_id) REFERENCES recovery_plans(workflow_run_id,recovery_plan_id)
) STRICT;
${immutable('recovery_plan_invalidations')}
${managed('recovery_plan_invalidations','INSERT','INVALIDATE','recovery_plan_id')}
CREATE TABLE recovery_authorizations (
 authorization_id TEXT PRIMARY KEY NOT NULL, recovery_plan_id TEXT NOT NULL, workflow_run_id TEXT NOT NULL,
 operation_kind TEXT NOT NULL CHECK(operation_kind IN (${operations})), target_id TEXT NOT NULL,
 plan_digest TEXT NOT NULL, authorized_actor_id TEXT NOT NULL, authorizer_role TEXT NOT NULL CHECK(authorizer_role IN ('RECOVERY_APPROVER','RECOVERY_ADMIN')),
 authorization_source TEXT NOT NULL, authorized_at INTEGER NOT NULL, expires_at INTEGER NOT NULL CHECK(expires_at>authorized_at AND expires_at<=authorized_at+1800000),
 runtime_instance_id TEXT NOT NULL, runtime_generation INTEGER NOT NULL CHECK(runtime_generation>=1),
 contract_version TEXT NOT NULL CHECK(contract_version='${RECOVERY_CONTRACT}'),
 status TEXT NOT NULL CHECK(status IN ('AUTHORIZED','REVOKED','CONSUMED')),
 revocation_reason TEXT CHECK(revocation_reason IN ('OPERATOR_REVOKED','POLICY_CHANGED')), revoked_at INTEGER, revoked_actor_id TEXT,
 grant_digest TEXT NOT NULL CHECK(length(grant_digest)=64),
 CHECK((status='REVOKED')=(revocation_reason IS NOT NULL AND revoked_at IS NOT NULL AND revoked_actor_id IS NOT NULL)),
 UNIQUE(recovery_plan_id,authorized_actor_id), UNIQUE(workflow_run_id,authorization_id),
 FOREIGN KEY(workflow_run_id,recovery_plan_id) REFERENCES recovery_plans(workflow_run_id,recovery_plan_id),
 FOREIGN KEY(recovery_plan_id,plan_digest) REFERENCES recovery_plans(recovery_plan_id,plan_digest)
) STRICT;
${managed('recovery_authorizations','INSERT','AUTHORIZE','authorization_id')}
${managed('recovery_authorizations','UPDATE','REVOKE','authorization_id')}
CREATE TRIGGER recovery_authorizations_initial BEFORE INSERT ON recovery_authorizations WHEN
 NEW.status<>'AUTHORIZED' OR NEW.revoked_actor_id IS NOT NULL OR NEW.revoked_at IS NOT NULL OR NEW.revocation_reason IS NOT NULL OR NOT EXISTS(
 SELECT 1 FROM recovery_plans p WHERE p.recovery_plan_id=NEW.recovery_plan_id AND p.workflow_run_id=NEW.workflow_run_id
 AND p.operation_kind=NEW.operation_kind AND p.target_id=NEW.target_id AND p.plan_digest=NEW.plan_digest
 AND p.runtime_instance_id=NEW.runtime_instance_id AND p.runtime_generation=NEW.runtime_generation
 AND p.contract_version=NEW.contract_version AND NEW.expires_at<=p.expires_at AND NEW.authorized_at>=p.created_at)
BEGIN SELECT RAISE(ABORT,'RECOVERY_UNAUTHORIZED'); END;
CREATE TRIGGER recovery_authorizations_transition BEFORE UPDATE ON recovery_authorizations WHEN
 OLD.status<>'AUTHORIZED' OR NEW.status<>'REVOKED' OR NEW.revoked_at<OLD.authorized_at OR
 ${['authorization_id','recovery_plan_id','workflow_run_id','operation_kind','target_id','plan_digest','authorized_actor_id','authorizer_role','authorization_source','authorized_at','expires_at','runtime_instance_id','runtime_generation','contract_version','grant_digest'].map(k=>`NEW.${k} IS NOT OLD.${k}`).join(' OR ')}
BEGIN SELECT RAISE(ABORT,'RECOVERY_IMMUTABLE'); END;
CREATE TRIGGER recovery_authorizations_no_delete BEFORE DELETE ON recovery_authorizations BEGIN SELECT RAISE(ABORT,'RECOVERY_IMMUTABLE'); END;
CREATE TABLE recovery_operations (
 operation_id TEXT PRIMARY KEY NOT NULL, authorization_id TEXT NOT NULL UNIQUE REFERENCES recovery_authorizations(authorization_id),
 workflow_run_id TEXT NOT NULL REFERENCES workflow_seeds(workflow_run_id),
 operation_kind TEXT NOT NULL CHECK(operation_kind IN (${operations})),
 result_state TEXT NOT NULL CHECK(result_state IN ('COMMITTED','OUTCOME_UNKNOWN')), commit_evidence TEXT NOT NULL,
 FOREIGN KEY(workflow_run_id,authorization_id) REFERENCES recovery_authorizations(workflow_run_id,authorization_id)
) STRICT;
${immutable('recovery_operations')}
CREATE TRIGGER recovery_operations_disabled BEFORE INSERT ON recovery_operations BEGIN SELECT RAISE(ABORT,'RECOVERY_EXECUTION_DISABLED'); END;
CREATE TRIGGER recovery_resume_disabled BEFORE INSERT ON journal_events WHEN NEW.event_type='WorkflowResumed'
BEGIN SELECT RAISE(ABORT,'RECOVERY_EXECUTION_DISABLED'); END;
CREATE TRIGGER recovery_new_action BEFORE INSERT ON pending_actions WHEN map_recovery_start(NEW.workflow_run_id,'REGISTER',NEW.action_id)=0
BEGIN SELECT RAISE(ABORT,'RECOVERY_HELD'); END;
CREATE TRIGGER recovery_new_task BEFORE INSERT ON journal_events WHEN NEW.event_type IN ('TaskAssigned','SessionStarted')
 AND map_recovery_start(NEW.workflow_run_id,'REGISTER',NULL)=0
BEGIN SELECT RAISE(ABORT,'RECOVERY_HELD'); END;
CREATE TRIGGER recovery_action_dispatch BEFORE UPDATE ON execution_ledger WHEN NEW.state='DISPATCH_RESERVED'
 AND map_recovery_start(NEW.workflow_run_id,'ACTION',NEW.action_id)=0
BEGIN SELECT RAISE(ABORT,'RECOVERY_HELD'); END;
CREATE TRIGGER recovery_new_model BEFORE INSERT ON model_call_ledger WHEN map_recovery_start(NEW.workflow_run_id,'MODEL',NEW.model_call_id)=0
BEGIN SELECT RAISE(ABORT,'RECOVERY_HELD'); END;
CREATE TRIGGER recovery_model_intent BEFORE UPDATE ON model_call_ledger WHEN NEW.state='DISPATCH_INTENT'
 AND map_recovery_start(NEW.workflow_run_id,'MODEL',NEW.model_call_id)=0
BEGIN SELECT RAISE(ABORT,'RECOVERY_HELD'); END;
ALTER TABLE runtime_audit_events ADD COLUMN recovery_plan_id TEXT REFERENCES recovery_plans(recovery_plan_id);
ALTER TABLE runtime_audit_events ADD COLUMN recovery_authorization_id TEXT REFERENCES recovery_authorizations(authorization_id);
ALTER TABLE runtime_audit_events ADD COLUMN recovery_hold_revision INTEGER;
ALTER TABLE runtime_audit_events ADD COLUMN recovery_record_digest TEXT;
ALTER TABLE runtime_audit_events ADD COLUMN recovery_actor_id TEXT;
${audit('recovery_plans','INSERT','RECOVERY_PLAN_CREATED','NEW.recovery_plan_id','NULL','NULL','NULL',"'DRAFT'",'NULL')}
${audit('recovery_plan_invalidations','INSERT','RECOVERY_PLAN_INVALIDATED','NEW.recovery_plan_id','NULL','NULL',"'DRAFT'","'INVALIDATED'",'NEW.reason_code')}
${audit('recovery_authorizations','INSERT','RECOVERY_AUTHORIZED','NEW.recovery_plan_id','NEW.authorization_id','NULL',"'DRAFT'","'AUTHORIZED'",'NULL')}
${audit('recovery_authorizations','UPDATE','RECOVERY_REVOKED','NEW.recovery_plan_id','NEW.authorization_id','NULL',"'AUTHORIZED'","'REVOKED'",'NEW.revocation_reason')}
CREATE TRIGGER recovery_audit_guard BEFORE INSERT ON runtime_audit_events WHEN
 (NEW.event_kind LIKE 'RECOVERY_%' OR NEW.recovery_plan_id IS NOT NULL OR NEW.recovery_authorization_id IS NOT NULL OR NEW.recovery_hold_revision IS NOT NULL OR NEW.recovery_record_digest IS NOT NULL OR NEW.recovery_actor_id IS NOT NULL)
 AND map_recovery_audit(NEW.workflow_run_id,NEW.event_kind,NEW.recovery_plan_id,NEW.recovery_authorization_id,NEW.recovery_hold_revision)<>1
BEGIN SELECT RAISE(ABORT,'RECOVERY_UNAUTHORIZED'); END;
${['workflow_seeds','journal_events','workflow_checkpoints','pending_actions','execution_ledger','execution_results','runner_evidence','model_call_ledger','model_call_attempts','model_call_coverage'].flatMap(table=>['INSERT','UPDATE','DELETE'].map(op=>`
CREATE TRIGGER recovery_hold_${table}_${op} BEFORE ${op} ON ${table}
WHEN EXISTS(SELECT 1 FROM recovery_holds WHERE workflow_run_id=${op==='DELETE'?'OLD':'NEW'}.workflow_run_id)
${op==='UPDATE'?' OR EXISTS(SELECT 1 FROM recovery_holds WHERE workflow_run_id=OLD.workflow_run_id)':''}
BEGIN SELECT RAISE(ABORT,'RECOVERY_HELD'); END;`)).join('\n')}
`;
