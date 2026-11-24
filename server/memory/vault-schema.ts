import { LIVE_NOTE_PREDICATE } from "./limits.ts";

/** Single explicitly registered filesystem port. Paths and properties never grant access. */
export const VAULT_SCHEMA = `
CREATE TABLE memory_vault (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),root TEXT NOT NULL,dev TEXT NOT NULL,ino TEXT NOT NULL,
 paused INTEGER NOT NULL CHECK(paused IN (0,1)),trust_new INTEGER NOT NULL CHECK(trust_new IN (0,1))
) STRICT;
CREATE TABLE memory_jobs (
 operation_id TEXT PRIMARY KEY REFERENCES memory_reviews(review_id),
 candidate_id TEXT NOT NULL UNIQUE REFERENCES memory_candidates(candidate_id),
 revision INTEGER NOT NULL,workspace_id TEXT NOT NULL,room_id TEXT NOT NULL,owner_persona_id TEXT NOT NULL,
 scope TEXT NOT NULL,reviewer_id TEXT NOT NULL,note_id TEXT NOT NULL UNIQUE,relative_path TEXT NOT NULL,
 markdown TEXT NOT NULL,file_digest TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','PUBLISHING','PUBLISHED','FAILED','CONFLICT','RETRACTED')),
 prepared INTEGER NOT NULL DEFAULT 0 CHECK(prepared IN (0,1)),error_code TEXT, created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX memory_jobs_ready ON memory_jobs(created_at, operation_id) WHERE status IN ('PENDING','PUBLISHING');
CREATE INDEX memory_jobs_publishing ON memory_jobs(operation_id) WHERE status='PUBLISHING';
CREATE TABLE memory_documents (
 note_id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,room_id TEXT NOT NULL,owner_persona_id TEXT NOT NULL,
 scope TEXT NOT NULL,candidate_id TEXT REFERENCES memory_candidates(candidate_id),
 state TEXT NOT NULL,relative_path TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>0),
 digest TEXT NOT NULL,body_digest TEXT NOT NULL,trusted INTEGER NOT NULL CHECK(trusted IN (0,1))
) STRICT;
CREATE INDEX memory_documents_live ON memory_documents(note_id) WHERE ${LIVE_NOTE_PREDICATE};
CREATE INDEX memory_documents_room ON memory_documents(workspace_id, room_id, note_id);
CREATE INDEX memory_documents_path ON memory_documents(relative_path);
CREATE TABLE memory_versions (
 note_id TEXT NOT NULL REFERENCES memory_documents(note_id),version INTEGER NOT NULL,digest TEXT NOT NULL,
 body_digest TEXT NOT NULL,relative_path TEXT NOT NULL,created_at INTEGER NOT NULL, PRIMARY KEY(note_id,version)
) STRICT;
CREATE TABLE memory_receipts (
 operation_id TEXT PRIMARY KEY REFERENCES memory_jobs(operation_id),
 note_id TEXT NOT NULL UNIQUE REFERENCES memory_documents(note_id),file_digest TEXT NOT NULL,created_at INTEGER NOT NULL
) STRICT;
`;
