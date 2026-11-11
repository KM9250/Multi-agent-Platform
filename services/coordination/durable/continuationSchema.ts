import { RECOVERY_DECISION_SQL } from './recoveryDecisionSchema';
import { SAFE_RECOVERY_SQL } from './safeRecoverySchema';
import { CONTROLLED_RECOVERY_SQL } from './controlledRecoverySchema';
import { DATABASE_NOW_SQL as now } from './leaseSchema';

const immutable = (table: string) => `
CREATE TRIGGER ${table}_immutable BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'RECOVERY_IMMUTABLE'); END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'RECOVERY_IMMUTABLE'); END;`;
const guard = (table: string, mutable = false) => ['INSERT', ...(mutable ? ['UPDATE'] : [])].map(op => `
CREATE TRIGGER ${table}_scope_${op} BEFORE ${op} ON ${table}
WHEN map_bounded_write(NEW.workflow_run_id,'${table}','${op}',NULL,NULL)<>1
BEGIN SELECT RAISE(ABORT,'RECOVERY_UNAUTHORIZED'); END;`).join('');
// Reinstall the final v8 guard definitions, preserving their target-bound 4B-1/2A exceptions.
// The inputs above are frozen historical migrations; none is edited to generate v9.
const guards = new Map<string, string>();
for (const sql of [RECOVERY_DECISION_SQL, SAFE_RECOVERY_SQL, CONTROLLED_RECOVERY_SQL]) {
  for (const match of sql.matchAll(/CREATE TRIGGER (recovery_hold_\w+) BEFORE (INSERT|UPDATE|DELETE) ON (\w+)[\s\S]*?END;/g)) {
    if (match[1] !== `recovery_hold_${match[3]}_${match[2]}`) continue;
    let body = match[0].replaceAll('FROM recovery_holds', 'FROM recovery_control_gates');
    body = body.replace('WHEN ', 'WHEN (').replace("BEGIN SELECT RAISE", `) AND map_bounded_write(${match[2] === 'DELETE' ? 'OLD' : 'NEW'}.workflow_run_id,'${match[3]}','${match[2]}',NULL,NULL)<>1\nBEGIN SELECT RAISE`);
    guards.set(match[1], `DROP TRIGGER ${match[1]};\n${body}`);
  }
}
const managed = ['recovery_continuation_plans','recovery_continuation_grants','recovery_invocations',
  'recovery_invocation_steps','recovery_invocation_debits','recovery_continuation_receipts',
  'planning_artifacts','planning_reviews','planning_read_calls','recovery_model_lineage'];
const mutable = new Set(['recovery_continuation_grants','recovery_invocations','planning_read_calls']);
const originalHoldGuard=RECOVERY_DECISION_SQL.match(/CREATE TRIGGER recovery_holds_guard[\s\S]*?END;/)![0];
export const CONTINUATION_SQL = `
-- A v8 live/unresolved row is evidence of risk, not a transferable Invocation.
DROP TRIGGER recovery_holds_guard;
INSERT INTO recovery_holds SELECT s.workflow_run_id,1,'INTEGRITY_UNVERIFIED',l.generation,${now},'MIGRATION',1
 FROM workflow_seeds s LEFT JOIN runtime_leases l USING(workflow_run_id)
 WHERE NOT EXISTS(SELECT 1 FROM recovery_holds h WHERE h.workflow_run_id=s.workflow_run_id) AND (
 EXISTS(SELECT 1 FROM model_call_coverage c WHERE c.workflow_run_id=s.workflow_run_id AND c.coverage='LEGACY_UNTRACKED') OR
 EXISTS(SELECT 1 FROM model_call_ledger m WHERE m.workflow_run_id=s.workflow_run_id AND (m.state IN ('RESERVED','DISPATCH_INTENT','REVIEW_REQUIRED') OR m.application_status='PENDING_APPLICATION' OR m.budget_violation=1)) OR
 EXISTS(SELECT 1 FROM execution_ledger e WHERE e.workflow_run_id=s.workflow_run_id AND e.state IN ('DISPATCH_RESERVED','RESULT_RECORDED','REVIEW_REQUIRED')) OR
 json_extract((SELECT payload FROM journal_events WHERE workflow_run_id=s.workflow_run_id AND event_type IN ('WorkflowBlocked','WorkflowSuspended','WorkflowResumed') ORDER BY sequence DESC LIMIT 1),'$.type') IN ('WorkflowBlocked','WorkflowSuspended'));
${originalHoldGuard}
CREATE TABLE recovery_hold_lifecycle (
 lifecycle_id INTEGER PRIMARY KEY, workflow_run_id TEXT NOT NULL REFERENCES workflow_seeds(workflow_run_id),
 hold_epoch INTEGER NOT NULL CHECK(hold_epoch>=0), control_revision INTEGER NOT NULL CHECK(control_revision>=0),
 hold_state TEXT NOT NULL CHECK(hold_state IN ('NONE','HELD','RELEASED')),
 active_invocation_id TEXT, planning_review_pending INTEGER NOT NULL CHECK(planning_review_pending IN (0,1)),
 reason TEXT NOT NULL, generation INTEGER, recorded_at INTEGER NOT NULL,
 UNIQUE(workflow_run_id,control_revision)
) STRICT;
CREATE TABLE recovery_workflow_control (
 workflow_run_id TEXT PRIMARY KEY REFERENCES workflow_seeds(workflow_run_id),
 hold_epoch INTEGER NOT NULL CHECK(hold_epoch>=0), control_revision INTEGER NOT NULL CHECK(control_revision>=0),
 hold_state TEXT NOT NULL CHECK(hold_state IN ('NONE','HELD','RELEASED')),
 active_invocation_id TEXT, planning_review_pending INTEGER NOT NULL CHECK(planning_review_pending IN (0,1)),
 FOREIGN KEY(workflow_run_id,control_revision) REFERENCES recovery_hold_lifecycle(workflow_run_id,control_revision)
 DEFERRABLE INITIALLY DEFERRED
) STRICT;
INSERT INTO recovery_hold_lifecycle SELECT NULL,s.workflow_run_id,CASE WHEN h.workflow_run_id IS NULL THEN 0 ELSE 1 END,
 0,CASE WHEN h.workflow_run_id IS NULL THEN 'NONE' ELSE 'HELD' END,NULL,0,'MIGRATION',NULL,${now}
 FROM workflow_seeds s LEFT JOIN recovery_holds h USING(workflow_run_id);
INSERT INTO recovery_workflow_control SELECT workflow_run_id,hold_epoch,control_revision,hold_state,active_invocation_id,planning_review_pending FROM recovery_hold_lifecycle;
${immutable('recovery_hold_lifecycle')}
CREATE TRIGGER bounded_lifecycle_guard BEFORE INSERT ON recovery_hold_lifecycle WHEN NOT (
 map_bounded_write(NEW.workflow_run_id,'recovery_hold_lifecycle','INSERT',NULL,NULL)=1
 OR map_lease_change(NEW.workflow_run_id)=1
 OR (NEW.reason IN ('INITIAL_HOLD','GATE_REHOLD') AND EXISTS(SELECT 1 FROM recovery_holds WHERE workflow_run_id=NEW.workflow_run_id)
   AND map_recovery_management(NEW.workflow_run_id,'HOLD',NEW.workflow_run_id)=1)
 OR (NEW.reason='BOOTSTRAP' AND NEW.control_revision=0 AND NOT EXISTS(SELECT 1 FROM journal_events WHERE workflow_run_id=NEW.workflow_run_id)))
BEGIN SELECT RAISE(ABORT,'RECOVERY_UNAUTHORIZED'); END;
CREATE TRIGGER bounded_control_insert BEFORE INSERT ON recovery_workflow_control WHEN
 (EXISTS(SELECT 1 FROM recovery_workflow_control WHERE workflow_run_id=NEW.workflow_run_id AND NEW.control_revision<>control_revision+1)) OR NOT EXISTS(
 SELECT 1 FROM recovery_hold_lifecycle h WHERE h.workflow_run_id=NEW.workflow_run_id AND h.control_revision=NEW.control_revision
 AND h.hold_epoch=NEW.hold_epoch AND h.hold_state=NEW.hold_state AND h.active_invocation_id IS NEW.active_invocation_id
 AND h.planning_review_pending=NEW.planning_review_pending)
BEGIN SELECT RAISE(ABORT,'RECOVERY_UNAUTHORIZED'); END;
CREATE TRIGGER bounded_control_update BEFORE UPDATE ON recovery_workflow_control WHEN
 NEW.workflow_run_id<>OLD.workflow_run_id OR NEW.control_revision<>OLD.control_revision+1 OR NOT EXISTS(
 SELECT 1 FROM recovery_hold_lifecycle h WHERE h.workflow_run_id=NEW.workflow_run_id AND h.control_revision=NEW.control_revision
 AND h.hold_epoch=NEW.hold_epoch AND h.hold_state=NEW.hold_state AND h.active_invocation_id IS NEW.active_invocation_id
 AND h.planning_review_pending=NEW.planning_review_pending)
BEGIN SELECT RAISE(ABORT,'RECOVERY_UNAUTHORIZED'); END;
CREATE TRIGGER bounded_control_no_delete BEFORE DELETE ON recovery_workflow_control BEGIN SELECT RAISE(ABORT,'RECOVERY_IMMUTABLE'); END;
CREATE TRIGGER bounded_lifecycle_project AFTER INSERT ON recovery_hold_lifecycle BEGIN
 INSERT INTO recovery_workflow_control VALUES (NEW.workflow_run_id,NEW.hold_epoch,NEW.control_revision,NEW.hold_state,NEW.active_invocation_id,NEW.planning_review_pending)
 ON CONFLICT(workflow_run_id) DO UPDATE SET hold_epoch=excluded.hold_epoch,control_revision=excluded.control_revision,
 hold_state=excluded.hold_state,active_invocation_id=excluded.active_invocation_id,planning_review_pending=excluded.planning_review_pending;
END;
CREATE TRIGGER bounded_control_bootstrap AFTER INSERT ON workflow_seeds BEGIN
 INSERT INTO recovery_hold_lifecycle VALUES(NULL,NEW.workflow_run_id,0,0,'NONE',NULL,0,'BOOTSTRAP',NULL,${now}); END;
CREATE TRIGGER bounded_initial_hold AFTER INSERT ON recovery_holds WHEN (SELECT hold_state FROM recovery_workflow_control WHERE workflow_run_id=NEW.workflow_run_id)<>'HELD' BEGIN
 INSERT INTO recovery_hold_lifecycle SELECT NULL,NEW.workflow_run_id,hold_epoch+1,control_revision+1,'HELD',active_invocation_id,
 planning_review_pending,'INITIAL_HOLD',NEW.created_generation,${now} FROM recovery_workflow_control WHERE workflow_run_id=NEW.workflow_run_id;
END;
CREATE VIEW recovery_effective_holds AS SELECT h.* FROM recovery_holds h JOIN recovery_workflow_control c USING(workflow_run_id) WHERE c.hold_state='HELD';
CREATE VIEW recovery_control_gates AS SELECT workflow_run_id FROM recovery_workflow_control
 WHERE hold_state='HELD' OR active_invocation_id IS NOT NULL OR planning_review_pending=1;
CREATE TABLE recovery_continuation_plans (
 plan_id TEXT PRIMARY KEY NOT NULL, workflow_run_id TEXT NOT NULL REFERENCES workflow_seeds(workflow_run_id),
 request_id TEXT NOT NULL, operation TEXT NOT NULL, mode TEXT, origin TEXT NOT NULL,
 plan_json TEXT NOT NULL CHECK(json_valid(plan_json)), plan_digest TEXT NOT NULL CHECK(length(plan_digest)=64),
 created_by TEXT NOT NULL, expires_at INTEGER NOT NULL, contract TEXT NOT NULL CHECK(contract='COORD-5C-4B2B:BOUNDED_EXECUTION:1'),
 UNIQUE(workflow_run_id,request_id), UNIQUE(workflow_run_id,plan_id),
 CHECK((operation='PLANNING_ONLY' AND mode IN ('THINK_ONLY','PLAN_READ_ONLY') AND origin IN ('USER_REQUEST','RECOVERY'))
 OR (operation='BOUNDED_CONTINUATION' AND mode='BOUNDED_EXECUTE' AND origin IN ('USER_REQUEST','RECOVERY'))
 OR (operation='RELEASE_RECOVERY_HOLD' AND mode IS NULL AND origin='RECOVERY')),
 CHECK(json_extract(plan_json,'$.operation') IS operation AND json_extract(plan_json,'$.mode') IS mode
 AND json_extract(plan_json,'$.origin') IS origin AND json_extract(plan_json,'$.planDigest') IS plan_digest)
) STRICT;
CREATE TABLE recovery_continuation_grants (
 grant_id TEXT PRIMARY KEY NOT NULL, workflow_run_id TEXT NOT NULL, plan_id TEXT NOT NULL,
 actor_id TEXT NOT NULL, source TEXT NOT NULL, plan_digest TEXT NOT NULL, expires_at INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('AUTHORIZED','CONSUMED','REVOKED')),
 FOREIGN KEY(workflow_run_id,plan_id) REFERENCES recovery_continuation_plans(workflow_run_id,plan_id),
 UNIQUE(plan_id,actor_id)
) STRICT;
CREATE TRIGGER bounded_grant_transition BEFORE UPDATE ON recovery_continuation_grants WHEN
 OLD.status<>'AUTHORIZED' OR NEW.status NOT IN ('CONSUMED','REVOKED') OR
 ${['grant_id','workflow_run_id','plan_id','actor_id','source','plan_digest','expires_at'].map(k=>`NEW.${k} IS NOT OLD.${k}`).join(' OR ')}
BEGIN SELECT RAISE(ABORT,'RECOVERY_UNAUTHORIZED'); END;
CREATE TABLE recovery_invocations (
 invocation_id TEXT PRIMARY KEY NOT NULL, workflow_run_id TEXT NOT NULL, plan_id TEXT NOT NULL UNIQUE,
 owner_id TEXT NOT NULL, runtime_instance_id TEXT NOT NULL, generation INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('ACTIVE','DRAINING','COMPLETED','STOPPED','REVIEW_REQUIRED')),
 outcome TEXT, revision INTEGER NOT NULL CHECK(revision>=0), expected_state TEXT NOT NULL CHECK(length(expected_state)=64),
 started_at INTEGER NOT NULL, admission_deadline INTEGER NOT NULL, collection_deadline INTEGER NOT NULL,
 FOREIGN KEY(workflow_run_id,plan_id) REFERENCES recovery_continuation_plans(workflow_run_id,plan_id),
 UNIQUE(workflow_run_id,invocation_id), CHECK(admission_deadline>started_at AND collection_deadline>admission_deadline)
) STRICT;
CREATE UNIQUE INDEX bounded_active_workflow ON recovery_invocations(workflow_run_id) WHERE status IN ('ACTIVE','DRAINING');
CREATE TRIGGER bounded_invocation_transition BEFORE UPDATE ON recovery_invocations WHEN
 NEW.revision<>OLD.revision+1 OR OLD.status NOT IN ('ACTIVE','DRAINING') OR
 (OLD.status='DRAINING' AND NEW.status='ACTIVE') OR
 (OLD.status='ACTIVE' AND NEW.status IN ('COMPLETED','STOPPED')) OR
 (OLD.status='ACTIVE' AND NEW.status='REVIEW_REQUIRED' AND map_lease_change(NEW.workflow_run_id)<>1) OR
 ${['invocation_id','workflow_run_id','plan_id','owner_id','runtime_instance_id','generation','started_at','admission_deadline','collection_deadline'].map(k=>`NEW.${k} IS NOT OLD.${k}`).join(' OR ')}
BEGIN SELECT RAISE(ABORT,'RECOVERY_UNAUTHORIZED'); END;
CREATE TABLE recovery_invocation_steps (
 step_id TEXT PRIMARY KEY NOT NULL, workflow_run_id TEXT NOT NULL, invocation_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('ROUND','MODEL','ACTION','READ')), target_id TEXT NOT NULL,
 purpose TEXT NOT NULL CHECK(purpose IN ('ROUND','PLAN','VERIFY','DRAFT_PLAN','ACTION','READ')), business_round_key TEXT, parent_step_id TEXT,
 created_at INTEGER NOT NULL, execution_deadline INTEGER NOT NULL, collection_deadline INTEGER NOT NULL, application_deadline INTEGER NOT NULL,
 CHECK(created_at<execution_deadline AND execution_deadline<collection_deadline AND collection_deadline<application_deadline),
 FOREIGN KEY(workflow_run_id,invocation_id) REFERENCES recovery_invocations(workflow_run_id,invocation_id),
 FOREIGN KEY(workflow_run_id,parent_step_id) REFERENCES recovery_invocation_steps(workflow_run_id,step_id),
 UNIQUE(workflow_run_id,invocation_id,kind,target_id), UNIQUE(workflow_run_id,step_id)
) STRICT;
CREATE TABLE recovery_invocation_debits (
 step_id TEXT PRIMARY KEY NOT NULL, workflow_run_id TEXT NOT NULL, invocation_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('ROUND','MODEL','ACTION','READ')), target_id TEXT NOT NULL,
 input_tokens INTEGER NOT NULL CHECK(input_tokens BETWEEN 0 AND 9007199254740991),
 output_tokens INTEGER NOT NULL CHECK(output_tokens BETWEEN 0 AND 9007199254740991),
 cost_micros INTEGER NOT NULL CHECK(cost_micros BETWEEN 0 AND 9007199254740991),
 FOREIGN KEY(workflow_run_id,step_id) REFERENCES recovery_invocation_steps(workflow_run_id,step_id),
 FOREIGN KEY(workflow_run_id,invocation_id) REFERENCES recovery_invocations(workflow_run_id,invocation_id)
) STRICT;
CREATE TABLE recovery_continuation_receipts (
 receipt_id TEXT PRIMARY KEY NOT NULL, workflow_run_id TEXT NOT NULL, plan_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('START','FINISH','RELEASE','STOP')), receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
 receipt_digest TEXT NOT NULL CHECK(length(receipt_digest)=64), UNIQUE(plan_id,kind),
 FOREIGN KEY(workflow_run_id,plan_id) REFERENCES recovery_continuation_plans(workflow_run_id,plan_id)
) STRICT;
CREATE TABLE recovery_model_lineage (
 step_id TEXT PRIMARY KEY NOT NULL, workflow_run_id TEXT NOT NULL, model_call_id TEXT NOT NULL UNIQUE,
 supersedes_model_call_id TEXT NOT NULL, resolution_id TEXT NOT NULL, resolution_digest TEXT NOT NULL CHECK(length(resolution_digest)=64),
 FOREIGN KEY(workflow_run_id,step_id) REFERENCES recovery_invocation_steps(workflow_run_id,step_id),
 FOREIGN KEY(workflow_run_id,model_call_id) REFERENCES model_call_ledger(workflow_run_id,model_call_id),
 FOREIGN KEY(workflow_run_id,supersedes_model_call_id) REFERENCES model_call_ledger(workflow_run_id,model_call_id),
 CHECK(model_call_id<>supersedes_model_call_id)
) STRICT;
CREATE UNIQUE INDEX bounded_model_application_key ON model_call_ledger(workflow_run_id,model_call_id,application_status);
CREATE TABLE planning_artifacts (
 artifact_id TEXT PRIMARY KEY NOT NULL, workflow_run_id TEXT NOT NULL, invocation_id TEXT NOT NULL UNIQUE,
 model_call_id TEXT NOT NULL UNIQUE, owner_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>=1),
 applied_status TEXT NOT NULL DEFAULT 'APPLIED' CHECK(applied_status='APPLIED'),
 content_digest TEXT NOT NULL CHECK(length(content_digest)=64), artifact_json TEXT NOT NULL CHECK(json_valid(artifact_json) AND length(CAST(artifact_json AS BLOB))<=131072),
 FOREIGN KEY(workflow_run_id,invocation_id) REFERENCES recovery_invocations(workflow_run_id,invocation_id),
 FOREIGN KEY(workflow_run_id,model_call_id) REFERENCES model_call_ledger(workflow_run_id,model_call_id),
 FOREIGN KEY(workflow_run_id,model_call_id,applied_status) REFERENCES model_call_ledger(workflow_run_id,model_call_id,application_status) DEFERRABLE INITIALLY DEFERRED,
 UNIQUE(workflow_run_id,artifact_id)
) STRICT;
CREATE UNIQUE INDEX bounded_artifact_successor ON planning_artifacts(json_extract(artifact_json,'$.previousArtifact.artifactId')) WHERE json_extract(artifact_json,'$.previousArtifact.artifactId') IS NOT NULL;
CREATE TABLE planning_reviews (
 review_id TEXT PRIMARY KEY NOT NULL, workflow_run_id TEXT NOT NULL, artifact_id TEXT NOT NULL, actor_id TEXT NOT NULL,
 decision TEXT NOT NULL CHECK(decision IN ('ACCEPTED_FOR_SCOPE','REJECTED','SUPERSEDED','STALE')), recorded_at INTEGER NOT NULL,
 FOREIGN KEY(workflow_run_id,artifact_id) REFERENCES planning_artifacts(workflow_run_id,artifact_id)
) STRICT;
CREATE TABLE planning_read_calls (
 read_id TEXT PRIMARY KEY NOT NULL, workflow_run_id TEXT NOT NULL, invocation_id TEXT NOT NULL, step_id TEXT NOT NULL UNIQUE,
 resource_id TEXT NOT NULL, request_digest TEXT NOT NULL, expected_digest TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('INTENT','SUCCEEDED','FAILED','TIMED_OUT')), result_digest TEXT, size_bytes INTEGER,
 cost_micros INTEGER NOT NULL CHECK(cost_micros=0), created_at INTEGER NOT NULL, deadline INTEGER NOT NULL,
 FOREIGN KEY(workflow_run_id,invocation_id) REFERENCES recovery_invocations(workflow_run_id,invocation_id),
 FOREIGN KEY(workflow_run_id,step_id) REFERENCES recovery_invocation_steps(workflow_run_id,step_id)
) STRICT;
CREATE TRIGGER planning_read_transition BEFORE UPDATE ON planning_read_calls WHEN OLD.state<>'INTENT' OR NEW.state='INTENT'
 OR ${['read_id','workflow_run_id','invocation_id','step_id','resource_id','request_digest','expected_digest','cost_micros','created_at','deadline'].map(k=>`NEW.${k} IS NOT OLD.${k}`).join(' OR ')}
BEGIN SELECT RAISE(ABORT,'RECOVERY_IMMUTABLE'); END;
${managed.map(t => guard(t,mutable.has(t)) + (mutable.has(t) ? `CREATE TRIGGER ${t}_no_delete BEFORE DELETE ON ${t} BEGIN SELECT RAISE(ABORT,'RECOVERY_IMMUTABLE'); END;` : immutable(t))).join('\n')}
CREATE TABLE bounded_audit (
 audit_id INTEGER PRIMARY KEY, workflow_run_id TEXT NOT NULL REFERENCES workflow_seeds(workflow_run_id),
 entity_table TEXT NOT NULL, operation TEXT NOT NULL, record_id TEXT NOT NULL, recorded_at INTEGER NOT NULL
) STRICT;
${immutable('bounded_audit')}${guard('bounded_audit')}
${managed.map(t => ['INSERT',...(mutable.has(t)?['UPDATE']:[])].map(op=>`
CREATE TRIGGER ${t}_bounded_audit_${op} AFTER ${op} ON ${t} BEGIN
 INSERT INTO bounded_audit VALUES(NULL,NEW.workflow_run_id,'${t}','${op}',
 ${t==='recovery_continuation_grants'?'NEW.grant_id':t==='recovery_invocations'?'NEW.invocation_id':t.includes('steps')||t.includes('debits')||t==='recovery_model_lineage'?'NEW.step_id':t.includes('receipts')?'NEW.receipt_id':t==='planning_artifacts'?'NEW.artifact_id':t==='planning_reviews'?'NEW.review_id':t==='planning_read_calls'?'NEW.read_id':'NEW.plan_id'},${now}); END;`).join('')).join('\n')}
${[...guards.values()].join('\n')}
DROP TRIGGER recovery_resume_disabled;
CREATE TRIGGER recovery_resume_disabled BEFORE INSERT ON journal_events WHEN NEW.event_type='WorkflowResumed'
 AND map_bounded_write(NEW.workflow_run_id,'resume','INSERT',NEW.event_id,NEW.payload)<>1
BEGIN SELECT RAISE(ABORT,'RECOVERY_EXECUTION_DISABLED'); END;
CREATE TRIGGER bounded_planning_event BEFORE INSERT ON journal_events WHEN NEW.event_type IN ('PlanArtifactPublished','PlanningReadRequested','PlanningInputRequested')
 AND map_bounded_write(NEW.workflow_run_id,'planning_application','INSERT',NEW.event_id,NEW.payload)<>1
BEGIN SELECT RAISE(ABORT,'RECOVERY_UNAUTHORIZED'); END;
CREATE TABLE recovery_legacy_control_bindings (
 plan_id TEXT NOT NULL, plan_table TEXT NOT NULL, workflow_run_id TEXT NOT NULL REFERENCES workflow_seeds(workflow_run_id),
 hold_epoch INTEGER NOT NULL, control_revision INTEGER NOT NULL, PRIMARY KEY(plan_table,plan_id)
) STRICT;
${immutable('recovery_legacy_control_bindings')}
CREATE TRIGGER bounded_legacy_binding_guard BEFORE INSERT ON recovery_legacy_control_bindings WHEN map_bounded_legacy_binding(NEW.workflow_run_id,NEW.plan_table,NEW.plan_id)<>1
BEGIN SELECT RAISE(ABORT,'RECOVERY_UNAUTHORIZED'); END;
${[['recovery_execution_plans','execution_plan_id'],['recovery_controlled_plans','plan_id']].map(([table,key])=>`
CREATE TRIGGER bounded_legacy_${table} AFTER INSERT ON ${table} BEGIN
 INSERT INTO recovery_legacy_control_bindings SELECT NEW.${key},'${table}',NEW.workflow_run_id,hold_epoch,control_revision FROM recovery_workflow_control WHERE workflow_run_id=NEW.workflow_run_id;
END;
CREATE TRIGGER bounded_legacy_gate_${table} BEFORE INSERT ON ${table} WHEN EXISTS(
 SELECT 1 FROM recovery_workflow_control WHERE workflow_run_id=NEW.workflow_run_id AND (active_invocation_id IS NOT NULL OR planning_review_pending=1))
BEGIN SELECT RAISE(ABORT,'RECOVERY_HELD'); END;`).join('\n')}
DROP TRIGGER recovery_risky_acquire;
DROP TRIGGER recovery_takeover;
CREATE TRIGGER bounded_generation_hold AFTER UPDATE ON runtime_leases WHEN NEW.generation=OLD.generation+1 AND (
 OLD.lease_state='ACTIVE' OR EXISTS(SELECT 1 FROM recovery_workflow_control WHERE workflow_run_id=NEW.workflow_run_id AND (hold_state IN ('HELD','RELEASED') OR active_invocation_id IS NOT NULL))
 OR EXISTS(SELECT 1 FROM model_call_ledger WHERE workflow_run_id=NEW.workflow_run_id AND (state IN ('RESERVED','DISPATCH_INTENT','REVIEW_REQUIRED') OR application_status='PENDING_APPLICATION' OR budget_violation=1))
 OR EXISTS(SELECT 1 FROM execution_ledger WHERE workflow_run_id=NEW.workflow_run_id AND state IN ('DISPATCH_RESERVED','RESULT_RECORDED','REVIEW_REQUIRED'))
 OR EXISTS(SELECT 1 FROM model_call_coverage WHERE workflow_run_id=NEW.workflow_run_id AND coverage='LEGACY_UNTRACKED')
 OR json_extract((SELECT payload FROM journal_events WHERE workflow_run_id=NEW.workflow_run_id AND event_type IN ('WorkflowBlocked','WorkflowSuspended','WorkflowResumed') ORDER BY sequence DESC LIMIT 1),'$.type') IN ('WorkflowBlocked','WorkflowSuspended'))
BEGIN
 INSERT INTO recovery_hold_lifecycle SELECT NULL,NEW.workflow_run_id,hold_epoch+1,control_revision+1,'HELD',NULL,planning_review_pending,'GENERATION_CHANGED',NEW.generation,${now}
 FROM recovery_workflow_control WHERE workflow_run_id=NEW.workflow_run_id;
 INSERT INTO recovery_holds SELECT NEW.workflow_run_id,1,CASE WHEN OLD.lease_state='ACTIVE' THEN 'LEASE_TAKEOVER' ELSE 'INTEGRITY_UNVERIFIED' END,NEW.generation,${now},CASE WHEN OLD.lease_state='ACTIVE' THEN 'TAKEOVER' ELSE 'ACQUIRE' END,1
 WHERE NOT EXISTS(SELECT 1 FROM recovery_holds WHERE workflow_run_id=NEW.workflow_run_id);
 UPDATE recovery_invocations SET status='REVIEW_REQUIRED',outcome='LEASE_LOST',revision=revision+1 WHERE workflow_run_id=NEW.workflow_run_id AND status IN ('ACTIVE','DRAINING');
END;

CREATE TRIGGER bounded_event_scope BEFORE INSERT ON journal_events WHEN EXISTS(
 SELECT 1 FROM recovery_workflow_control WHERE workflow_run_id=NEW.workflow_run_id AND active_invocation_id IS NOT NULL)
 AND map_bounded_event(NEW.workflow_run_id,NEW.event_type,NEW.payload)<>1
BEGIN SELECT RAISE(ABORT,'RECOVERY_UNAUTHORIZED'); END;

CREATE TRIGGER bounded_debit_binding BEFORE INSERT ON recovery_invocation_debits WHEN NOT EXISTS(
 SELECT 1 FROM recovery_invocation_steps WHERE step_id=NEW.step_id AND workflow_run_id=NEW.workflow_run_id AND invocation_id=NEW.invocation_id AND kind=NEW.kind AND target_id=NEW.target_id)
 OR (NEW.kind='MODEL' AND NOT EXISTS(SELECT 1 FROM model_call_ledger WHERE workflow_run_id=NEW.workflow_run_id AND model_call_id=NEW.target_id AND state='RESERVED'
 AND reserved_input=NEW.input_tokens AND reserved_output=NEW.output_tokens AND reserved_cost=NEW.cost_micros))
 OR (NEW.kind='ACTION' AND NOT EXISTS(SELECT 1 FROM execution_ledger WHERE workflow_run_id=NEW.workflow_run_id AND action_id=NEW.target_id AND state='DISPATCH_RESERVED'))
BEGIN SELECT RAISE(ABORT,'RECOVERY_UNAUTHORIZED'); END;
-- Result collection and application have separate, persisted Step deadlines.
CREATE TRIGGER bounded_model_send_deadline BEFORE UPDATE ON model_call_ledger WHEN NEW.state='DISPATCH_INTENT'
 AND EXISTS(SELECT 1 FROM recovery_invocation_steps WHERE kind='MODEL' AND target_id=NEW.model_call_id AND execution_deadline<=${now})
BEGIN SELECT RAISE(ABORT,'CONTINUATION_EXPIRED'); END;
CREATE TRIGGER bounded_model_result_deadline BEFORE UPDATE ON model_call_ledger WHEN
 EXISTS(SELECT 1 FROM recovery_invocation_steps WHERE kind='MODEL' AND target_id=NEW.model_call_id AND
 CASE WHEN OLD.state='SETTLED' THEN application_deadline ELSE collection_deadline END<=${now})
BEGIN SELECT RAISE(ABORT,'CONTINUATION_EXPIRED'); END;
CREATE TRIGGER bounded_action_result_deadline BEFORE INSERT ON execution_results WHEN
 EXISTS(SELECT 1 FROM recovery_invocation_steps WHERE kind='ACTION' AND target_id=NEW.action_id AND workflow_run_id=NEW.workflow_run_id AND collection_deadline<=${now})
BEGIN SELECT RAISE(ABORT,'CONTINUATION_EXPIRED'); END;
CREATE TRIGGER bounded_action_application_deadline BEFORE UPDATE ON execution_ledger WHEN NEW.state='FINALIZED' AND
 EXISTS(SELECT 1 FROM recovery_invocation_steps WHERE kind='ACTION' AND target_id=NEW.action_id AND workflow_run_id=NEW.workflow_run_id AND application_deadline<=${now})
BEGIN SELECT RAISE(ABORT,'CONTINUATION_EXPIRED'); END;
CREATE TRIGGER bounded_read_result_deadline BEFORE UPDATE ON planning_read_calls WHEN
 EXISTS(SELECT 1 FROM recovery_invocation_steps WHERE step_id=NEW.step_id AND collection_deadline<=${now})
BEGIN SELECT RAISE(ABORT,'CONTINUATION_EXPIRED'); END;
`;
