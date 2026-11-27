import { AppError } from "../../shared/app-contracts/index.ts";

/** Unavailable evidence is retryable; it is not proof that an approval has expired. */
export class NoteVerificationPending extends AppError {
  // readNote preserves its public unavailable code, while internal consumers
  // retain the retryable type instead of treating it as a confirmed removal.
  constructor(code: "NOTE_VERIFICATION_PENDING" | "MEMORY_UNAVAILABLE" = "NOTE_VERIFICATION_PENDING") { super(code, 409); }
}

/** The registered root could not be opened; no individual Note was observed missing. */
export class VaultRootUnavailable extends NoteVerificationPending {}

type InventoryPath = (row: Record<string, any>) => string;
const inventories = new WeakMap<object, InventoryPath>();

/** Only the scanner's synchronous reconciliation can use its complete inventory.
 * Normal readers still see incomplete=1 until every reconciliation has finished. */
export function withCompleteNoteInventory<T>(app: object, path: InventoryPath, callback: () => T): T {
  const previous = inventories.get(app);
  inventories.set(app, path);
  try { return callback(); }
  finally { if (previous) inventories.set(app, previous); else inventories.delete(app); }
}
export function inventoryNotePath(app: object, row: Record<string, any>): string | undefined {
  return inventories.get(app)?.(row);
}
