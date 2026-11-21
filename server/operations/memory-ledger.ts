import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/** A stable digest of the JSON array of rows, without retaining its contents. */
export function summarizeRows(rows: Iterable<unknown>) {
  const hash = createHash("sha256").update("[");
  let count = 0;
  for (const row of rows) {
    if (count++) hash.update(",");
    hash.update(JSON.stringify(row));
  }
  return { count, digest: hash.update("]").digest("hex") };
}

/** Keep the released MEM-1 ledger definition byte-compatible for legacy restore reports.
 * Used offline on an immutable snapshot or inside the migration's writer transaction. */
export function memoryRecordsDigest(db: DatabaseSync): string {
  const parts: Record<string, string> = {
    vaultTrust: summarizeRows(
      db
        .prepare(
          "SELECT singleton,trust_new FROM memory_vault ORDER BY singleton",
        )
        .iterate(),
    ).digest,
  };
  for (const { name: table } of db
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name GLOB 'memory_*' AND name<>'memory_vault' ORDER BY name",
    )
    .iterate()) {
    const name = String(table);
    if (!/^memory_[a-z_]+$/.test(name))
      throw new Error("BACKUP_SCHEMA_INVALID");
    const keys = db
      .prepare("SELECT name FROM pragma_table_info(?) WHERE pk>0 ORDER BY pk")
      .all(name);
    const order = keys
      .map((key) => '"' + String(key.name).replaceAll('"', '""') + '"')
      .join(",");
    parts[name] = summarizeRows(
      db
        .prepare(`SELECT * FROM ${name} ORDER BY ${order || "rowid"}`)
        .iterate(),
    ).digest;
  }
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}
