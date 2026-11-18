/** Application-only migration fragment. Never added to the COORD migration ledger. */
export const OPERATIONS_SCHEMA = `
CREATE TABLE app_operational_state (singleton INTEGER PRIMARY KEY CHECK(singleton=1), maintenance INTEGER NOT NULL CHECK(maintenance IN (0,1)), restored INTEGER NOT NULL CHECK(restored IN (0,1))) STRICT;
INSERT INTO app_operational_state VALUES(1,0,0);
CREATE TABLE import_batches (
 workspace_id TEXT NOT NULL, batch_id TEXT NOT NULL, actor_id TEXT NOT NULL,
 source_id TEXT NOT NULL, request_id TEXT NOT NULL, manifest_digest TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('STAGING','COMPLETE','FAILED')),
 manifest_json TEXT NOT NULL, reconciliation_json TEXT, created_at INTEGER NOT NULL,
 completed_at INTEGER, PRIMARY KEY(workspace_id,batch_id),
 UNIQUE(workspace_id,actor_id,request_id), UNIQUE(workspace_id,actor_id,source_id,manifest_digest),
 FOREIGN KEY(workspace_id) REFERENCES workspaces(workspace_id)
) STRICT;
CREATE TABLE import_requests (
 workspace_id TEXT NOT NULL, actor_id TEXT NOT NULL, request_id TEXT NOT NULL,
 source_id TEXT NOT NULL, manifest_digest TEXT NOT NULL, batch_id TEXT NOT NULL,
 PRIMARY KEY(workspace_id,actor_id,request_id),
 FOREIGN KEY(workspace_id,batch_id) REFERENCES import_batches(workspace_id,batch_id)
) STRICT;
CREATE TABLE import_item_map (
 workspace_id TEXT NOT NULL, batch_id TEXT NOT NULL, kind TEXT NOT NULL, source_key TEXT NOT NULL,
 source_digest TEXT NOT NULL, target_id TEXT NOT NULL, target_digest TEXT NOT NULL,
 details_json TEXT NOT NULL, PRIMARY KEY(workspace_id,batch_id,kind,source_key),
 FOREIGN KEY(workspace_id,batch_id) REFERENCES import_batches(workspace_id,batch_id)
) STRICT;
CREATE TABLE import_source_registry (
 workspace_id TEXT NOT NULL, actor_id TEXT NOT NULL, source_id TEXT NOT NULL,
 kind TEXT NOT NULL, source_key TEXT NOT NULL, source_digest TEXT NOT NULL,
 batch_id TEXT NOT NULL, PRIMARY KEY(workspace_id,actor_id,source_id,kind,source_key),
 FOREIGN KEY(workspace_id,batch_id) REFERENCES import_batches(workspace_id,batch_id)
) STRICT;
CREATE TABLE import_source_records (
 workspace_id TEXT NOT NULL, batch_id TEXT NOT NULL, room_id TEXT NOT NULL,
 message_id TEXT NOT NULL, original_content TEXT NOT NULL, source_digest TEXT NOT NULL,
 timestamp_trust TEXT NOT NULL CHECK(timestamp_trust IN ('legacy','unknown')),
 incomplete INTEGER NOT NULL CHECK(incomplete IN (0,1)),
 PRIMARY KEY(workspace_id,batch_id,message_id),
 FOREIGN KEY(workspace_id,batch_id) REFERENCES import_batches(workspace_id,batch_id),
 FOREIGN KEY(workspace_id,room_id,message_id) REFERENCES messages(workspace_id,room_id,message_id)
) STRICT;
CREATE TABLE import_decisions (
 workspace_id TEXT NOT NULL, batch_id TEXT NOT NULL, room_id TEXT NOT NULL,
 decision_id TEXT NOT NULL, persona_id TEXT NOT NULL, legacy_turn_id TEXT NOT NULL,
 payload_json TEXT NOT NULL, source_digest TEXT NOT NULL,
 PRIMARY KEY(workspace_id,room_id,decision_id),
 FOREIGN KEY(workspace_id,batch_id) REFERENCES import_batches(workspace_id,batch_id),
 FOREIGN KEY(workspace_id,room_id) REFERENCES rooms(workspace_id,room_id)
) STRICT;
CREATE TABLE import_reactions (
 workspace_id TEXT NOT NULL, batch_id TEXT NOT NULL, room_id TEXT NOT NULL,
 reaction_id TEXT NOT NULL, message_id TEXT NOT NULL, persona_id TEXT NOT NULL,
 legacy_turn_id TEXT NOT NULL, semantic TEXT NOT NULL, occurred_at INTEGER NOT NULL,
 source_digest TEXT NOT NULL, PRIMARY KEY(workspace_id,room_id,reaction_id),
 FOREIGN KEY(workspace_id,batch_id) REFERENCES import_batches(workspace_id,batch_id),
 FOREIGN KEY(workspace_id,room_id,message_id) REFERENCES messages(workspace_id,room_id,message_id)
) STRICT;
CREATE INDEX import_batches_actor ON import_batches(workspace_id,actor_id,created_at);
`;
