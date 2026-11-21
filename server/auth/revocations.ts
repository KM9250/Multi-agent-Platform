import type { DatabaseSync } from "node:sqlite";
import { requiresExactScope } from "./operations.ts";

/** An ACL epoch alone cannot identify which previously usable grant was withdrawn. */
export const REVOCATION_SCHEMA = `
CREATE TABLE auth_revocations (
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  actor_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>0),
  action TEXT NOT NULL CHECK(action IN ('REVOKE','ACCOUNT_REVOKE')),
  requested_operation TEXT,
  grant_count INTEGER NOT NULL CHECK(grant_count>=0),
  PRIMARY KEY(workspace_id,actor_id,revision),
  CHECK(action<>'ACCOUNT_REVOKE' OR (requested_operation IS NULL AND grant_count=0))
) STRICT;
CREATE TABLE auth_revoked_grants (
  workspace_id TEXT NOT NULL, actor_id TEXT NOT NULL, revision INTEGER NOT NULL,
  grant_id TEXT NOT NULL, operation TEXT NOT NULL, room_id TEXT NOT NULL, persona_id TEXT NOT NULL,
  provider TEXT NOT NULL, visibility TEXT NOT NULL,
  PRIMARY KEY(workspace_id,actor_id,revision,grant_id),
  FOREIGN KEY(workspace_id,actor_id,revision) REFERENCES auth_revocations(workspace_id,actor_id,revision)
) STRICT;
CREATE INDEX auth_revoked_grants_operation ON auth_revoked_grants(workspace_id,actor_id,operation,revision);
CREATE INDEX auth_withdrawal_changes ON app_changes(workspace_id,target_id,revision)
  WHERE target_type='ACL' AND action IN ('REVOKE','ACCOUNT_REVOKE');
`;

/** Caller owns the same transaction as the epoch increment, audit and ACL change event. */
export function revokeActiveGrants(
  db: DatabaseSync,
  workspace: string,
  actor: string,
  revision: number,
  operation: string | undefined,
  now: number,
) {
  const where =
    "workspace_id=? AND actor_id=? AND revoked_at IS NULL" +
    (operation === undefined ? "" : " AND operation=?");
  const args =
    operation === undefined
      ? [workspace, actor]
      : [workspace, actor, operation];
  db.prepare(
    `INSERT INTO auth_revocations(workspace_id,actor_id,revision,action,requested_operation,grant_count)
    SELECT ?,?,?,'REVOKE',?,COUNT(*) FROM access_grants WHERE ${where}`,
  ).run(workspace, actor, revision, operation ?? null, ...args);
  const snapshot = db
    .prepare(
      `INSERT INTO auth_revoked_grants
    (workspace_id,actor_id,revision,grant_id,operation,room_id,persona_id,provider,visibility)
    SELECT workspace_id,actor_id,?,grant_id,operation,room_id,persona_id,provider,visibility
    FROM access_grants WHERE ${where}`,
    )
    .run(revision, ...args);
  const update = db
    .prepare(`UPDATE access_grants SET revoked_at=? WHERE ${where}`)
    .run(now, ...args);
  if (snapshot.changes !== update.changes)
    throw new Error("ACL_REVOCATION_INTEGRITY");
}

export interface CallSourceGrant {
  operation: string;
  roomId: string;
  personaId?: string;
  visibility?: string;
  provider?: string;
}

/** Historical continuity only. The caller separately checks the source, actor and current grants.
 * A pre-schema-4 change had no grant details. Its actual coverage cannot be reconstructed after regrant.
 */
export function createHistoricalGrantCheck(db: DatabaseSync) {
  const hasDetails = !!db
    .prepare(
      "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='auth_revocations'",
    )
    .get();
  const unproven =
    db.prepare(`SELECT 1 FROM app_changes c WHERE c.workspace_id=? AND c.target_type='ACL'
    AND c.target_id=? AND (c.revision>? OR c.revision IS NULL) AND c.action IN ('REVOKE','ACCOUNT_REVOKE')
    ${
      hasDetails
        ? `AND NOT EXISTS (SELECT 1 FROM auth_revocations e WHERE e.workspace_id=c.workspace_id
      AND e.actor_id=c.target_id AND e.revision=c.revision AND e.action=c.action)`
        : ""
    } LIMIT 1`);
  const incomplete =
    hasDetails &&
    db.prepare(`SELECT 1 FROM auth_revocations e
    WHERE e.workspace_id=? AND e.actor_id=? AND e.revision>? AND (
      e.action='ACCOUNT_REVOKE' OR e.grant_count<>(SELECT COUNT(*) FROM auth_revoked_grants g
        WHERE g.workspace_id=e.workspace_id AND g.actor_id=e.actor_id AND g.revision=e.revision)) LIMIT 1`);
  const overlaps =
    hasDetails &&
    db.prepare(`
    SELECT 1 FROM json_each(?) source JOIN auth_revoked_grants g ON g.operation=source.value->>'$[0]'
    WHERE g.workspace_id=? AND g.actor_id=? AND g.revision>?
    AND (g.room_id='*' OR g.room_id=source.value->>'$[1]')
    AND (g.persona_id='*' OR g.persona_id=source.value->>'$[2]')
    AND (g.visibility='*' OR g.visibility=source.value->>'$[3]')
    AND (g.provider='*' OR g.provider=source.value->>'$[4]')
    AND ((source.value->>'$[5]')=0 OR (g.room_id=source.value->>'$[1]'
      AND g.persona_id=source.value->>'$[2]' AND g.visibility=source.value->>'$[3]')) LIMIT 1`);
  return (
    workspace: string,
    actor: string,
    since: number,
    required: readonly CallSourceGrant[],
  ): boolean => {
    if (
      !Number.isSafeInteger(since) ||
      since < 1 ||
      unproven.get(workspace, actor, since) ||
      (incomplete && incomplete.get(workspace, actor, since))
    )
      return false;
    if (!overlaps) return true;
    const bindings = required.map((g) => [
      g.operation,
      g.roomId,
      g.personaId ?? "",
      g.visibility ?? "",
      g.provider ?? "",
      Number(requiresExactScope(g.operation)),
    ]);
    return !overlaps.get(JSON.stringify(bindings), workspace, actor, since);
  };
}
