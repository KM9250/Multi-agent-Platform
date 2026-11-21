import { VAULT_SCHEMA } from "./vault-schema.ts";
import { NOTE_SCHEMA } from "./note-schema.ts";
import { INVALIDATION_SCHEMA } from "./invalidation.ts";

export const MEMORY_SCHEMA_SQL = `
CREATE TABLE memory_candidates (
  candidate_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, room_id TEXT NOT NULL,
  owner_persona_id TEXT NOT NULL, current_revision INTEGER NOT NULL CHECK(current_revision>0),
  state TEXT NOT NULL, target_note_id TEXT NOT NULL, target_version INTEGER, target_digest TEXT,
  proposer_id TEXT NOT NULL, created_at INTEGER NOT NULL, source_segment_id TEXT UNIQUE, call_id TEXT,
  CHECK((target_version IS NULL) = (target_digest IS NULL)),
  CHECK((source_segment_id IS NULL) = (call_id IS NULL)),
  FOREIGN KEY(workspace_id,room_id,owner_persona_id) REFERENCES room_personas(workspace_id,room_id,persona_id),
  FOREIGN KEY(workspace_id,proposer_id) REFERENCES principals(workspace_id,actor_id),
  FOREIGN KEY(workspace_id,room_id,call_id) REFERENCES app_generation_receipts(workspace_id,room_id,call_id),
  FOREIGN KEY(source_segment_id) REFERENCES message_segments(segment_id),
  FOREIGN KEY(candidate_id,current_revision) REFERENCES memory_candidate_revisions(candidate_id,revision) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE INDEX memory_candidates_room ON memory_candidates(workspace_id,room_id,owner_persona_id,candidate_id);
CREATE TABLE memory_candidate_revisions (
  candidate_id TEXT NOT NULL REFERENCES memory_candidates(candidate_id), revision INTEGER NOT NULL,
  body TEXT NOT NULL, body_digest TEXT NOT NULL, sources_json TEXT NOT NULL, sources_digest TEXT NOT NULL,
  kind TEXT NOT NULL, assertion_type TEXT NOT NULL, scope TEXT NOT NULL CHECK(scope IN ('persona_private','room_shared')),
  edited_by TEXT NOT NULL REFERENCES principals(actor_id), created_at INTEGER NOT NULL, PRIMARY KEY(candidate_id,revision)
) STRICT;
CREATE TABLE memory_dependencies (
  candidate_id TEXT NOT NULL REFERENCES memory_candidates(candidate_id), workspace_id TEXT NOT NULL, room_id TEXT NOT NULL,
  resource_type TEXT NOT NULL, resource_id TEXT NOT NULL, revision INTEGER NOT NULL, digest TEXT NOT NULL,
  PRIMARY KEY(candidate_id,resource_type,resource_id)
) STRICT;
CREATE INDEX memory_dep_source ON memory_dependencies(workspace_id,room_id,resource_type,resource_id);
CREATE TABLE memory_authorities (
  candidate_id TEXT NOT NULL REFERENCES memory_candidates(candidate_id), actor_id TEXT NOT NULL REFERENCES principals(actor_id),
  operation TEXT NOT NULL, room_id TEXT NOT NULL, persona_id TEXT NOT NULL, visibility TEXT NOT NULL,
  PRIMARY KEY(candidate_id,actor_id,operation,room_id,persona_id,visibility)
) STRICT;
CREATE INDEX memory_authorities_actor ON memory_authorities(actor_id,operation);
CREATE TABLE memory_requests (
  workspace_id TEXT NOT NULL, actor_id TEXT NOT NULL, room_id TEXT NOT NULL, request_id TEXT NOT NULL,
  request_digest TEXT NOT NULL, result_ids_json TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY(workspace_id,actor_id,request_id), FOREIGN KEY(workspace_id,actor_id) REFERENCES principals(workspace_id,actor_id)
) STRICT;
CREATE TABLE memory_reviews (
  review_id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL, candidate_revision INTEGER NOT NULL, decision TEXT NOT NULL,
  binding_json TEXT NOT NULL, workspace_id TEXT NOT NULL, actor_id TEXT NOT NULL, request_id TEXT NOT NULL, created_at INTEGER NOT NULL,
  FOREIGN KEY(candidate_id,candidate_revision) REFERENCES memory_candidate_revisions(candidate_id,revision),
  FOREIGN KEY(workspace_id,actor_id,request_id) REFERENCES memory_requests(workspace_id,actor_id,request_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
${VAULT_SCHEMA}
${NOTE_SCHEMA}
${INVALIDATION_SCHEMA}
`;
