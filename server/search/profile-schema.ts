/** Authoritative controls and receipts only. Chunk text and vectors belong to the derived generation. */
export const SEARCH_PROFILE_SCHEMA = `
CREATE TABLE search_profiles (
  workspace_id TEXT NOT NULL, actor_id TEXT NOT NULL, room_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version>0), active INTEGER NOT NULL CHECK(active IN (0,1)),
  provider TEXT NOT NULL, model TEXT NOT NULL, space_id TEXT NOT NULL,
  config_json TEXT NOT NULL, config_digest TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY(workspace_id,actor_id,room_id,version),
  FOREIGN KEY(workspace_id,actor_id) REFERENCES principals(workspace_id,actor_id),
  FOREIGN KEY(workspace_id,room_id) REFERENCES rooms(workspace_id,room_id)
) STRICT;
CREATE UNIQUE INDEX search_profile_active ON search_profiles(workspace_id,actor_id,room_id) WHERE active=1;
CREATE TABLE search_operations (
  operation_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, actor_id TEXT NOT NULL, room_id TEXT NOT NULL,
  profile_version INTEGER NOT NULL, purpose TEXT NOT NULL CHECK(purpose IN ('DOCUMENT_EMBEDDING','QUERY_EMBEDDING','RERANK')),
  source_ref TEXT, payload_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('RESERVED','DISPATCH_INTENT','SUCCEEDED','REJECTED','OUTCOME_UNKNOWN')),
  reserved_tokens INTEGER NOT NULL CHECK(reserved_tokens>0), reserved_cost_micros INTEGER NOT NULL CHECK(reserved_cost_micros>0),
  usage_json TEXT, estimated_cost_micros INTEGER CHECK(estimated_cost_micros>=0),
  created_at INTEGER NOT NULL, dispatched_at INTEGER, finished_at INTEGER,
  FOREIGN KEY(workspace_id,actor_id,room_id,profile_version) REFERENCES search_profiles(workspace_id,actor_id,room_id,version)
) STRICT;
CREATE INDEX search_operation_budget ON search_operations(workspace_id,actor_id,room_id,profile_version);
CREATE INDEX search_operation_state ON search_operations(state);
`;
