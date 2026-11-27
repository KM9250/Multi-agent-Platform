/** Schema 7 metadata. Released migrations 1–6 remain byte-compatible. */
export const CONTEXT_MIGRATION_SCHEMA = `
CREATE TABLE app_restore_context_migration(
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  source_schema INTEGER NOT NULL CHECK(source_schema=6),
  before_digest TEXT NOT NULL,
  after_digest TEXT NOT NULL
) STRICT;
`;
