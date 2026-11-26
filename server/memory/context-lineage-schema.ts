/** Schema 7 only. Released MEMORY_SCHEMA_SQL and LINEAGE_WORK_SCHEMA stay byte-for-byte stable. */
export const CONTEXT_LINEAGE_SCHEMA = `
ALTER TABLE memory_lineage_work ADD COLUMN notes_done INTEGER NOT NULL DEFAULT 0 CHECK(notes_done>=0);
CREATE TABLE memory_lineage_notes(
  candidate_id TEXT NOT NULL REFERENCES memory_lineage_work(candidate_id),
  note_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>0),
  file_digest TEXT NOT NULL, body_digest TEXT NOT NULL,
  owner_persona_id TEXT NOT NULL, scope TEXT NOT NULL CHECK(scope='room_shared'),
  consumer_call_id TEXT NOT NULL REFERENCES app_provider_calls(call_id),
  receipt_before INTEGER NOT NULL CHECK(receipt_before>0),
  checked INTEGER NOT NULL DEFAULT 0 CHECK(checked IN (0,1)),
  phase TEXT NOT NULL DEFAULT 'SOURCE' CHECK(phase IN ('SOURCE','AUTHORITIES','DONE')),
  after_authority INTEGER NOT NULL DEFAULT 0 CHECK(after_authority>=0),
  after_authority_key TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY(candidate_id,note_id)
) STRICT;
CREATE INDEX memory_lineage_notes_ready ON memory_lineage_notes(candidate_id,note_id) WHERE checked=0;
CREATE INDEX memory_lineage_notes_source ON memory_lineage_notes(note_id,candidate_id);
CREATE INDEX memory_lineage_authority_page ON memory_authorities(candidate_id);
CREATE INDEX memory_handwritten_authority_page ON memory_handwritten_grants(note_id);

DROP TRIGGER memory_grant_revoked;
CREATE TRIGGER memory_grant_revoked AFTER UPDATE OF revoked_at ON access_grants
WHEN OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
BEGIN
  UPDATE memory_candidates SET state='NEEDS_REVIEW'
  WHERE (state IN ('DRAFT','PENDING_REVIEW','APPROVED','PUBLISHING','PUBLISHED','MANUAL_PROPOSAL','FAILED','CONFLICT')
    OR EXISTS(SELECT 1 FROM memory_lineage_work w WHERE w.candidate_id=memory_candidates.candidate_id AND w.status='PENDING'))
    AND workspace_id=OLD.workspace_id AND candidate_id IN (
      SELECT candidate_id FROM memory_authorities WHERE actor_id=OLD.actor_id AND operation=OLD.operation
      AND (OLD.room_id='*' OR room_id=OLD.room_id)
      AND (OLD.persona_id='*' OR persona_id=OLD.persona_id)
      AND (OLD.visibility='*' OR visibility=OLD.visibility)
      AND OLD.provider IN ('*','')
      AND (operation NOT IN ('READ_PRIVATE_SEGMENT','READ_MEMORY','PROPOSE_MEMORY','EDIT_MEMORY','REVIEW_MEMORY',
        'PUBLISH_MEMORY','CHANGE_MEMORY_SCOPE','RETRACT_MEMORY')
        OR (room_id=OLD.room_id AND persona_id=OLD.persona_id AND visibility=OLD.visibility))
    );
END;
`;
