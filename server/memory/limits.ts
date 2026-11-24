import { AppError } from "../../shared/app-contracts/index.ts";
import type { AppDatabase } from "../app-data/db.ts";

export const MAX_LIVE_NOTES = 1024;
export const MAX_INVENTORY_ENTRIES = 4096;
export const LIVE_NOTE_PREDICATE = "state NOT IN ('RETRACTED','NEEDS_REVIEW')";

/** Call under the same SQLite writer as registration or preparation, so other writers see the slot. */
export function assertPublicationCapacity(
  app: AppDatabase,
  operationId = "",
): void {
  const full = app.db
    .prepare(
      `
    SELECT 1 FROM (
      SELECT note_id FROM memory_documents WHERE ${LIVE_NOTE_PREDICATE}
      UNION ALL
      SELECT note_id FROM memory_jobs WHERE status='PUBLISHING' AND operation_id<>?
    ) LIMIT 1 OFFSET ?
  `,
    )
    .get(operationId, MAX_LIVE_NOTES - 1);
  if (full) throw new AppError("VAULT_NOTE_CAPACITY", 409);
}
