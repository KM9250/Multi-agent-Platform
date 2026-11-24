import { invalidationSchema, LIVE_CANDIDATES } from "./invalidation.ts";

export const LINEAGE_WORK_SCHEMA = `
CREATE TABLE memory_lineage_work(
  candidate_id TEXT PRIMARY KEY REFERENCES memory_candidates(candidate_id),
  mode TEXT NOT NULL CHECK(mode IN ('NEW','LEGACY')),
  prior_state TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('PENDING','DONE','INVALID')),
  invalidated INTEGER NOT NULL DEFAULT 0 CHECK(invalidated IN (0,1)),
  calls_done INTEGER NOT NULL DEFAULT 0, refs_done INTEGER NOT NULL DEFAULT 0,
  last_step INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX memory_lineage_work_ready ON memory_lineage_work(last_step,candidate_id) WHERE status='PENDING';
CREATE TABLE memory_lineage_queue(
  candidate_id TEXT NOT NULL REFERENCES memory_lineage_work(candidate_id), call_id TEXT NOT NULL,
  checked INTEGER NOT NULL DEFAULT 0 CHECK(checked IN (0,1)),
  PRIMARY KEY(candidate_id,call_id)
) STRICT;
CREATE INDEX memory_lineage_queue_ready ON memory_lineage_queue(candidate_id,call_id) WHERE checked=0;

CREATE INDEX memory_review_candidate ON memory_reviews(candidate_id);
CREATE INDEX memory_review_request ON memory_reviews(workspace_id,actor_id,request_id);
CREATE INDEX memory_document_candidate ON memory_documents(candidate_id);
CREATE INDEX memory_retract_note ON memory_retract_requests(note_id);
CREATE INDEX memory_candidate_withdrawals ON app_audit_events(workspace_id,target_id) WHERE action='MEMORY_CANDIDATE_RETRACTED';
CREATE INDEX memory_last_visible_state ON memory_changes(note_id,seq) WHERE state NOT IN ('NEEDS_REVIEW','LINEAGE_PENDING');
CREATE INDEX memory_published_body_change ON memory_changes(note_id,version) WHERE action='BODY_CHANGED' AND state='PUBLISHED';

DROP TRIGGER memory_message_changed;
DROP TRIGGER memory_attachment_changed;
DROP TRIGGER memory_source_note_changed;
DROP TRIGGER memory_room_removed;
DROP TRIGGER memory_persona_removed;
DROP TRIGGER memory_grant_revoked;
DROP TRIGGER memory_actor_disabled;
DROP TRIGGER memory_membership_removed;
${invalidationSchema(
  `(${LIVE_CANDIDATES} OR EXISTS(SELECT 1 FROM memory_lineage_work lw
      WHERE lw.candidate_id=memory_candidates.candidate_id AND lw.status='PENDING'))`,
  "NEW.state NOT IN ('PUBLISHED','LINEAGE_PENDING')",
)}
CREATE TRIGGER memory_lineage_changed AFTER UPDATE OF state ON memory_candidates
WHEN NEW.state IN ('NEEDS_REVIEW','RETRACTED','REJECTED','SUPERSEDED')
BEGIN
  UPDATE memory_lineage_work SET invalidated=1 WHERE candidate_id=NEW.candidate_id AND status='PENDING';
END;
`;
