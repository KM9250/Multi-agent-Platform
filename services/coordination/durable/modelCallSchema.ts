import { DATABASE_NOW_SQL as now } from './leaseSchema';
const fence = (table: string) => ['INSERT','UPDATE'].map(op => `
CREATE TRIGGER ${table}_fence_${op} BEFORE ${op} ON ${table} WHEN
 NOT EXISTS (SELECT 1 FROM runtime_leases l WHERE l.workflow_run_id=NEW.workflow_run_id
 AND map_fence_valid(l.workflow_run_id,l.owner_instance_id,l.generation,l.lease_capability_hash,l.lease_state,l.expires_at,${now})=1)
 OR NEW.runtime_instance_id IS NOT map_runtime_id() OR NEW.generation IS NOT map_runtime_generation()
BEGIN SELECT RAISE(ABORT,'LEASE_FENCED'); END;`).join('\n');
const audit = (op: string, kind: string, previous: string) => `
CREATE TRIGGER model_call_audit_${op} AFTER ${op} ON model_call_ledger BEGIN
 INSERT INTO runtime_audit_events (audit_event_id,workflow_run_id,event_kind,entity_kind,entity_id,model_call_id,attempt_id,
 previous_state,next_state,reason_code,journal_event_id,journal_sequence,occurred_at,recorded_at,schema_version,runtime_instance_id,runtime_generation)
 VALUES (lower(hex(randomblob(16))),NEW.workflow_run_id,${kind},'WORKFLOW',NEW.workflow_run_id,NEW.model_call_id,NEW.attempt_id,
 ${previous},NEW.state,NEW.reason_code,NEW.application_event_id,
 (SELECT sequence FROM journal_events WHERE workflow_run_id=NEW.workflow_run_id AND event_id=NEW.application_event_id),
 NEW.updated_at,${now},1,map_runtime_id(),map_runtime_generation());
END;`;
export const MODEL_CALL_SQL = `
CREATE TABLE model_call_coverage (
 workflow_run_id TEXT PRIMARY KEY REFERENCES workflow_seeds(workflow_run_id),
 coverage TEXT NOT NULL CHECK(coverage IN ('TRACKED_FROM_CREATION','LEGACY_UNTRACKED'))
) STRICT;
INSERT INTO model_call_coverage SELECT workflow_run_id,'LEGACY_UNTRACKED' FROM workflow_seeds;
CREATE TRIGGER model_coverage_bootstrap AFTER INSERT ON workflow_seeds BEGIN
 INSERT INTO model_call_coverage VALUES (NEW.workflow_run_id,'TRACKED_FROM_CREATION'); END;
CREATE TRIGGER model_coverage_insert BEFORE INSERT ON model_call_coverage WHEN
 NEW.coverage <> 'TRACKED_FROM_CREATION' OR NOT EXISTS (SELECT 1 FROM workflow_seeds WHERE workflow_run_id=NEW.workflow_run_id AND last_sequence=1)
 OR EXISTS (SELECT 1 FROM journal_events WHERE workflow_run_id=NEW.workflow_run_id)
BEGIN SELECT RAISE(ABORT,'INVALID_COVERAGE'); END;
CREATE TRIGGER model_coverage_update BEFORE UPDATE ON model_call_coverage BEGIN SELECT RAISE(ABORT,'IMMUTABLE_COVERAGE'); END;
CREATE TRIGGER model_coverage_delete BEFORE DELETE ON model_call_coverage BEGIN SELECT RAISE(ABORT,'IMMUTABLE_COVERAGE'); END;
CREATE TABLE model_call_ledger (
 model_call_id TEXT PRIMARY KEY NOT NULL, workflow_run_id TEXT NOT NULL REFERENCES workflow_seeds(workflow_run_id),
 round_key TEXT NOT NULL CHECK(length(round_key)>0), phase TEXT NOT NULL CHECK(phase IN ('PLAN','VERIFY')),
 runtime_instance_id TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation>=1),
 provider_id TEXT NOT NULL, model_id TEXT NOT NULL,
 request_cursor INTEGER NOT NULL, request_event_id TEXT NOT NULL,
 attempt_id TEXT NOT NULL UNIQUE, quote_json TEXT NOT NULL CHECK(json_valid(quote_json)),
 state TEXT NOT NULL CHECK(state IN ('RESERVED','DISPATCH_INTENT','SETTLED','CANCELLED_PRE_DISPATCH','REVIEW_REQUIRED')),
 completeness TEXT NOT NULL CHECK(completeness IN ('UNKNOWN','PARTIAL','COMPLETE')),
 reserved_calls INTEGER NOT NULL CHECK(reserved_calls=1),
 reserved_input INTEGER NOT NULL CHECK(reserved_input BETWEEN 0 AND 9007199254740991),
 reserved_output INTEGER NOT NULL CHECK(reserved_output BETWEEN 0 AND 9007199254740991),
 reserved_cost INTEGER NOT NULL CHECK(reserved_cost BETWEEN 0 AND 9007199254740991),
 usage_json TEXT CHECK(usage_json IS NULL OR json_valid(usage_json)), usage_cost INTEGER CHECK(usage_cost BETWEEN 0 AND 9007199254740991),
 usage_event_id TEXT UNIQUE,
 application_status TEXT NOT NULL CHECK(application_status IN ('PENDING_APPLICATION','APPLIED','DISCARDED','NOT_APPLICABLE')),
 application_event_id TEXT, application_digest TEXT, application_start_cursor INTEGER,
 reason_code TEXT CHECK(reason_code IN ('USAGE_UNKNOWN','USAGE_PARTIAL','BUDGET_VIOLATION','PRE_DISPATCH_CANCELLED','INVALID_RESPONSE','STALE_RESPONSE','ABORTED','API_ERROR')),
 budget_violation INTEGER NOT NULL DEFAULT 0 CHECK(budget_violation IN (0,1)),
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, settled_at INTEGER,
 UNIQUE(workflow_run_id,round_key,phase), UNIQUE(workflow_run_id,model_call_id),
 FOREIGN KEY(workflow_run_id,request_event_id) REFERENCES journal_events(workflow_run_id,event_id),
 FOREIGN KEY(workflow_run_id,usage_event_id) REFERENCES journal_events(workflow_run_id,event_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(workflow_run_id,application_event_id) REFERENCES journal_events(workflow_run_id,event_id),
 CHECK((state='SETTLED')=(completeness='COMPLETE')),
 CHECK((state='SETTLED')=(usage_event_id IS NOT NULL)),
 CHECK(state<>'SETTLED' OR (usage_json IS NOT NULL AND usage_cost IS NOT NULL AND settled_at IS NOT NULL)),
 CHECK(application_status NOT IN ('APPLIED','DISCARDED','PENDING_APPLICATION') OR state='SETTLED'),
 CHECK(application_status<>'APPLIED' OR (application_event_id IS NOT NULL AND application_digest IS NOT NULL AND application_start_cursor IS NOT NULL))
) STRICT;
CREATE TABLE model_call_attempts (
 attempt_id TEXT PRIMARY KEY NOT NULL, model_call_id TEXT NOT NULL UNIQUE,
 workflow_run_id TEXT NOT NULL, runtime_instance_id TEXT NOT NULL, generation INTEGER NOT NULL,
 attempt_number INTEGER NOT NULL CHECK(attempt_number=1), dispatch_intent_at INTEGER,
 state TEXT NOT NULL CHECK(state IN ('RESERVED','DISPATCH_INTENT','SETTLED','CANCELLED_PRE_DISPATCH','REVIEW_REQUIRED')),
 completeness TEXT NOT NULL CHECK(completeness IN ('UNKNOWN','PARTIAL','COMPLETE')),
 reason_code TEXT CHECK(reason_code IN ('USAGE_UNKNOWN','USAGE_PARTIAL','BUDGET_VIOLATION','PRE_DISPATCH_CANCELLED','INVALID_RESPONSE','STALE_RESPONSE','ABORTED','API_ERROR')),
 FOREIGN KEY(workflow_run_id,model_call_id) REFERENCES model_call_ledger(workflow_run_id,model_call_id)
) STRICT;
ALTER TABLE runtime_audit_events ADD COLUMN model_call_id TEXT REFERENCES model_call_ledger(model_call_id);
CREATE INDEX audit_by_model_call ON runtime_audit_events(workflow_run_id,model_call_id,audit_sequence);
CREATE TRIGGER model_audit_guard BEFORE INSERT ON runtime_audit_events WHEN
 (NEW.event_kind LIKE 'MODEL_%' OR NEW.model_call_id IS NOT NULL) AND NOT EXISTS (
 SELECT 1 FROM model_call_ledger m WHERE m.model_call_id=NEW.model_call_id AND m.workflow_run_id=NEW.workflow_run_id
 AND m.state=NEW.next_state AND m.attempt_id=NEW.attempt_id AND m.reason_code IS NEW.reason_code
 AND m.runtime_instance_id=NEW.runtime_instance_id AND m.generation=NEW.runtime_generation
 AND NEW.event_kind IN ('MODEL_CALL_RESERVED','MODEL_CALL_DISPATCH_INTENT','MODEL_CALL_SETTLED','MODEL_CALL_REVIEW_REQUIRED','MODEL_CALL_CANCELLED_PRE_DISPATCH','MODEL_RESPONSE_APPLIED','MODEL_RESPONSE_DISCARDED','MODEL_BUDGET_VIOLATION'))
BEGIN SELECT RAISE(ABORT,'INVALID_MODEL_AUDIT'); END;
${fence('model_call_ledger')}
${fence('model_call_attempts')}
CREATE TRIGGER model_call_initial BEFORE INSERT ON model_call_ledger WHEN NEW.state<>'RESERVED'
 OR NEW.completeness<>'UNKNOWN' OR NEW.usage_json IS NOT NULL OR NEW.application_status<>'NOT_APPLICABLE'
 OR NEW.budget_violation<>0 OR NOT EXISTS(SELECT 1 FROM model_call_coverage WHERE workflow_run_id=NEW.workflow_run_id AND coverage='TRACKED_FROM_CREATION')
BEGIN SELECT RAISE(ABORT,'INVALID_MODEL_INITIAL'); END;
CREATE TRIGGER model_call_transition BEFORE UPDATE ON model_call_ledger WHEN NOT (
 (OLD.state='RESERVED' AND NEW.state IN ('DISPATCH_INTENT','CANCELLED_PRE_DISPATCH')) OR
 (OLD.state='DISPATCH_INTENT' AND NEW.state IN ('SETTLED','REVIEW_REQUIRED')) OR
 (OLD.state='SETTLED' AND NEW.state='SETTLED' AND OLD.application_status='PENDING_APPLICATION' AND NEW.application_status IN ('APPLIED','DISCARDED')))
 OR ${['model_call_id','workflow_run_id','round_key','phase','runtime_instance_id','generation','provider_id','model_id','request_cursor','request_event_id','attempt_id','quote_json','reserved_calls','reserved_input','reserved_output','reserved_cost','created_at'].map(k=>`NEW.${k} IS NOT OLD.${k}`).join(' OR ')}
 OR (OLD.state='DISPATCH_INTENT' AND NEW.state='SETTLED' AND NEW.application_status NOT IN ('PENDING_APPLICATION','NOT_APPLICABLE'))
 OR (NEW.application_status='APPLIED' AND (NEW.budget_violation<>0 OR NEW.reason_code IS NOT OLD.reason_code))
 OR (NEW.application_status='DISCARDED' AND NEW.reason_code NOT IN ('INVALID_RESPONSE','STALE_RESPONSE','ABORTED'))
 OR (OLD.state='SETTLED' AND (${['usage_json','usage_cost','usage_event_id','settled_at','completeness','budget_violation'].map(k=>`NEW.${k} IS NOT OLD.${k}`).join(' OR ')}))
BEGIN SELECT RAISE(ABORT,'INVALID_MODEL_TRANSITION'); END;
CREATE TRIGGER model_settlement_fresh_event BEFORE UPDATE ON model_call_ledger WHEN
 OLD.state='DISPATCH_INTENT' AND NEW.state='SETTLED' AND EXISTS (
 SELECT 1 FROM journal_events WHERE workflow_run_id=NEW.workflow_run_id AND event_id=NEW.usage_event_id)
BEGIN SELECT RAISE(ABORT,'MODEL_USAGE_EVENT_ALREADY_EXISTS'); END;
CREATE TRIGGER model_usage_target_guard BEFORE INSERT ON journal_events WHEN EXISTS (
 SELECT 1 FROM model_call_ledger m WHERE m.workflow_run_id=NEW.workflow_run_id AND m.usage_event_id=NEW.event_id
 AND (NEW.event_type<>'UsageRecorded' OR json_extract(NEW.payload,'$.payload.sourceRef') IS NOT 'map.runner.model.call.v1:'||m.model_call_id))
BEGIN SELECT RAISE(ABORT,'MODEL_USAGE_EVENT_MISMATCH'); END;
CREATE TRIGGER model_call_no_delete BEFORE DELETE ON model_call_ledger BEGIN SELECT RAISE(ABORT,'IMMUTABLE_MODEL'); END;
CREATE TRIGGER model_attempt_no_delete BEFORE DELETE ON model_call_attempts BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ATTEMPT'); END;
CREATE TRIGGER model_attempt_insert BEFORE INSERT ON model_call_attempts WHEN NOT EXISTS (
 SELECT 1 FROM model_call_ledger WHERE model_call_id=NEW.model_call_id AND workflow_run_id=NEW.workflow_run_id
 AND attempt_id=NEW.attempt_id AND state=NEW.state AND completeness=NEW.completeness AND reason_code IS NEW.reason_code AND NEW.dispatch_intent_at IS NULL AND runtime_instance_id=NEW.runtime_instance_id AND generation=NEW.generation)
BEGIN SELECT RAISE(ABORT,'INVALID_ATTEMPT'); END;
CREATE TRIGGER model_attempt_update BEFORE UPDATE ON model_call_attempts WHEN
 NEW.attempt_id IS NOT OLD.attempt_id OR NEW.model_call_id IS NOT OLD.model_call_id OR NEW.workflow_run_id IS NOT OLD.workflow_run_id
 OR NEW.runtime_instance_id IS NOT OLD.runtime_instance_id OR NEW.generation IS NOT OLD.generation
 OR (OLD.dispatch_intent_at IS NOT NULL AND NEW.dispatch_intent_at IS NOT OLD.dispatch_intent_at)
 OR NOT EXISTS(SELECT 1 FROM model_call_ledger WHERE model_call_id=NEW.model_call_id AND state=NEW.state AND completeness=NEW.completeness AND reason_code IS NEW.reason_code)
BEGIN SELECT RAISE(ABORT,'INVALID_ATTEMPT'); END;
CREATE TRIGGER model_attempt_sync AFTER UPDATE ON model_call_ledger BEGIN
 UPDATE model_call_attempts SET state=NEW.state,completeness=NEW.completeness,reason_code=NEW.reason_code,
 dispatch_intent_at=CASE WHEN NEW.state='DISPATCH_INTENT' THEN NEW.updated_at ELSE dispatch_intent_at END WHERE model_call_id=NEW.model_call_id; END;
CREATE UNIQUE INDEX model_usage_source ON journal_events(workflow_run_id,json_extract(payload,'$.payload.sourceRef'))
 WHERE event_type='UsageRecorded' AND json_extract(payload,'$.payload.sourceRef') LIKE 'map.runner.model.call.v1:%';
CREATE TRIGGER model_usage_guard BEFORE INSERT ON journal_events WHEN NEW.event_type='UsageRecorded' AND (
 json_extract(NEW.payload,'$.payload.sourceRef') LIKE 'map.runner.model.%') AND NOT EXISTS (
 SELECT 1 FROM model_call_ledger m WHERE m.workflow_run_id=NEW.workflow_run_id AND m.usage_event_id=NEW.event_id
 AND m.state='SETTLED' AND json_extract(NEW.payload,'$.payload.sourceRef')='map.runner.model.call.v1:'||m.model_call_id
 AND json_extract(NEW.payload,'$.payload.llmCalls')=json_extract(m.usage_json,'$.llmCalls')
 AND json_extract(NEW.payload,'$.payload.inputTokens')=json_extract(m.usage_json,'$.inputTokens')
 AND json_extract(NEW.payload,'$.payload.outputTokens')=json_extract(m.usage_json,'$.outputTokens')
 AND json_extract(NEW.payload,'$.payload.estimatedCost')=json_extract(m.usage_json,'$.estimatedCost'))
BEGIN SELECT RAISE(ABORT,'MODEL_USAGE_REQUIRES_LEDGER'); END;
${audit('INSERT', "'MODEL_CALL_RESERVED'", 'NULL')}
${audit('UPDATE', `CASE WHEN NEW.application_status='APPLIED' THEN 'MODEL_RESPONSE_APPLIED' WHEN NEW.application_status='DISCARDED' THEN 'MODEL_RESPONSE_DISCARDED' WHEN NEW.budget_violation=1 THEN 'MODEL_BUDGET_VIOLATION' ELSE 'MODEL_CALL_'||NEW.state END`, 'OLD.state')}
`;
