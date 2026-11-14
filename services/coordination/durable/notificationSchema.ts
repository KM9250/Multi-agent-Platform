/** Schema 11 is additive. Historical migration strings must never import this module. */
export const NOTIFICATION_COLUMNS: Record<string, readonly string[]> = {
 notification_sources: ['source_id','workflow_run_id','notification_id','kind','source_kind','source_ref','source_version','source_digest','occurrence_identity','occurred_at','projection_contract','source_sequence','owner_subject','source_json','capture_reason'],
 notification_capture_cursors: ['workflow_run_id','source_kind','cursor_json','cursor_digest','revision'],
 notification_deliveries: ['delivery_id','workflow_run_id','source_id','notification_id','destination_id','binding_digest','receiver_realm','audience','recipient_subject','packet_json','packet_digest','template_version','state','necessity','revision','attempt_count','auto_attempt_count','next_attempt_at','horizon_at','created_at','updated_at','stop_reason','outcome_unknown','management_paused','claim_generation'],
 notification_stream_claims: ['stream_key','workflow_run_id','destination_id','delivery_id','claim_id','worker_id','generation','expires_at','delivery_revision','packet_digest','binding_digest'],
 notification_delivery_attempts: ['attempt_id','delivery_id','workflow_run_id','attempt_number','claim_id','claim_generation','worker_id','state','started_at','finished_at','error_code','http_status'],
 notification_delivery_receipts: ['receipt_id','delivery_id','workflow_run_id','attempt_id','claim_id','claim_generation','packet_digest','receiver_realm','task_id','event_id','http_status','idempotent_replay','received_at'],
 notification_delivery_audit: ['audit_id','workflow_run_id','source_id','delivery_id','attempt_id','event_kind','actor_id','reason','record_digest','recorded_at'],
 notification_management_receipts: ['receipt_id','workflow_run_id','actor_id','request_id','command_digest','command_json','result_json','created_at'],
 notification_migration_baselines: ['workflow_run_id','journal_sequence','journal_anchor','occurrence_ids_json','baseline_digest','created_at'],
};
const hash = (name:string) => `${name} TEXT NOT NULL CHECK(length(${name})=64)`;
const json = (name:string,max=8192) => `${name} TEXT NOT NULL CHECK(json_valid(${name}) AND length(CAST(${name} AS BLOB))<=${max})`;
const vector = (table:string,prefix:string) => `json_array(${NOTIFICATION_COLUMNS[table].map(c=>`${prefix}.${c}`).join(',')})`;
const guard = (table:string,op:'INSERT'|'UPDATE') => `CREATE TRIGGER ${table}_scope_${op} BEFORE ${op} ON ${table}
 WHEN map_notification_write('${table}',${op==='UPDATE'?vector(table,'OLD'):'NULL'},${vector(table,'NEW')})<>1
 BEGIN SELECT RAISE(ABORT,'NOTIFICATION_UNAUTHORIZED'); END;`;
const immutable = (table:string) => `CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'NOTIFICATION_IMMUTABLE'); END;`;
const noDelete = (table:string) => `CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'NOTIFICATION_IMMUTABLE'); END;`;
const same = (columns:string[]) => columns.map(c=>`NEW.${c} IS NOT OLD.${c}`).join(' OR ');

export const NOTIFICATION_SQL = `
CREATE TABLE notification_sources (
 source_id TEXT PRIMARY KEY NOT NULL, workflow_run_id TEXT NOT NULL REFERENCES workflow_seeds(workflow_run_id),
 notification_id TEXT NOT NULL UNIQUE,
 kind TEXT NOT NULL CHECK(kind IN ('workflow_completed','workflow_cancelled','action_approval_required','security_review_required','evidence_review_required','execution_review_required','budget_exhausted','workflow_attention_required','planning_review_required','planning_input_required','recovery_review_required','reconciliation_review_required')),
 source_kind TEXT NOT NULL CHECK(source_kind IN ('JOURNAL','PLAN_ARTIFACT','PLANNING_INPUT','BOUNDED_INVOCATION','RECONCILIATION_DISPUTE','RECONCILIATION_OPERATION')),
 source_ref TEXT NOT NULL, source_version TEXT NOT NULL, ${hash('source_digest')}, occurrence_identity TEXT NOT NULL,
 occurred_at REAL NOT NULL CHECK(occurred_at>=0), projection_contract TEXT NOT NULL CHECK(projection_contract='COORD-5D:DURABLE_NOTIFICATION:1'),
 source_sequence INTEGER NOT NULL CHECK(source_sequence>=1), owner_subject TEXT, ${json('source_json')},
 capture_reason TEXT NOT NULL CHECK(capture_reason IN ('ATOMIC_COMMIT','LEGACY_UNRESOLVED_SYNC')),
 UNIQUE(workflow_run_id,source_id), UNIQUE(workflow_run_id,source_sequence), UNIQUE(workflow_run_id,occurrence_identity)
) STRICT;
CREATE TABLE notification_capture_cursors (
 workflow_run_id TEXT NOT NULL REFERENCES workflow_seeds(workflow_run_id), source_kind TEXT NOT NULL,
 ${json('cursor_json',1048576)}, ${hash('cursor_digest')}, revision INTEGER NOT NULL CHECK(revision>=1), PRIMARY KEY(workflow_run_id,source_kind)
) STRICT;
CREATE TABLE notification_deliveries (
 delivery_id TEXT PRIMARY KEY NOT NULL, workflow_run_id TEXT NOT NULL,
 source_id TEXT NOT NULL UNIQUE, notification_id TEXT NOT NULL UNIQUE,
 destination_id TEXT NOT NULL, ${hash('binding_digest')}, receiver_realm TEXT NOT NULL, audience TEXT NOT NULL, recipient_subject TEXT NOT NULL,
 ${json('packet_json',4096)}, ${hash('packet_digest')}, template_version TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('PENDING','SENDING','RETRY_WAIT','DELIVERED','SUPPRESSED','CLOSED_UNCONFIRMED','PAUSED','DELIVERY_FAILED')),
 necessity TEXT NOT NULL CHECK(necessity IN ('REQUIRED','RESOLVED','SUPERSEDED','CANCELLED','UNKNOWN')),
 revision INTEGER NOT NULL CHECK(revision>=1), attempt_count INTEGER NOT NULL CHECK(attempt_count BETWEEN 0 AND 10),
 auto_attempt_count INTEGER NOT NULL CHECK(auto_attempt_count BETWEEN 0 AND 10 AND auto_attempt_count<=attempt_count),
 next_attempt_at INTEGER NOT NULL CHECK(next_attempt_at>=0), horizon_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 stop_reason TEXT, outcome_unknown INTEGER NOT NULL CHECK(outcome_unknown IN (0,1)), management_paused INTEGER NOT NULL CHECK(management_paused IN (0,1)),
 claim_generation INTEGER NOT NULL CHECK(claim_generation>=0),
 UNIQUE(workflow_run_id,delivery_id),
 FOREIGN KEY(workflow_run_id,source_id) REFERENCES notification_sources(workflow_run_id,source_id)
) STRICT;
CREATE TABLE notification_stream_claims (
 stream_key TEXT PRIMARY KEY NOT NULL, workflow_run_id TEXT NOT NULL, destination_id TEXT NOT NULL, delivery_id TEXT NOT NULL,
 claim_id TEXT NOT NULL UNIQUE, worker_id TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation>=1), expires_at INTEGER NOT NULL,
 delivery_revision INTEGER NOT NULL CHECK(delivery_revision>=1), ${hash('packet_digest')}, ${hash('binding_digest')},
 UNIQUE(workflow_run_id,destination_id), FOREIGN KEY(workflow_run_id,delivery_id) REFERENCES notification_deliveries(workflow_run_id,delivery_id)
) STRICT;
CREATE TABLE notification_delivery_attempts (
 attempt_id TEXT PRIMARY KEY NOT NULL, delivery_id TEXT NOT NULL, workflow_run_id TEXT NOT NULL,
 attempt_number INTEGER NOT NULL CHECK(attempt_number BETWEEN 1 AND 10), claim_id TEXT NOT NULL, claim_generation INTEGER NOT NULL CHECK(claim_generation>=1), worker_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('SENDING','NOT_SENT_PROVEN','SEND_OUTCOME_UNKNOWN','RECEIVED','REJECTED')),
 started_at INTEGER NOT NULL, finished_at INTEGER, error_code TEXT, http_status INTEGER CHECK(http_status BETWEEN 100 AND 599),
 UNIQUE(delivery_id,attempt_number), UNIQUE(workflow_run_id,delivery_id,attempt_id),
 FOREIGN KEY(workflow_run_id,delivery_id) REFERENCES notification_deliveries(workflow_run_id,delivery_id)
) STRICT;
CREATE TABLE notification_delivery_receipts (
 receipt_id TEXT PRIMARY KEY NOT NULL, delivery_id TEXT NOT NULL, workflow_run_id TEXT NOT NULL, attempt_id TEXT NOT NULL UNIQUE,
 claim_id TEXT NOT NULL, claim_generation INTEGER NOT NULL CHECK(claim_generation>=1), ${hash('packet_digest')}, receiver_realm TEXT NOT NULL,
 task_id TEXT NOT NULL, event_id INTEGER NOT NULL CHECK(event_id>0), http_status INTEGER NOT NULL CHECK(http_status IN (200,201)),
 idempotent_replay INTEGER NOT NULL CHECK(idempotent_replay IN (0,1)), received_at INTEGER NOT NULL,
 CHECK((http_status=200)=(idempotent_replay=1)),
 FOREIGN KEY(workflow_run_id,delivery_id,attempt_id) REFERENCES notification_delivery_attempts(workflow_run_id,delivery_id,attempt_id)
) STRICT;
CREATE TABLE notification_delivery_audit (
 audit_id TEXT PRIMARY KEY NOT NULL, workflow_run_id TEXT NOT NULL REFERENCES workflow_seeds(workflow_run_id),
 source_id TEXT REFERENCES notification_sources(source_id), delivery_id TEXT REFERENCES notification_deliveries(delivery_id), attempt_id TEXT REFERENCES notification_delivery_attempts(attempt_id),
 event_kind TEXT NOT NULL, actor_id TEXT NOT NULL, reason TEXT NOT NULL, ${hash('record_digest')}, recorded_at INTEGER NOT NULL
) STRICT;
CREATE TABLE notification_management_receipts (
 receipt_id TEXT PRIMARY KEY NOT NULL, workflow_run_id TEXT NOT NULL REFERENCES workflow_seeds(workflow_run_id), actor_id TEXT NOT NULL, request_id TEXT NOT NULL,
 ${hash('command_digest')}, ${json('command_json')}, ${json('result_json',65536)}, created_at INTEGER NOT NULL, UNIQUE(actor_id,request_id)
) STRICT;
CREATE TABLE notification_migration_baselines (
 workflow_run_id TEXT PRIMARY KEY NOT NULL REFERENCES workflow_seeds(workflow_run_id), journal_sequence INTEGER NOT NULL CHECK(journal_sequence>=1),
 journal_anchor TEXT NOT NULL, occurrence_ids_json TEXT NOT NULL CHECK(json_valid(occurrence_ids_json)), ${hash('baseline_digest')}, created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX notification_sources_order ON notification_sources(workflow_run_id,source_sequence);
CREATE INDEX notification_delivery_due ON notification_deliveries(state,next_attempt_at,created_at);
CREATE INDEX notification_claim_expiry ON notification_stream_claims(expires_at);
CREATE INDEX notification_attempts_delivery ON notification_delivery_attempts(delivery_id,attempt_number);
CREATE INDEX notification_audit_workflow ON notification_delivery_audit(workflow_run_id,recorded_at,audit_id);
CREATE TRIGGER notification_delivery_source BEFORE INSERT ON notification_deliveries WHEN NOT EXISTS (
 SELECT 1 FROM notification_sources s WHERE s.source_id=NEW.source_id AND s.workflow_run_id=NEW.workflow_run_id AND s.notification_id=NEW.notification_id)
 BEGIN SELECT RAISE(ABORT,'NOTIFICATION_IMMUTABLE'); END;
CREATE TRIGGER notification_receipt_target BEFORE INSERT ON notification_delivery_receipts WHEN NOT EXISTS (
 SELECT 1 FROM notification_delivery_attempts a JOIN notification_deliveries d ON d.delivery_id=a.delivery_id AND d.workflow_run_id=a.workflow_run_id
 WHERE a.attempt_id=NEW.attempt_id AND a.delivery_id=NEW.delivery_id AND a.workflow_run_id=NEW.workflow_run_id
 AND a.claim_id=NEW.claim_id AND a.claim_generation=NEW.claim_generation AND d.packet_digest=NEW.packet_digest
 AND d.receiver_realm=NEW.receiver_realm AND d.notification_id=NEW.task_id)
 BEGIN SELECT RAISE(ABORT,'NOTIFICATION_IMMUTABLE'); END;
${(['INSERT','UPDATE'] as const).map(op=>`CREATE TRIGGER notification_claim_target_${op} BEFORE ${op} ON notification_stream_claims WHEN NOT EXISTS (
 SELECT 1 FROM notification_deliveries d WHERE d.delivery_id=NEW.delivery_id AND d.workflow_run_id=NEW.workflow_run_id
 AND d.destination_id=NEW.destination_id AND d.packet_digest=NEW.packet_digest AND d.binding_digest=NEW.binding_digest)
 BEGIN SELECT RAISE(ABORT,'NOTIFICATION_IMMUTABLE'); END;`).join('\n')}
${Object.keys(NOTIFICATION_COLUMNS).map(t=>guard(t,'INSERT')+'\n'+noDelete(t)).join('\n')}
${['notification_sources','notification_delivery_receipts','notification_delivery_audit','notification_management_receipts','notification_migration_baselines'].map(immutable).join('\n')}
${['notification_deliveries','notification_delivery_attempts','notification_stream_claims','notification_capture_cursors'].map(t=>guard(t,'UPDATE')).join('\n')}
CREATE TRIGGER notification_delivery_transition BEFORE UPDATE ON notification_deliveries WHEN
 ${same(['delivery_id','workflow_run_id','source_id','notification_id','destination_id','binding_digest','receiver_realm','audience','recipient_subject','packet_json','packet_digest','template_version','horizon_at','created_at'])}
 OR NEW.revision<>OLD.revision+1 OR NEW.attempt_count<OLD.attempt_count OR NEW.attempt_count>OLD.attempt_count+1
 OR NEW.auto_attempt_count<OLD.auto_attempt_count OR NEW.auto_attempt_count>OLD.auto_attempt_count+1
 OR NEW.claim_generation<OLD.claim_generation OR NEW.updated_at<OLD.updated_at
 OR (OLD.state='DELIVERED' AND NEW.state<>'DELIVERED')
 OR (OLD.state='SUPPRESSED' AND NEW.state NOT IN ('SUPPRESSED','DELIVERED'))
 OR (OLD.state='CLOSED_UNCONFIRMED' AND NEW.state NOT IN ('CLOSED_UNCONFIRMED','DELIVERED','SUPPRESSED'))
 OR (OLD.state='CLOSED_UNCONFIRMED' AND NEW.state='SUPPRESSED' AND (
   NEW.outcome_unknown<>0
   OR EXISTS(SELECT 1 FROM notification_delivery_attempts a WHERE a.delivery_id=OLD.delivery_id AND a.state NOT IN ('NOT_SENT_PROVEN','REJECTED'))
   OR EXISTS(SELECT 1 FROM notification_delivery_receipts r WHERE r.delivery_id=OLD.delivery_id)))
 OR NOT (NEW.state=OLD.state
   OR OLD.state IN ('PENDING','RETRY_WAIT') AND NEW.state IN ('PENDING','SENDING','SUPPRESSED','CLOSED_UNCONFIRMED','PAUSED','DELIVERY_FAILED')
   OR OLD.state='SENDING' AND NEW.state IN ('RETRY_WAIT','DELIVERED','SUPPRESSED','CLOSED_UNCONFIRMED','PAUSED','DELIVERY_FAILED')
   OR OLD.state IN ('PAUSED','DELIVERY_FAILED') AND NEW.state IN ('PENDING','RETRY_WAIT','PAUSED','DELIVERED','SUPPRESSED','CLOSED_UNCONFIRMED')
   OR OLD.state IN ('SUPPRESSED','CLOSED_UNCONFIRMED') AND NEW.state='DELIVERED'
   OR OLD.state='CLOSED_UNCONFIRMED' AND NEW.state='SUPPRESSED')
 BEGIN SELECT RAISE(ABORT,'NOTIFICATION_IMMUTABLE'); END;
CREATE TRIGGER notification_attempt_transition BEFORE UPDATE ON notification_delivery_attempts WHEN
 ${same(['attempt_id','delivery_id','workflow_run_id','attempt_number','claim_id','claim_generation','worker_id','started_at'])}
 OR OLD.state<>'SENDING' OR NEW.state='SENDING' OR NEW.finished_at IS NULL OR NEW.finished_at<NEW.started_at
 BEGIN SELECT RAISE(ABORT,'NOTIFICATION_IMMUTABLE'); END;
CREATE TRIGGER notification_claim_transition BEFORE UPDATE ON notification_stream_claims WHEN
 ${same(['stream_key','workflow_run_id','destination_id'])}
 OR (NEW.claim_id=OLD.claim_id AND (${same(['delivery_id','worker_id','generation','delivery_revision','packet_digest','binding_digest'])} OR NEW.expires_at>OLD.expires_at))
 OR (NEW.claim_id<>OLD.claim_id AND NEW.generation<>OLD.generation+1)
 BEGIN SELECT RAISE(ABORT,'NOTIFICATION_IMMUTABLE'); END;
CREATE TRIGGER notification_cursor_transition BEFORE UPDATE ON notification_capture_cursors WHEN
 ${same(['workflow_run_id','source_kind'])} OR NEW.revision<>OLD.revision+1
 BEGIN SELECT RAISE(ABORT,'NOTIFICATION_IMMUTABLE'); END;
`;
