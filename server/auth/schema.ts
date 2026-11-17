/** Application identity lives exclusively in app-data.sqlite, schema 1. */
export const AUTH_SCHEMA = `
CREATE TABLE workspaces (
  workspace_id TEXT PRIMARY KEY,
  acl_revision INTEGER NOT NULL DEFAULT 1 CHECK (acl_revision > 0)
) STRICT;
CREATE TABLE principals (
  actor_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  UNIQUE(workspace_id,actor_id)
) STRICT;
CREATE TABLE auth_accounts (
  actor_id TEXT PRIMARY KEY REFERENCES principals(actor_id),
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  credential_revision INTEGER NOT NULL DEFAULT 1 CHECK (credential_revision > 0),
  created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE auth_sessions (
  session_hash TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES principals(actor_id),
  csrf_hash TEXT NOT NULL,
  credential_revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER
) STRICT;
CREATE INDEX auth_sessions_actor ON auth_sessions(actor_id);
CREATE TABLE access_grants (
  grant_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  room_id TEXT NOT NULL DEFAULT '*',
  persona_id TEXT NOT NULL DEFAULT '*',
  provider TEXT NOT NULL DEFAULT '*',
  visibility TEXT NOT NULL DEFAULT '*',
  revoked_at INTEGER,
  FOREIGN KEY(workspace_id,actor_id) REFERENCES principals(workspace_id,actor_id),
  UNIQUE(workspace_id,actor_id,operation,room_id,persona_id,provider,visibility)
) STRICT;
CREATE INDEX access_grants_scope ON access_grants(workspace_id,actor_id,operation,room_id,persona_id,provider);
CREATE TABLE auth_login_limits (
  key_hash TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
) STRICT;
`;
