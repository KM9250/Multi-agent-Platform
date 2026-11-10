import { DATABASE_NOW_SQL as now } from './leaseSchema';

// Frozen migration-local literals. Never extend a previous migration's constants.
const contract = 'COORD-5C-4B2:CONTROLLED_EXECUTION:1';
const operation = 'ALLOW_PREPARED_DISPATCH';
export const CONTROLLED_COLUMNS: Record<string, readonly string[]> = {
  recovery_controlled_plans: ['plan_id','workflow_run_id','action_id','plan_json','plan_digest','runtime_instance_id','runtime_generation','contract_version','operation_kind'],
  recovery_controlled_grants: ['authorization_id','plan_id','workflow_run_id','action_id','grant_json','grant_digest','authorized_actor_id','expires_at','status','consumed_operation_id','revoked_at','revoked_actor_id'],
  recovery_dispatch_intents: ['operation_id','plan_id','workflow_run_id','action_id','attempt_id','intent_json','intent_digest','runtime_instance_id','runtime_generation'],
  recovery_dispatch_grants: ['authorization_id','operation_id','plan_id','workflow_run_id'],
  recovery_dispatch_receipts: ['operation_id','plan_id','workflow_run_id','action_id','attempt_id','result_ref','result_digest','receipt_json','receipt_digest'],
  recovery_dispatch_evidence: ['evidence_ref','operation_id','workflow_run_id','action_id','attempt_id','content_digest','size_bytes'],
  execution_ledger: ['workflow_run_id','session_id','task_id','action_id','fingerprint','executor_id','attempt_id','state','reserved_at','result_ref','result_digest','updated_at','schema_version','review_reason','finalized_event_id'],
  execution_results: ['result_ref','workflow_run_id','session_id','task_id','action_id','fingerprint','executor_id','attempt_id','result_json','result_digest','created_at','schema_version'],
  runner_evidence: ['evidence_ref','workflow_run_id','session_id','task_id','action_id','kind','content_json','content_digest','created_at','schema_version'],
};
const vector = (table: string, prefix: string) => `json_array(${CONTROLLED_COLUMNS[table].map(k => `${prefix}.${k}`).join(',')})`;
const allowed = (table: string, update = false) => `map_controlled_write('${table}',${update ? vector(table,'OLD') : 'NULL'},${vector(table,'NEW')})=1`;
const immutable = (table: string) => `
CREATE TRIGGER ${table}_immutable BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'RECOVERY_IMMUTABLE'); END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'RECOVERY_IMMUTABLE'); END;`;
const guard = (table: string, op = 'INSERT') => `
CREATE TRIGGER ${table}_controlled_${op} BEFORE ${op} ON ${table} WHEN NOT (${allowed(table,op === 'UPDATE')})
BEGIN SELECT RAISE(ABORT,'RECOVERY_UNAUTHORIZED'); END;
CREATE TRIGGER ${table}_fence_${op} BEFORE ${op} ON ${table} WHEN NOT EXISTS (
 SELECT 1 FROM runtime_leases l WHERE l.workflow_run_id=NEW.workflow_run_id
 AND map_fence_valid(l.workflow_run_id,l.owner_instance_id,l.generation,l.lease_capability_hash,l.lease_state,l.expires_at,${now})=1)
BEGIN SELECT RAISE(ABORT,'LEASE_FENCED'); END;`;
const audit = (table: string, op: string, event: string, hash: string, grant='NULL', intent='NULL', state='NULL') => `
CREATE TRIGGER ${table}_audit_${op} AFTER ${op} ON ${table} BEGIN
 INSERT INTO runtime_audit_events (audit_event_id,workflow_run_id,event_kind,entity_kind,entity_id,
 controlled_plan_id,controlled_grant_id,dispatch_operation_id,recovery_record_digest,recovery_actor_id,
 next_state,occurred_at,recorded_at,schema_version,runtime_instance_id,runtime_generation)
 VALUES (lower(hex(randomblob(16))),NEW.workflow_run_id,${event},'WORKFLOW',NEW.workflow_run_id,
 NEW.plan_id,${grant},${intent},${hash},map_controlled_actor(),${state},${now},${now},1,map_runtime_id(),map_runtime_generation());
END;`;

export const CONTROLLED_RECOVERY_SQL = `
CREATE TABLE recovery_controlled_plans (
 plan_id TEXT PRIMARY KEY NOT NULL, workflow_run_id TEXT NOT NULL, action_id TEXT NOT NULL,
 plan_json TEXT NOT NULL CHECK(json_valid(plan_json)), plan_digest TEXT NOT NULL CHECK(length(plan_digest)=64),
 runtime_instance_id TEXT NOT NULL, runtime_generation INTEGER NOT NULL CHECK(runtime_generation>=1),
 contract_version TEXT NOT NULL CHECK(contract_version='${contract}'),
 operation_kind TEXT NOT NULL CHECK(operation_kind='${operation}'),
 UNIQUE(plan_id,workflow_run_id,action_id), UNIQUE(plan_id,workflow_run_id),
 FOREIGN KEY(workflow_run_id,action_id) REFERENCES pending_actions(workflow_run_id,action_id),
 CHECK(json_extract(plan_json,'$.planId') IS plan_id), CHECK(json_extract(plan_json,'$.workflowRunId') IS workflow_run_id),
 CHECK(json_extract(plan_json,'$.actionId') IS action_id), CHECK(json_extract(plan_json,'$.planDigest') IS plan_digest),
 CHECK(json_extract(plan_json,'$.operationContractVersion') IS contract_version), CHECK(json_extract(plan_json,'$.operationKind') IS operation_kind),
 CHECK(json_extract(plan_json,'$.runtimeInstanceId') IS runtime_instance_id), CHECK(json_extract(plan_json,'$.runtimeGeneration') IS runtime_generation),
 CHECK(json_extract(plan_json,'$.maxActionDispatches') IS 1), CHECK(json_extract(plan_json,'$.maxModelCalls') IS 0), CHECK(json_extract(plan_json,'$.maxRounds') IS 0),
 CHECK(json_extract(plan_json,'$.sendDeadline') > json_extract(plan_json,'$.createdAt'))
) STRICT;
${immutable('recovery_controlled_plans')}${guard('recovery_controlled_plans')}
CREATE TABLE recovery_controlled_grants (
 authorization_id TEXT PRIMARY KEY NOT NULL, plan_id TEXT NOT NULL, workflow_run_id TEXT NOT NULL, action_id TEXT NOT NULL,
 grant_json TEXT NOT NULL CHECK(json_valid(grant_json)), grant_digest TEXT NOT NULL CHECK(length(grant_digest)=64),
 authorized_actor_id TEXT NOT NULL, expires_at INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('AUTHORIZED','CONSUMED','REVOKED')), consumed_operation_id TEXT,
 revoked_at INTEGER, revoked_actor_id TEXT,
 UNIQUE(plan_id,authorized_actor_id), UNIQUE(authorization_id,consumed_operation_id,plan_id,workflow_run_id),
 CHECK((status='CONSUMED')=(consumed_operation_id IS NOT NULL)),
 CHECK((status='REVOKED')=(revoked_at IS NOT NULL AND revoked_actor_id IS NOT NULL)),
 CHECK(status='REVOKED' OR (revoked_at IS NULL AND revoked_actor_id IS NULL)),
 CHECK(json_extract(grant_json,'$.authorizationId') IS authorization_id), CHECK(json_extract(grant_json,'$.planId') IS plan_id),
 CHECK(json_extract(grant_json,'$.workflowRunId') IS workflow_run_id), CHECK(json_extract(grant_json,'$.actionId') IS action_id),
 CHECK(json_extract(grant_json,'$.operationContractVersion') IS '${contract}'), CHECK(json_extract(grant_json,'$.operationKind') IS '${operation}'),
 CHECK(json_extract(grant_json,'$.authorizedActorId') IS authorized_actor_id), CHECK(json_extract(grant_json,'$.expiresAt') IS expires_at),
 FOREIGN KEY(plan_id,workflow_run_id,action_id) REFERENCES recovery_controlled_plans(plan_id,workflow_run_id,action_id),
 FOREIGN KEY(authorization_id,consumed_operation_id,plan_id,workflow_run_id)
 REFERENCES recovery_dispatch_grants(authorization_id,operation_id,plan_id,workflow_run_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
${guard('recovery_controlled_grants')}${guard('recovery_controlled_grants','UPDATE')}
CREATE TRIGGER recovery_controlled_grants_initial BEFORE INSERT ON recovery_controlled_grants WHEN
 NEW.status<>'AUTHORIZED' OR NOT EXISTS(SELECT 1 FROM recovery_controlled_plans p WHERE p.plan_id=NEW.plan_id
 AND NEW.expires_at<=json_extract(p.plan_json,'$.sendDeadline') AND NEW.expires_at>${now}
 AND json_extract(NEW.grant_json,'$.planDigest') IS p.plan_digest
 AND json_extract(NEW.grant_json,'$.runtimeInstanceId') IS p.runtime_instance_id
 AND json_extract(NEW.grant_json,'$.runtimeGeneration') IS p.runtime_generation
 AND (json_extract(p.plan_json,'$.approvalPolicy.forbidSelfApproval') IS NOT 1
 OR NEW.authorized_actor_id IS NOT json_extract(p.plan_json,'$.createdByActorId')))
BEGIN SELECT RAISE(ABORT,'RECOVERY_UNAUTHORIZED'); END;
CREATE TRIGGER recovery_controlled_grants_transition BEFORE UPDATE ON recovery_controlled_grants WHEN
 OLD.status<>'AUTHORIZED' OR NEW.status NOT IN ('CONSUMED','REVOKED')
 OR ${CONTROLLED_COLUMNS.recovery_controlled_grants.slice(0,8).map(k => `NEW.${k} IS NOT OLD.${k}`).join(' OR ')}
 OR (NEW.status='CONSUMED' AND NEW.expires_at<=${now})
BEGIN SELECT RAISE(ABORT,'RECOVERY_UNAUTHORIZED'); END;
CREATE TRIGGER recovery_controlled_grants_no_delete BEFORE DELETE ON recovery_controlled_grants BEGIN SELECT RAISE(ABORT,'RECOVERY_IMMUTABLE'); END;
CREATE TABLE recovery_dispatch_intents (
 operation_id TEXT PRIMARY KEY NOT NULL, plan_id TEXT NOT NULL UNIQUE, workflow_run_id TEXT NOT NULL, action_id TEXT NOT NULL,
 attempt_id TEXT NOT NULL UNIQUE, intent_json TEXT NOT NULL CHECK(json_valid(intent_json)), intent_digest TEXT NOT NULL CHECK(length(intent_digest)=64),
 runtime_instance_id TEXT NOT NULL, runtime_generation INTEGER NOT NULL CHECK(runtime_generation>=1),
 UNIQUE(workflow_run_id,action_id), UNIQUE(operation_id,plan_id,workflow_run_id), UNIQUE(operation_id,workflow_run_id,action_id,attempt_id),
 FOREIGN KEY(plan_id,workflow_run_id,action_id) REFERENCES recovery_controlled_plans(plan_id,workflow_run_id,action_id),
 FOREIGN KEY(workflow_run_id,action_id,attempt_id) REFERENCES execution_ledger(workflow_run_id,action_id,attempt_id),
 CHECK(json_extract(intent_json,'$.operationId') IS operation_id), CHECK(json_extract(intent_json,'$.planId') IS plan_id),
 CHECK(json_extract(intent_json,'$.workflowRunId') IS workflow_run_id), CHECK(json_extract(intent_json,'$.actionId') IS action_id),
 CHECK(json_extract(intent_json,'$.attemptId') IS attempt_id), CHECK(json_extract(intent_json,'$.runtimeInstanceId') IS runtime_instance_id),
 CHECK(json_extract(intent_json,'$.runtimeGeneration') IS runtime_generation),
 CHECK(json_extract(intent_json,'$.operationContractVersion') IS '${contract}'), CHECK(json_extract(intent_json,'$.operationKind') IS '${operation}')
) STRICT;
${immutable('recovery_dispatch_intents')}${guard('recovery_dispatch_intents')}
CREATE TRIGGER recovery_dispatch_intents_binding BEFORE INSERT ON recovery_dispatch_intents WHEN
 NEW.runtime_instance_id IS NOT map_runtime_id() OR NEW.runtime_generation IS NOT map_runtime_generation()
 OR NOT EXISTS(SELECT 1 FROM execution_ledger l WHERE l.workflow_run_id=NEW.workflow_run_id AND l.action_id=NEW.action_id
 AND l.attempt_id=NEW.attempt_id AND l.state='DISPATCH_RESERVED' AND l.result_ref IS NULL)
 OR (SELECT count(DISTINCT authorized_actor_id) FROM recovery_controlled_grants g WHERE g.plan_id=NEW.plan_id
 AND g.status='CONSUMED' AND g.consumed_operation_id=NEW.operation_id AND g.expires_at>${now})
 < (SELECT json_extract(plan_json,'$.approvalPolicy.minimumApprovers') FROM recovery_controlled_plans WHERE plan_id=NEW.plan_id)
BEGIN SELECT RAISE(ABORT,'RECOVERY_UNAUTHORIZED'); END;
CREATE TABLE recovery_dispatch_grants (
 authorization_id TEXT PRIMARY KEY NOT NULL, operation_id TEXT NOT NULL, plan_id TEXT NOT NULL, workflow_run_id TEXT NOT NULL,
 UNIQUE(authorization_id,operation_id,plan_id,workflow_run_id),
 FOREIGN KEY(operation_id,plan_id,workflow_run_id) REFERENCES recovery_dispatch_intents(operation_id,plan_id,workflow_run_id),
 FOREIGN KEY(authorization_id,operation_id,plan_id,workflow_run_id)
 REFERENCES recovery_controlled_grants(authorization_id,consumed_operation_id,plan_id,workflow_run_id)
) STRICT;
${immutable('recovery_dispatch_grants')}${guard('recovery_dispatch_grants')}
CREATE TABLE recovery_dispatch_receipts (
 operation_id TEXT PRIMARY KEY NOT NULL, plan_id TEXT NOT NULL UNIQUE, workflow_run_id TEXT NOT NULL, action_id TEXT NOT NULL,
 attempt_id TEXT NOT NULL UNIQUE, result_ref TEXT NOT NULL UNIQUE, result_digest TEXT NOT NULL,
 receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)), receipt_digest TEXT NOT NULL CHECK(length(receipt_digest)=64),
 FOREIGN KEY(operation_id,plan_id,workflow_run_id) REFERENCES recovery_dispatch_intents(operation_id,plan_id,workflow_run_id),
 FOREIGN KEY(operation_id,workflow_run_id,action_id,attempt_id) REFERENCES recovery_dispatch_intents(operation_id,workflow_run_id,action_id,attempt_id),
 FOREIGN KEY(workflow_run_id,action_id,result_ref,result_digest) REFERENCES execution_results(workflow_run_id,action_id,result_ref,result_digest),
 CHECK(json_extract(receipt_json,'$.status') IN ('RESULT_RECORDED','REVIEW_REQUIRED')),
 CHECK(json_extract(receipt_json,'$.operationId') IS operation_id), CHECK(json_extract(receipt_json,'$.planId') IS plan_id),
 CHECK(json_extract(receipt_json,'$.workflowRunId') IS workflow_run_id), CHECK(json_extract(receipt_json,'$.actionId') IS action_id),
 CHECK(json_extract(receipt_json,'$.attemptId') IS attempt_id), CHECK(json_extract(receipt_json,'$.resultRef') IS result_ref),
 CHECK(json_extract(receipt_json,'$.resultDigest') IS result_digest)
) STRICT;
${immutable('recovery_dispatch_receipts')}${guard('recovery_dispatch_receipts')}
CREATE UNIQUE INDEX controlled_evidence_owner ON runner_evidence(evidence_ref,workflow_run_id,action_id,content_digest);
CREATE TABLE recovery_dispatch_evidence (
 evidence_ref TEXT PRIMARY KEY NOT NULL, operation_id TEXT NOT NULL, workflow_run_id TEXT NOT NULL, action_id TEXT NOT NULL,
 attempt_id TEXT NOT NULL, content_digest TEXT NOT NULL, size_bytes INTEGER NOT NULL CHECK(size_bytes>0 AND size_bytes<=1048576),
 FOREIGN KEY(evidence_ref,workflow_run_id,action_id,content_digest) REFERENCES runner_evidence(evidence_ref,workflow_run_id,action_id,content_digest),
 FOREIGN KEY(operation_id,workflow_run_id,action_id,attempt_id) REFERENCES recovery_dispatch_intents(operation_id,workflow_run_id,action_id,attempt_id)
) STRICT;
${immutable('recovery_dispatch_evidence')}${guard('recovery_dispatch_evidence')}
CREATE TRIGGER recovery_dispatch_evidence_limit BEFORE INSERT ON recovery_dispatch_evidence WHEN
 (SELECT count(*) FROM recovery_dispatch_evidence WHERE operation_id=NEW.operation_id)>=16
 OR coalesce((SELECT sum(size_bytes) FROM recovery_dispatch_evidence WHERE operation_id=NEW.operation_id),0)+NEW.size_bytes>1048576
BEGIN SELECT RAISE(ABORT,'RECOVERY_UNAUTHORIZED'); END;

ALTER TABLE runtime_audit_events ADD COLUMN controlled_plan_id TEXT REFERENCES recovery_controlled_plans(plan_id);
ALTER TABLE runtime_audit_events ADD COLUMN controlled_grant_id TEXT REFERENCES recovery_controlled_grants(authorization_id);
ALTER TABLE runtime_audit_events ADD COLUMN dispatch_operation_id TEXT REFERENCES recovery_dispatch_intents(operation_id) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX controlled_audit_plan ON runtime_audit_events(controlled_plan_id,audit_sequence);
${audit('recovery_controlled_plans','INSERT',"'RECOVERY_CONTROLLED_PLAN_CREATED'",'NEW.plan_digest')}
${audit('recovery_controlled_grants','INSERT',"'RECOVERY_CONTROLLED_AUTHORIZED'",'NEW.grant_digest','NEW.authorization_id')}
${audit('recovery_controlled_grants','UPDATE',"CASE NEW.status WHEN 'CONSUMED' THEN 'RECOVERY_CONTROLLED_GRANT_CONSUMED' ELSE 'RECOVERY_CONTROLLED_REVOKED' END",'NEW.grant_digest','NEW.authorization_id','NEW.consumed_operation_id','NEW.status')}
${audit('recovery_dispatch_intents','INSERT',"'RECOVERY_DISPATCH_INTENT_COMMITTED'",'NEW.intent_digest','NULL','NEW.operation_id',"'INTENT_RECORDED'")}
${audit('recovery_dispatch_receipts','INSERT',"CASE json_extract(NEW.receipt_json,'$.status') WHEN 'REVIEW_REQUIRED' THEN 'RECOVERY_DISPATCH_REVIEW_REQUIRED' ELSE 'RECOVERY_DISPATCH_RESULT_RECORDED' END",'NEW.receipt_digest','NULL','NEW.operation_id',"json_extract(NEW.receipt_json,'$.status')")}
DROP TRIGGER recovery_audit_guard;
CREATE TRIGGER recovery_audit_guard BEFORE INSERT ON runtime_audit_events WHEN
 (NEW.event_kind LIKE 'RECOVERY_%' OR NEW.recovery_plan_id IS NOT NULL OR NEW.recovery_authorization_id IS NOT NULL
 OR NEW.recovery_hold_revision IS NOT NULL OR NEW.recovery_record_digest IS NOT NULL OR NEW.recovery_actor_id IS NOT NULL
 OR NEW.execution_plan_id IS NOT NULL OR NEW.execution_authorization_id IS NOT NULL OR NEW.recovery_operation_id IS NOT NULL
 OR NEW.controlled_plan_id IS NOT NULL OR NEW.controlled_grant_id IS NOT NULL OR NEW.dispatch_operation_id IS NOT NULL)
 AND NOT (
 (NEW.controlled_plan_id IS NULL AND NEW.controlled_grant_id IS NULL AND NEW.dispatch_operation_id IS NULL AND (
 (NEW.execution_plan_id IS NULL AND NEW.execution_authorization_id IS NULL AND NEW.recovery_operation_id IS NULL
 AND map_recovery_audit(NEW.workflow_run_id,NEW.event_kind,NEW.recovery_plan_id,NEW.recovery_authorization_id,NEW.recovery_hold_revision)=1)
 OR (NEW.recovery_plan_id IS NULL AND NEW.recovery_authorization_id IS NULL
 AND map_safe_recovery_audit(NEW.workflow_run_id,NEW.event_kind,NEW.execution_plan_id,NEW.execution_authorization_id,NEW.recovery_operation_id,NEW.recovery_hold_revision)=1)))
 OR (NEW.recovery_plan_id IS NULL AND NEW.recovery_authorization_id IS NULL AND NEW.recovery_hold_revision IS NULL
 AND NEW.execution_plan_id IS NULL AND NEW.execution_authorization_id IS NULL AND NEW.recovery_operation_id IS NULL
 AND map_controlled_audit(NEW.workflow_run_id,NEW.event_kind,NEW.controlled_plan_id,NEW.controlled_grant_id,NEW.dispatch_operation_id,NEW.recovery_record_digest,NEW.recovery_actor_id)=1))
BEGIN SELECT RAISE(ABORT,'RECOVERY_UNAUTHORIZED'); END;

DROP TRIGGER recovery_action_dispatch;
CREATE TRIGGER recovery_action_dispatch BEFORE UPDATE ON execution_ledger WHEN NEW.state='DISPATCH_RESERVED'
 AND map_recovery_start(NEW.workflow_run_id,'ACTION',NEW.action_id)=0 AND NOT (${allowed('execution_ledger',true)})
BEGIN SELECT RAISE(ABORT,'RECOVERY_HELD'); END;
DROP TRIGGER recovery_hold_execution_ledger_UPDATE;
CREATE TRIGGER recovery_hold_execution_ledger_UPDATE BEFORE UPDATE ON execution_ledger
WHEN (EXISTS(SELECT 1 FROM recovery_holds WHERE workflow_run_id=NEW.workflow_run_id)
 OR EXISTS(SELECT 1 FROM recovery_holds WHERE workflow_run_id=OLD.workflow_run_id))
 AND NOT (${allowed('execution_ledger',true)})
 AND map_safe_recovery_write(NEW.workflow_run_id,'execution_ledger','UPDATE',NEW.action_id,
 json_object('old',json_array(OLD.state,OLD.review_reason,OLD.finalized_event_id,OLD.result_ref,OLD.result_digest,OLD.attempt_id,OLD.reserved_at,OLD.updated_at),
 'next',json_array(NEW.state,NEW.review_reason,NEW.finalized_event_id,NEW.result_ref,NEW.result_digest,NEW.attempt_id,NEW.reserved_at,NEW.updated_at)))<>1
BEGIN SELECT RAISE(ABORT,'RECOVERY_HELD'); END;
${['runner_evidence','execution_results'].map(table => `
DROP TRIGGER recovery_hold_${table}_INSERT;
CREATE TRIGGER recovery_hold_${table}_INSERT BEFORE INSERT ON ${table}
WHEN EXISTS(SELECT 1 FROM recovery_holds WHERE workflow_run_id=NEW.workflow_run_id) AND NOT (${allowed(table)})
BEGIN SELECT RAISE(ABORT,'RECOVERY_HELD'); END;`).join('\n')}
`;
