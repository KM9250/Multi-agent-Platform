// Revoking a source changes the validity of an approval in the same SQLite
// transaction. Regranting authority never reactivates an old approval.
export const LIVE_CANDIDATES =
  "state IN ('DRAFT','PENDING_REVIEW','APPROVED','PUBLISHING','PUBLISHED','MANUAL_PROPOSAL','FAILED','CONFLICT')";

export function invalidationSchema(
  live: string,
  unavailableNote = "NEW.state<>'PUBLISHED'",
) {
  function invalidateDependencies(type: string, id: string) {
    return `UPDATE memory_candidates SET state='NEEDS_REVIEW'
    WHERE ${live} AND candidate_id IN (
      SELECT candidate_id FROM memory_dependencies
      WHERE workspace_id=OLD.workspace_id AND room_id=OLD.room_id
        AND resource_type='${type}' AND resource_id=OLD.${id}
    );`;
  }

  return `
CREATE TRIGGER memory_message_changed AFTER UPDATE OF current_revision,deleted_at ON messages
WHEN NEW.current_revision<>OLD.current_revision OR NEW.deleted_at IS NOT OLD.deleted_at
BEGIN
  ${invalidateDependencies("MESSAGE", "message_id")}
END;

CREATE TRIGGER memory_attachment_changed AFTER UPDATE OF digest,state,deleted_at ON attachments
WHEN NEW.digest<>OLD.digest OR NEW.state<>OLD.state OR NEW.deleted_at IS NOT OLD.deleted_at
BEGIN
  ${invalidateDependencies("ATTACHMENT", "attachment_id")}
END;

CREATE TRIGGER memory_source_note_changed AFTER UPDATE OF version,digest,state ON memory_documents
WHEN NEW.version<>OLD.version OR NEW.digest<>OLD.digest OR (NEW.state<>OLD.state AND ${unavailableNote})
BEGIN
  ${invalidateDependencies("NOTE", "note_id")}
END;

CREATE TRIGGER memory_room_removed AFTER UPDATE OF deleted_at ON rooms
WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
BEGIN
  UPDATE memory_candidates SET state='NEEDS_REVIEW' WHERE ${live}
    AND workspace_id=OLD.workspace_id AND room_id=OLD.room_id;
END;

CREATE TRIGGER memory_persona_removed AFTER UPDATE OF deleted_at ON personas
WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
BEGIN
  UPDATE memory_candidates SET state='NEEDS_REVIEW' WHERE ${live}
    AND workspace_id=OLD.workspace_id AND (owner_persona_id=OLD.persona_id OR candidate_id IN (
      SELECT d.candidate_id FROM messages m JOIN memory_dependencies d
        ON d.workspace_id=m.workspace_id AND d.room_id=m.room_id AND d.resource_id=m.message_id
      WHERE d.resource_type='MESSAGE' AND m.workspace_id=OLD.workspace_id AND m.persona_id=OLD.persona_id
    ));
END;

CREATE TRIGGER memory_grant_revoked AFTER UPDATE OF revoked_at ON access_grants
WHEN OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
BEGIN
  UPDATE memory_candidates SET state='NEEDS_REVIEW' WHERE ${live} AND workspace_id=OLD.workspace_id
    AND candidate_id IN (SELECT candidate_id FROM memory_authorities
      WHERE actor_id=OLD.actor_id AND operation=OLD.operation
        AND (OLD.room_id='*' OR room_id=OLD.room_id)
        AND (OLD.persona_id='*' OR persona_id=OLD.persona_id)
        AND (OLD.visibility='*' OR visibility=OLD.visibility));
END;

CREATE TRIGGER memory_actor_disabled AFTER UPDATE OF active ON principals
WHEN OLD.active=1 AND NEW.active=0
BEGIN
  UPDATE memory_candidates SET state='NEEDS_REVIEW' WHERE ${live} AND workspace_id=OLD.workspace_id
    AND candidate_id IN (SELECT candidate_id FROM memory_authorities WHERE actor_id=OLD.actor_id);
END;

CREATE TRIGGER memory_membership_removed AFTER DELETE ON room_memberships
BEGIN
  UPDATE memory_candidates SET state='NEEDS_REVIEW' WHERE ${live} AND workspace_id=OLD.workspace_id
    AND room_id=OLD.room_id AND candidate_id IN (
      SELECT candidate_id FROM memory_authorities WHERE actor_id=OLD.actor_id
    );
END;
`;
}
export const INVALIDATION_SCHEMA = invalidationSchema(LIVE_CANDIDATES);
