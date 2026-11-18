/** App schema 1 only; never part of the COORD migration ledger. */
export const GENERATION_SCHEMA = `
CREATE TABLE app_generation_audit (audit_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, room_id TEXT NOT NULL, actor_id TEXT NOT NULL, event TEXT NOT NULL, target_id TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT;
CREATE TABLE app_turns (
 workspace_id TEXT NOT NULL, room_id TEXT NOT NULL, turn_id TEXT NOT NULL,
 actor_id TEXT NOT NULL, request_id TEXT NOT NULL, operation TEXT NOT NULL,
 input_digest TEXT NOT NULL, input_message_id TEXT NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(workspace_id,room_id,turn_id),
 UNIQUE(workspace_id,actor_id,operation,request_id),
 UNIQUE(workspace_id,room_id,turn_id,actor_id),
 FOREIGN KEY(workspace_id,actor_id) REFERENCES principals(workspace_id,actor_id),
 FOREIGN KEY(workspace_id,room_id) REFERENCES rooms(workspace_id,room_id),
 FOREIGN KEY(workspace_id,room_id,input_message_id) REFERENCES messages(workspace_id,room_id,message_id)
) STRICT;
CREATE TABLE app_generation_runs (
 workspace_id TEXT NOT NULL, room_id TEXT NOT NULL, run_id TEXT NOT NULL,
 turn_id TEXT NOT NULL, actor_id TEXT NOT NULL, session_id TEXT,
 state TEXT NOT NULL CHECK(state IN ('QUEUED','RUNNING','COMPLETED','PARTIAL','FAILED','CANCELLED','NEEDS_REVIEW')),
 request_json TEXT NOT NULL, target_message_id TEXT, parent_run_id TEXT,
 owner_id TEXT, accepted_at INTEGER NOT NULL, dispatch_before INTEGER NOT NULL,
 deadline_at INTEGER NOT NULL, collect_before INTEGER NOT NULL, completed_at INTEGER,
 cancelled_at INTEGER, error_code TEXT, limits_json TEXT NOT NULL,
 PRIMARY KEY(workspace_id,room_id,run_id), UNIQUE(run_id),
 FOREIGN KEY(workspace_id,room_id,turn_id,actor_id) REFERENCES app_turns(workspace_id,room_id,turn_id,actor_id),
 FOREIGN KEY(workspace_id,actor_id) REFERENCES principals(workspace_id,actor_id),
 FOREIGN KEY(workspace_id,room_id,parent_run_id) REFERENCES app_generation_runs(workspace_id,room_id,run_id),
 FOREIGN KEY(workspace_id,room_id,target_message_id) REFERENCES messages(workspace_id,room_id,message_id)
) STRICT;
CREATE INDEX app_generation_room ON app_generation_runs(workspace_id,room_id,accepted_at DESC);
CREATE TABLE app_provider_calls (
 workspace_id TEXT NOT NULL, room_id TEXT NOT NULL, run_id TEXT NOT NULL,
 call_id TEXT NOT NULL, ordinal INTEGER NOT NULL, persona_id TEXT NOT NULL,
 purpose TEXT NOT NULL CHECK(purpose IN ('decision','subagent','answer','memory')),
 worker_id TEXT, provider TEXT NOT NULL, model TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('RESERVED','DISPATCH_INTENT','COMPLETED','REJECTED','INVALID','OUTCOME_UNKNOWN','DISCARDED')),
 owner_id TEXT NOT NULL, manifest_json TEXT NOT NULL, manifest_digest TEXT NOT NULL,
 reserved_input_tokens INTEGER NOT NULL, reserved_output_tokens INTEGER NOT NULL,
 reserved_cost_micros INTEGER NOT NULL, pricing_version TEXT NOT NULL,
 usage_state TEXT NOT NULL CHECK(usage_state IN ('UNKNOWN','COMPLETE','PARTIAL')),
 usage_json TEXT, actual_cost_micros INTEGER, reason TEXT,
 reserved_at INTEGER NOT NULL, dispatched_at INTEGER, completed_at INTEGER,
 response_digest TEXT,
 PRIMARY KEY(workspace_id,room_id,call_id), UNIQUE(call_id),
 UNIQUE(workspace_id,room_id,run_id,ordinal),
 UNIQUE(workspace_id,room_id,run_id,call_id),
 UNIQUE(workspace_id,room_id,run_id,call_id,persona_id),
 FOREIGN KEY(workspace_id,room_id,run_id) REFERENCES app_generation_runs(workspace_id,room_id,run_id),
 FOREIGN KEY(workspace_id,room_id,persona_id) REFERENCES room_personas(workspace_id,room_id,persona_id)
) STRICT;
CREATE TABLE app_generation_receipts (
 workspace_id TEXT NOT NULL, room_id TEXT NOT NULL, run_id TEXT NOT NULL, call_id TEXT NOT NULL,
 message_id TEXT, revision INTEGER, status TEXT NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(workspace_id,room_id,call_id),
 FOREIGN KEY(workspace_id,room_id,run_id) REFERENCES app_generation_runs(workspace_id,room_id,run_id),
 FOREIGN KEY(workspace_id,room_id,run_id,call_id) REFERENCES app_provider_calls(workspace_id,room_id,run_id,call_id),
 FOREIGN KEY(workspace_id,room_id,message_id,revision) REFERENCES message_revisions(workspace_id,room_id,message_id,revision)
) STRICT;
CREATE TABLE app_decisions (
 workspace_id TEXT NOT NULL, room_id TEXT NOT NULL, run_id TEXT NOT NULL,
 decision_id TEXT NOT NULL, persona_id TEXT NOT NULL, outcome TEXT NOT NULL,
 source TEXT NOT NULL, reaction TEXT, call_id TEXT, created_at INTEGER NOT NULL,
 PRIMARY KEY(workspace_id,room_id,decision_id),
 UNIQUE(workspace_id,room_id,run_id,persona_id),
 FOREIGN KEY(workspace_id,room_id,run_id,call_id,persona_id) REFERENCES app_provider_calls(workspace_id,room_id,run_id,call_id,persona_id),
 FOREIGN KEY(workspace_id,room_id,run_id) REFERENCES app_generation_runs(workspace_id,room_id,run_id),
 FOREIGN KEY(workspace_id,room_id,persona_id) REFERENCES room_personas(workspace_id,room_id,persona_id)
) STRICT;
CREATE TABLE app_reactions (
 workspace_id TEXT NOT NULL, room_id TEXT NOT NULL, run_id TEXT NOT NULL,
 reaction_id TEXT NOT NULL, message_id TEXT NOT NULL, persona_id TEXT NOT NULL,
 semantic TEXT NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(workspace_id,room_id,reaction_id),
 UNIQUE(workspace_id,room_id,run_id,message_id,persona_id),
 FOREIGN KEY(workspace_id,room_id,run_id) REFERENCES app_generation_runs(workspace_id,room_id,run_id),
 FOREIGN KEY(workspace_id,room_id,message_id) REFERENCES messages(workspace_id,room_id,message_id),
 FOREIGN KEY(workspace_id,room_id,persona_id) REFERENCES room_personas(workspace_id,room_id,persona_id)
) STRICT;
`;
