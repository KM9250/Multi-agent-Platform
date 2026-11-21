/** Cursors are random, so a room reader cannot infer changes to other personas from sequence gaps. */
export const NOTE_SCHEMA = `
CREATE TABLE memory_changes(
  seq INTEGER PRIMARY KEY AUTOINCREMENT, change_id TEXT NOT NULL UNIQUE,
  note_id TEXT NOT NULL REFERENCES memory_documents(note_id),
  version INTEGER NOT NULL, state TEXT NOT NULL, action TEXT NOT NULL
) STRICT;
CREATE INDEX memory_change_note ON memory_changes(note_id,seq);
CREATE TABLE memory_observations(
  note_id TEXT PRIMARY KEY REFERENCES memory_documents(note_id),
  relative_path TEXT NOT NULL, digest TEXT NOT NULL, first_seen_at INTEGER NOT NULL
) STRICT;
CREATE TABLE memory_retract_requests(
  workspace_id TEXT NOT NULL, actor_id TEXT NOT NULL, request_id TEXT NOT NULL,
  note_id TEXT NOT NULL REFERENCES memory_documents(note_id), version INTEGER NOT NULL, digest TEXT NOT NULL,
  PRIMARY KEY(workspace_id,actor_id,request_id)
) STRICT;
CREATE TABLE memory_handwritten(
  note_id TEXT PRIMARY KEY REFERENCES memory_documents(note_id),
  workspace_id TEXT NOT NULL, registrar_id TEXT NOT NULL, request_id TEXT NOT NULL, request_digest TEXT NOT NULL,
  original_path TEXT NOT NULL, original_digest TEXT NOT NULL, registered_at INTEGER NOT NULL,
  FOREIGN KEY(workspace_id,registrar_id) REFERENCES principals(workspace_id,actor_id),
  UNIQUE(workspace_id,registrar_id,request_id)
) STRICT;
CREATE TABLE memory_handwritten_grants(
  note_id TEXT NOT NULL REFERENCES memory_handwritten(note_id),grant_id TEXT NOT NULL REFERENCES access_grants(grant_id),
  PRIMARY KEY(note_id,grant_id)
) STRICT;
CREATE INDEX memory_handwritten_grant_lookup ON memory_handwritten_grants(grant_id,note_id);
CREATE TRIGGER memory_handwritten_revoked AFTER UPDATE OF revoked_at ON access_grants
WHEN NEW.revoked_at IS NOT NULL AND OLD.revoked_at IS NULL BEGIN
  UPDATE memory_documents SET state='NEEDS_REVIEW' WHERE state NOT IN ('RETRACTED','NEEDS_REVIEW') AND note_id IN
    (SELECT note_id FROM memory_handwritten_grants WHERE grant_id=OLD.grant_id);
END;
CREATE TRIGGER memory_handwritten_registrar_inactive AFTER UPDATE OF active ON principals
WHEN OLD.active=1 AND NEW.active=0 BEGIN
  UPDATE memory_documents SET state='NEEDS_REVIEW' WHERE state NOT IN ('RETRACTED','NEEDS_REVIEW') AND note_id IN
    (SELECT note_id FROM memory_handwritten WHERE workspace_id=OLD.workspace_id AND registrar_id=OLD.actor_id);
END;
CREATE TRIGGER memory_handwritten_room_removed AFTER UPDATE OF deleted_at ON rooms
WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL BEGIN
  UPDATE memory_documents SET state='NEEDS_REVIEW' WHERE workspace_id=OLD.workspace_id AND room_id=OLD.room_id
    AND candidate_id IS NULL AND state NOT IN ('RETRACTED','NEEDS_REVIEW');
END;
CREATE TRIGGER memory_handwritten_persona_removed AFTER UPDATE OF deleted_at ON personas
WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL BEGIN
  UPDATE memory_documents SET state='NEEDS_REVIEW' WHERE workspace_id=OLD.workspace_id AND owner_persona_id=OLD.persona_id
    AND candidate_id IS NULL AND state NOT IN ('RETRACTED','NEEDS_REVIEW');
END;
CREATE TABLE memory_scan_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1), incomplete INTEGER NOT NULL) STRICT;
INSERT INTO memory_scan_state VALUES(1,0);
CREATE TRIGGER memory_first_publication AFTER INSERT ON memory_documents BEGIN
  INSERT INTO memory_changes(change_id,note_id,version,state,action)
  VALUES(lower(hex(randomblob(16))),NEW.note_id,NEW.version,NEW.state,'PUBLISHED');
END;
CREATE TRIGGER memory_document_change AFTER UPDATE ON memory_documents
WHEN OLD.state<>NEW.state OR OLD.version<>NEW.version OR OLD.relative_path<>NEW.relative_path OR OLD.trusted<>NEW.trusted BEGIN
  INSERT INTO memory_changes(change_id,note_id,version,state,action)
  VALUES(lower(hex(randomblob(16))),NEW.note_id,NEW.version,NEW.state,CASE
    WHEN OLD.version<>NEW.version THEN 'BODY_CHANGED'
    WHEN OLD.relative_path<>NEW.relative_path THEN 'RENAMED'
    WHEN OLD.trusted<>NEW.trusted THEN 'TRUST_CHANGED' ELSE NEW.state END);
END;
CREATE TRIGGER memory_note_source_invalid AFTER UPDATE OF state ON memory_candidates
WHEN NEW.state='NEEDS_REVIEW' AND OLD.state<>NEW.state BEGIN
  UPDATE memory_documents SET state='NEEDS_REVIEW' WHERE candidate_id=NEW.candidate_id AND state<>'RETRACTED';
END;
`;
