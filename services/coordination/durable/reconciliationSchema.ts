import { DATABASE_NOW_SQL as now } from './leaseSchema';
import { CONTINUATION_SQL } from './continuationSchema';

/** SQL column order is also the exact-row capability vector. It contains no executable authority. */
export const RECONCILIATION_COLUMNS: Record<string, readonly string[]> = {
 reconciliation_evidence: ['evidence_id','logical_id','workflow_run_id','target_kind','target_id','attempt_id','version','digest','owner_id','submitted_by','data_class','content_type','size_bytes','created_at'],
 reconciliation_evidence_bodies: ['evidence_id','workflow_run_id','body_json'],
 reconciliation_verification_jobs: ['job_id','evidence_id','workflow_run_id','status','created_at','expires_at','receipt_id'],
 reconciliation_verifications: ['verification_id','evidence_id','evidence_version','workflow_run_id','target_kind','target_id','attempt_id','verifier_id','binding_digest','status','claim_json','source_effect_key','verified_at','expires_at','receipt_json','digest'],
 reconciliation_cases: ['workflow_run_id','target_kind','target_id','attempt_id','revision','case_json','created_at'],
 reconciliation_plans: ['plan_id','workflow_run_id','target_kind','target_id','attempt_id','operation_kind','plan_digest','plan_json','created_by','created_at','expires_at','runtime_instance_id','generation'],
 reconciliation_grants: ['grant_id','plan_id','workflow_run_id','actor_id','status','grant_json','grant_digest','expires_at','consumed_operation_id','revoked_at','revoked_by'],
 reconciliation_operations: ['operation_id','plan_id','workflow_run_id','target_kind','target_id','attempt_id','operation_kind','receipt_json','receipt_digest','created_at'],
 reconciliation_operation_grants: ['operation_id','grant_id','plan_id','workflow_run_id'],
 reconciled_action_outcomes: ['operation_id','workflow_run_id','action_id','attempt_id','verification_id','source_effect_key','outcome_kind','source_json','source_digest','result_json','created_at'],
 reconciled_model_usages: ['operation_id','workflow_run_id','model_call_id','attempt_id','verification_id','source_effect_key','usage_json','usage_digest','llm_calls','input_tokens','output_tokens','cost_micros','response_status','budget_violation','source_json','source_digest','created_at'],
 reconciled_action_applications: ['operation_id','workflow_run_id','action_id','attempt_id','outcome_operation_id','task_id','event_id','result_ref','result_json','result_digest','created_at'],
 model_usage_authorities: ['workflow_run_id','model_call_id','attempt_id','authority','usage_event_id','operation_id','usage_json','usage_digest','cost_micros','created_at'],
 reconciliation_target_seals: ['workflow_run_id','target_kind','target_id','attempt_id','operation_id','revision','created_at'],
 reconciliation_disputes: ['dispute_id','workflow_run_id','target_kind','target_id','attempt_id','verification_id','prior_verification_id','reason_code','created_at'],
 reconciliation_audit: ['audit_id','workflow_run_id','event_kind','record_id','actor_id','record_digest','runtime_instance_id','generation','recorded_at'],
};
const immutable = (table:string) => `CREATE TRIGGER ${table}_reconciliation_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'RECOVERY_IMMUTABLE'); END;
CREATE TRIGGER ${table}_reconciliation_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'RECOVERY_IMMUTABLE'); END;`;
const vector=(table:string,prefix:string)=>`json_array(${RECONCILIATION_COLUMNS[table].map(c=>`${prefix}.${c}`).join(',')})`;
const fence=(table:string,op:string)=>`CREATE TRIGGER ${table}_reconciliation_fence_${op} BEFORE ${op} ON ${table} WHEN NOT EXISTS (
 SELECT 1 FROM runtime_leases l WHERE l.workflow_run_id=NEW.workflow_run_id AND map_fence_valid(l.workflow_run_id,l.owner_instance_id,l.generation,l.lease_capability_hash,l.lease_state,l.expires_at,${now})=1)
BEGIN SELECT RAISE(ABORT,'LEASE_FENCED'); END;`;
const guard=(table:string,op='INSERT')=>`${fence(table,op)}
CREATE TRIGGER ${table}_reconciliation_scope_${op} BEFORE ${op} ON ${table}
WHEN map_reconciliation_write('${table}',${op==='UPDATE'?vector(table,'OLD'):'NULL'},${vector(table,'NEW')})<>1
BEGIN SELECT RAISE(ABORT,'RECOVERY_UNAUTHORIZED'); END;`;
const target=`target_kind TEXT NOT NULL CHECK(target_kind IN ('ACTION','MODEL')), target_id TEXT NOT NULL CHECK(length(target_id) BETWEEN 1 AND 160), attempt_id TEXT NOT NULL CHECK(length(attempt_id) BETWEEN 1 AND 160)`;
const kinds="'RECORD_VERIFIED_ACTION_OUTCOME','SETTLE_VERIFIED_MODEL_USAGE','APPLY_RECONCILED_ACTION_RESULT'";
const hash=(name:string)=>`${name} TEXT NOT NULL CHECK(length(${name})=64)`;
const json=(name:string,max=131072)=>`${name} TEXT NOT NULL CHECK(json_valid(${name}) AND length(CAST(${name} AS BLOB))<=${max})`;
const amount=(name:string)=>`${name} INTEGER NOT NULL CHECK(${name} BETWEEN 0 AND 9007199254740991)`;
// Preserve every historical migration string. Only the latest guard versions are extended.
const holdGuards = [...CONTINUATION_SQL.matchAll(/CREATE TRIGGER (recovery_hold_\w+) BEFORE (INSERT|UPDATE|DELETE) ON (\w+)[\s\S]*?END;/g)]
 .filter(m=>m[2]!=='DELETE' && m[1]===`recovery_hold_${m[3]}_${m[2]}` && ['journal_events','workflow_seeds'].includes(m[3]))
 .map(m=>`DROP TRIGGER ${m[1]};\n${m[0].replace('WHEN ','WHEN (').replace('BEGIN SELECT RAISE',`) AND map_reconciliation_business(${m[2]==='DELETE'?'OLD':'NEW'}.workflow_run_id,'${m[3]}','${m[2]}',${m[3]==='journal_events'?'NEW.event_id':'NEW.last_sequence'},${m[3]==='journal_events'?'NEW.payload':'NEW.journal_anchor'})<>1\nBEGIN SELECT RAISE`)}`).join('\n');
const generationHold=CONTINUATION_SQL.match(/CREATE TRIGGER bounded_generation_hold[\s\S]*?END;/)![0]
 .replace(/EXISTS\(SELECT 1 FROM model_call_ledger WHERE workflow_run_id=NEW.workflow_run_id AND \(state IN \('RESERVED','DISPATCH_INTENT','REVIEW_REQUIRED'\) OR application_status='PENDING_APPLICATION' OR budget_violation=1\)\)/,
  "map_reconciliation_unresolved(NEW.workflow_run_id,'MODEL')=1")
 .replace("EXISTS(SELECT 1 FROM execution_ledger WHERE workflow_run_id=NEW.workflow_run_id AND state IN ('DISPATCH_RESERVED','RESULT_RECORDED','REVIEW_REQUIRED'))",
  "map_reconciliation_unresolved(NEW.workflow_run_id,'ACTION')=1");
export const RECONCILIATION_SQL = `
CREATE UNIQUE INDEX reconciliation_model_attempt_identity ON model_call_ledger(workflow_run_id,model_call_id,attempt_id);
CREATE TABLE reconciliation_evidence (
 evidence_id TEXT PRIMARY KEY NOT NULL, logical_id TEXT NOT NULL, workflow_run_id TEXT NOT NULL REFERENCES workflow_seeds(workflow_run_id),
 ${target}, version INTEGER NOT NULL CHECK(version BETWEEN 1 AND 9007199254740991), ${hash('digest')},
 owner_id TEXT NOT NULL, submitted_by TEXT NOT NULL, data_class TEXT NOT NULL, content_type TEXT NOT NULL CHECK(content_type IN ('application/json','text/plain')),
 size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 0 AND 262144), created_at INTEGER NOT NULL CHECK(created_at>=0),
 UNIQUE(workflow_run_id,evidence_id), UNIQUE(workflow_run_id,logical_id,version), UNIQUE(workflow_run_id,evidence_id,version)
) STRICT;
CREATE TABLE reconciliation_evidence_bodies (
 evidence_id TEXT PRIMARY KEY NOT NULL, workflow_run_id TEXT NOT NULL, ${json('body_json',262144)},
 FOREIGN KEY(workflow_run_id,evidence_id) REFERENCES reconciliation_evidence(workflow_run_id,evidence_id)
) STRICT;
CREATE TABLE reconciliation_verification_jobs (
 job_id TEXT PRIMARY KEY NOT NULL, evidence_id TEXT NOT NULL, workflow_run_id TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('PENDING','COMPLETE','CANCELLED')), created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL CHECK(expires_at>created_at), receipt_id TEXT,
 UNIQUE(workflow_run_id,job_id), FOREIGN KEY(workflow_run_id,evidence_id) REFERENCES reconciliation_evidence(workflow_run_id,evidence_id),
 FOREIGN KEY(workflow_run_id,receipt_id) REFERENCES reconciliation_verifications(workflow_run_id,verification_id) DEFERRABLE INITIALLY DEFERRED,
 CHECK((status='COMPLETE')=(receipt_id IS NOT NULL))
) STRICT;
CREATE TABLE reconciliation_verifications (
 verification_id TEXT PRIMARY KEY NOT NULL, evidence_id TEXT NOT NULL, evidence_version INTEGER NOT NULL, workflow_run_id TEXT NOT NULL,
 ${target}, verifier_id TEXT NOT NULL, ${hash('binding_digest')}, status TEXT NOT NULL CHECK(status IN ('VERIFIED','INCOMPLETE','REJECTED','CONFLICT')),
 ${json('claim_json',65536)}, source_effect_key TEXT, verified_at INTEGER NOT NULL, expires_at INTEGER NOT NULL CHECK(expires_at>verified_at),
 ${json('receipt_json')}, ${hash('digest')}, UNIQUE(workflow_run_id,verification_id),
 FOREIGN KEY(workflow_run_id,evidence_id,evidence_version) REFERENCES reconciliation_evidence(workflow_run_id,evidence_id,version)
) STRICT;
CREATE TABLE reconciliation_cases (
 workflow_run_id TEXT NOT NULL REFERENCES workflow_seeds(workflow_run_id), ${target}, revision INTEGER NOT NULL CHECK(revision>=1), ${json('case_json')}, created_at INTEGER NOT NULL,
 PRIMARY KEY(workflow_run_id,target_kind,target_id,attempt_id,revision)
) STRICT;
CREATE TABLE reconciliation_plans (
 plan_id TEXT PRIMARY KEY NOT NULL, workflow_run_id TEXT NOT NULL REFERENCES workflow_seeds(workflow_run_id), ${target},
 operation_kind TEXT NOT NULL CHECK(operation_kind IN (${kinds})), ${hash('plan_digest')}, ${json('plan_json')}, created_by TEXT NOT NULL,
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL CHECK(expires_at>created_at AND expires_at<=created_at+1800000), runtime_instance_id TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation>=1),
 UNIQUE(workflow_run_id,plan_id), UNIQUE(workflow_run_id,plan_id,plan_digest), UNIQUE(workflow_run_id,plan_id,target_kind,target_id,attempt_id,operation_kind)
) STRICT;
CREATE TABLE reconciliation_grants (
 grant_id TEXT PRIMARY KEY NOT NULL, plan_id TEXT NOT NULL, workflow_run_id TEXT NOT NULL, actor_id TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('AUTHORIZED','REVOKED','CONSUMED')), ${json('grant_json')}, ${hash('grant_digest')}, expires_at INTEGER NOT NULL,
 consumed_operation_id TEXT, revoked_at INTEGER, revoked_by TEXT,
 UNIQUE(plan_id,actor_id), UNIQUE(workflow_run_id,grant_id), UNIQUE(workflow_run_id,grant_id,plan_id),
 FOREIGN KEY(workflow_run_id,plan_id) REFERENCES reconciliation_plans(workflow_run_id,plan_id),
 FOREIGN KEY(workflow_run_id,consumed_operation_id) REFERENCES reconciliation_operations(workflow_run_id,operation_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(workflow_run_id,grant_id,plan_id,consumed_operation_id) REFERENCES reconciliation_operation_grants(workflow_run_id,grant_id,plan_id,operation_id) DEFERRABLE INITIALLY DEFERRED,
 CHECK((status='CONSUMED')=(consumed_operation_id IS NOT NULL)), CHECK((status='REVOKED')=(revoked_at IS NOT NULL AND revoked_by IS NOT NULL)), CHECK((revoked_at IS NULL)=(revoked_by IS NULL))
) STRICT;
CREATE TABLE reconciliation_operations (
 operation_id TEXT PRIMARY KEY NOT NULL, plan_id TEXT NOT NULL UNIQUE, workflow_run_id TEXT NOT NULL, ${target},
 operation_kind TEXT NOT NULL CHECK(operation_kind IN (${kinds})), ${json('receipt_json')}, ${hash('receipt_digest')}, created_at INTEGER NOT NULL,
 UNIQUE(workflow_run_id,operation_id), UNIQUE(workflow_run_id,operation_id,plan_id),
 FOREIGN KEY(workflow_run_id,plan_id,target_kind,target_id,attempt_id,operation_kind) REFERENCES reconciliation_plans(workflow_run_id,plan_id,target_kind,target_id,attempt_id,operation_kind)
) STRICT;
CREATE TABLE reconciliation_operation_grants (
 operation_id TEXT NOT NULL, grant_id TEXT NOT NULL UNIQUE, plan_id TEXT NOT NULL, workflow_run_id TEXT NOT NULL, PRIMARY KEY(operation_id,grant_id), UNIQUE(workflow_run_id,grant_id,plan_id,operation_id),
 FOREIGN KEY(workflow_run_id,operation_id,plan_id) REFERENCES reconciliation_operations(workflow_run_id,operation_id,plan_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(workflow_run_id,grant_id,plan_id) REFERENCES reconciliation_grants(workflow_run_id,grant_id,plan_id)
) STRICT;
CREATE TABLE reconciled_action_outcomes (
 operation_id TEXT PRIMARY KEY NOT NULL, workflow_run_id TEXT NOT NULL, action_id TEXT NOT NULL, attempt_id TEXT NOT NULL, verification_id TEXT NOT NULL,
 source_effect_key TEXT NOT NULL UNIQUE CHECK(length(source_effect_key)=64), outcome_kind TEXT NOT NULL CHECK(outcome_kind IN ('EXECUTED_FINAL','NOT_EXECUTED_FINAL','PARTIAL_EFFECT','UNKNOWN')),
 ${json('source_json')}, ${hash('source_digest')}, result_json TEXT CHECK(result_json IS NULL OR (json_valid(result_json) AND length(CAST(result_json AS BLOB))<=65536)), created_at INTEGER NOT NULL,
 UNIQUE(workflow_run_id,action_id,attempt_id), UNIQUE(workflow_run_id,operation_id),
 FOREIGN KEY(workflow_run_id,action_id,attempt_id) REFERENCES execution_ledger(workflow_run_id,action_id,attempt_id),
 FOREIGN KEY(workflow_run_id,operation_id) REFERENCES reconciliation_operations(workflow_run_id,operation_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(workflow_run_id,verification_id) REFERENCES reconciliation_verifications(workflow_run_id,verification_id)
) STRICT;
CREATE TABLE reconciled_model_usages (
 operation_id TEXT PRIMARY KEY NOT NULL, workflow_run_id TEXT NOT NULL, model_call_id TEXT NOT NULL, attempt_id TEXT NOT NULL, verification_id TEXT NOT NULL,
 source_effect_key TEXT NOT NULL UNIQUE CHECK(length(source_effect_key)=64), ${json('usage_json',65536)}, ${hash('usage_digest')}, llm_calls INTEGER NOT NULL CHECK(llm_calls=1),
 ${amount('input_tokens')}, ${amount('output_tokens')}, ${amount('cost_micros')},
 response_status TEXT NOT NULL CHECK(response_status IN ('APPLIED','DISCARDED','NOT_APPLICABLE_VERIFIED','UNAVAILABLE_REVIEW_REQUIRED')),
 budget_violation INTEGER NOT NULL CHECK(budget_violation IN (0,1)), ${json('source_json')}, ${hash('source_digest')}, created_at INTEGER NOT NULL,
 UNIQUE(workflow_run_id,model_call_id,attempt_id), UNIQUE(workflow_run_id,operation_id),
 FOREIGN KEY(workflow_run_id,model_call_id,attempt_id) REFERENCES model_call_ledger(workflow_run_id,model_call_id,attempt_id),
 FOREIGN KEY(attempt_id) REFERENCES model_call_attempts(attempt_id),
 FOREIGN KEY(workflow_run_id,operation_id) REFERENCES reconciliation_operations(workflow_run_id,operation_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(workflow_run_id,verification_id) REFERENCES reconciliation_verifications(workflow_run_id,verification_id)
) STRICT;
CREATE TABLE reconciled_action_applications (
 operation_id TEXT PRIMARY KEY NOT NULL, workflow_run_id TEXT NOT NULL, action_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
 outcome_operation_id TEXT NOT NULL UNIQUE, task_id TEXT NOT NULL, event_id TEXT NOT NULL UNIQUE, result_ref TEXT NOT NULL, ${json('result_json',65536)}, ${hash('result_digest')}, created_at INTEGER NOT NULL,
 UNIQUE(workflow_run_id,task_id), UNIQUE(workflow_run_id,operation_id),
 FOREIGN KEY(workflow_run_id,action_id,attempt_id) REFERENCES execution_ledger(workflow_run_id,action_id,attempt_id),
 FOREIGN KEY(workflow_run_id,outcome_operation_id) REFERENCES reconciled_action_outcomes(workflow_run_id,operation_id),
 FOREIGN KEY(workflow_run_id,operation_id) REFERENCES reconciliation_operations(workflow_run_id,operation_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(workflow_run_id,event_id) REFERENCES journal_events(workflow_run_id,event_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE model_usage_authorities (
 workflow_run_id TEXT NOT NULL, model_call_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
 authority TEXT NOT NULL CHECK(authority IN ('NORMAL','RECONCILED')), usage_event_id TEXT, operation_id TEXT,
 ${json('usage_json',65536)}, ${hash('usage_digest')}, ${amount('cost_micros')}, created_at INTEGER NOT NULL,
 PRIMARY KEY(workflow_run_id,model_call_id,attempt_id), UNIQUE(usage_event_id), UNIQUE(operation_id),
 FOREIGN KEY(workflow_run_id,model_call_id,attempt_id) REFERENCES model_call_ledger(workflow_run_id,model_call_id,attempt_id), FOREIGN KEY(attempt_id) REFERENCES model_call_attempts(attempt_id),
 FOREIGN KEY(workflow_run_id,usage_event_id) REFERENCES journal_events(workflow_run_id,event_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(workflow_run_id,operation_id) REFERENCES reconciled_model_usages(workflow_run_id,operation_id) DEFERRABLE INITIALLY DEFERRED,
 CHECK((authority='NORMAL' AND usage_event_id IS NOT NULL AND operation_id IS NULL) OR (authority='RECONCILED' AND usage_event_id IS NULL AND operation_id IS NOT NULL))
) STRICT;
CREATE TABLE reconciliation_target_seals (
 workflow_run_id TEXT NOT NULL, ${target}, operation_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=1), created_at INTEGER NOT NULL,
 PRIMARY KEY(workflow_run_id,target_kind,target_id,attempt_id),
 FOREIGN KEY(workflow_run_id,operation_id) REFERENCES reconciliation_operations(workflow_run_id,operation_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE reconciliation_disputes (
 dispute_id TEXT PRIMARY KEY NOT NULL, workflow_run_id TEXT NOT NULL REFERENCES workflow_seeds(workflow_run_id), ${target}, verification_id TEXT NOT NULL,
 prior_verification_id TEXT, reason_code TEXT NOT NULL, created_at INTEGER NOT NULL,
 FOREIGN KEY(workflow_run_id,verification_id) REFERENCES reconciliation_verifications(workflow_run_id,verification_id),
 FOREIGN KEY(workflow_run_id,prior_verification_id) REFERENCES reconciliation_verifications(workflow_run_id,verification_id)
) STRICT;
CREATE TABLE reconciliation_audit (
 audit_id TEXT PRIMARY KEY NOT NULL, workflow_run_id TEXT NOT NULL REFERENCES workflow_seeds(workflow_run_id),
 event_kind TEXT NOT NULL CHECK(event_kind IN ('RECONCILIATION_EVIDENCE_SUBMITTED','RECONCILIATION_VERIFICATION_STARTED','RECONCILIATION_VERIFICATION_RECORDED','RECONCILIATION_VERIFICATION_CANCELLED','RECONCILIATION_PLAN_CREATED','RECONCILIATION_AUTHORIZED','RECONCILIATION_REVOKED','RECONCILIATION_GRANT_CONSUMED','RECONCILIATION_ACTION_OUTCOME_RECORDED','RECONCILIATION_MODEL_USAGE_SETTLED','RECONCILIATION_ACTION_RESULT_APPLIED','RECONCILIATION_DISPUTE_RECORDED','RECONCILIATION_OPERATION_COMMITTED')),
 record_id TEXT NOT NULL, actor_id TEXT NOT NULL, ${hash('record_digest')}, runtime_instance_id TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation>=1), recorded_at INTEGER NOT NULL
) STRICT;
-- Backfill only independently validated SETTLED records; validation runs before migration SQL.
INSERT INTO model_usage_authorities SELECT workflow_run_id,model_call_id,attempt_id,'NORMAL',usage_event_id,NULL,usage_json,map_reconciliation_digest(usage_json),usage_cost,settled_at FROM model_call_ledger WHERE state='SETTLED';
${Object.keys(RECONCILIATION_COLUMNS).filter(t=>!['reconciliation_grants','reconciliation_verification_jobs','model_usage_authorities'].includes(t)).map(t=>immutable(t)+'\n'+guard(t)).join('\n')}
${immutable('model_usage_authorities')}
${fence('model_usage_authorities','INSERT')}
CREATE TRIGGER model_usage_authorities_reconciliation_scope_INSERT BEFORE INSERT ON model_usage_authorities WHEN
 (NEW.authority='RECONCILED' AND map_reconciliation_write('model_usage_authorities',NULL,${vector('model_usage_authorities','NEW')})<>1)
 OR (NEW.authority='NORMAL' AND NOT EXISTS(SELECT 1 FROM model_call_ledger m WHERE m.workflow_run_id=NEW.workflow_run_id AND m.model_call_id=NEW.model_call_id AND m.attempt_id=NEW.attempt_id AND m.state='SETTLED' AND m.usage_event_id=NEW.usage_event_id AND m.usage_json=NEW.usage_json AND m.usage_cost=NEW.cost_micros AND map_reconciliation_digest(m.usage_json)=NEW.usage_digest))
BEGIN SELECT RAISE(ABORT,'RECOVERY_UNAUTHORIZED'); END;
${['reconciliation_grants','reconciliation_verification_jobs'].map(t=>guard(t)+guard(t,'UPDATE')+`CREATE TRIGGER ${t}_reconciliation_no_delete BEFORE DELETE ON ${t} BEGIN SELECT RAISE(ABORT,'RECOVERY_IMMUTABLE'); END;`).join('\n')}
CREATE TRIGGER reconciliation_case_revision BEFORE INSERT ON reconciliation_cases WHEN
 NEW.revision<>coalesce((SELECT max(revision) FROM reconciliation_cases WHERE workflow_run_id=NEW.workflow_run_id AND target_kind=NEW.target_kind AND target_id=NEW.target_id AND attempt_id=NEW.attempt_id),0)+1
BEGIN SELECT RAISE(ABORT,'RECOVERY_UNAUTHORIZED'); END;
CREATE TRIGGER reconciliation_evidence_version BEFORE INSERT ON reconciliation_evidence WHEN
 NEW.version<>coalesce((SELECT max(version) FROM reconciliation_evidence WHERE workflow_run_id=NEW.workflow_run_id AND logical_id=NEW.logical_id),0)+1 OR EXISTS(
 SELECT 1 FROM reconciliation_evidence WHERE workflow_run_id=NEW.workflow_run_id AND logical_id=NEW.logical_id AND (owner_id<>NEW.owner_id OR target_kind<>NEW.target_kind OR target_id<>NEW.target_id OR attempt_id<>NEW.attempt_id))
BEGIN SELECT RAISE(ABORT,'RECOVERY_UNAUTHORIZED'); END;
CREATE TRIGGER reconciliation_grant_transition BEFORE UPDATE ON reconciliation_grants WHEN OLD.status<>'AUTHORIZED' OR NEW.status NOT IN ('CONSUMED','REVOKED') OR
 ${RECONCILIATION_COLUMNS.reconciliation_grants.filter(c=>!['status','consumed_operation_id','revoked_at','revoked_by'].includes(c)).map(c=>`NEW.${c} IS NOT OLD.${c}`).join(' OR ')}
BEGIN SELECT RAISE(ABORT,'RECOVERY_UNAUTHORIZED'); END;
CREATE TRIGGER reconciliation_job_transition BEFORE UPDATE ON reconciliation_verification_jobs WHEN OLD.status<>'PENDING' OR NEW.status NOT IN ('COMPLETE','CANCELLED') OR
 ${RECONCILIATION_COLUMNS.reconciliation_verification_jobs.filter(c=>!['status','receipt_id'].includes(c)).map(c=>`NEW.${c} IS NOT OLD.${c}`).join(' OR ')}
BEGIN SELECT RAISE(ABORT,'RECOVERY_UNAUTHORIZED'); END;
CREATE TRIGGER model_usage_authority_normal AFTER UPDATE ON model_call_ledger WHEN OLD.state<>'SETTLED' AND NEW.state='SETTLED' BEGIN
 INSERT INTO model_usage_authorities VALUES(NEW.workflow_run_id,NEW.model_call_id,NEW.attempt_id,'NORMAL',NEW.usage_event_id,NULL,NEW.usage_json,map_reconciliation_digest(NEW.usage_json),NEW.usage_cost,NEW.settled_at);
END;
CREATE TRIGGER reconciliation_model_sealed BEFORE UPDATE ON model_call_ledger WHEN EXISTS(
 SELECT 1 FROM reconciliation_target_seals WHERE workflow_run_id=OLD.workflow_run_id AND target_kind='MODEL' AND target_id=OLD.model_call_id AND attempt_id=OLD.attempt_id)
 OR EXISTS(SELECT 1 FROM model_usage_authorities WHERE workflow_run_id=OLD.workflow_run_id AND model_call_id=OLD.model_call_id AND attempt_id=OLD.attempt_id AND authority='RECONCILED')
BEGIN SELECT RAISE(ABORT,'RECOVERY_UNAUTHORIZED'); END;
CREATE TRIGGER reconciliation_action_sealed BEFORE UPDATE ON execution_ledger WHEN EXISTS(
 SELECT 1 FROM reconciliation_target_seals WHERE workflow_run_id=OLD.workflow_run_id AND target_kind='ACTION' AND target_id=OLD.action_id AND attempt_id=OLD.attempt_id)
BEGIN SELECT RAISE(ABORT,'RECOVERY_UNAUTHORIZED'); END;
CREATE TRIGGER reconciliation_result_sealed BEFORE INSERT ON execution_results WHEN EXISTS(
 SELECT 1 FROM reconciliation_target_seals WHERE workflow_run_id=NEW.workflow_run_id AND target_kind='ACTION' AND target_id=NEW.action_id)
BEGIN SELECT RAISE(ABORT,'RECOVERY_UNAUTHORIZED'); END;
CREATE TRIGGER reconciliation_usage_event_sealed BEFORE INSERT ON journal_events WHEN NEW.event_type='UsageRecorded' AND EXISTS(
 SELECT 1 FROM model_usage_authorities a WHERE a.workflow_run_id=NEW.workflow_run_id AND a.authority='RECONCILED' AND json_extract(NEW.payload,'$.payload.sourceRef')='map.runner.model.call.v1:'||a.model_call_id)
BEGIN SELECT RAISE(ABORT,'RECOVERY_UNAUTHORIZED'); END;
${holdGuards}
DROP TRIGGER bounded_generation_hold;
${generationHold}
CREATE TRIGGER reconciliation_duplicate_action BEFORE INSERT ON pending_actions WHEN
 map_reconciliation_duplicate_action(NEW.workflow_run_id,NEW.prepared_action_json)<>0
BEGIN SELECT RAISE(ABORT,'RECOVERY_UNAUTHORIZED'); END;
CREATE TRIGGER reconciliation_result_event_scope BEFORE INSERT ON journal_events WHEN NEW.event_type IN ('TaskCompleted','TaskFailed')
 AND (json_extract(NEW.payload,'$.payload.resultRef') LIKE 'map.reconciliation.result.v1:%' OR EXISTS (
 SELECT 1 FROM json_each(NEW.payload,'$.payload.evidenceRefs') WHERE value LIKE 'map.reconciliation.result.v1:%'))
 AND map_reconciliation_business(NEW.workflow_run_id,'journal_events','INSERT',NEW.event_id,NEW.payload)<>1
BEGIN SELECT RAISE(ABORT,'RECOVERY_UNAUTHORIZED'); END;
`;
