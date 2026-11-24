// Account creation and DATA-1 migrations must never implicitly grant future capabilities.
export const PUBLIC_USER_OPERATIONS = [
  "READ_ROOM",
  "READ_CONVERSATION",
  "WRITE_MESSAGE",
  "EDIT_ROOM",
  "EDIT_PERSONA",
  "GENERATE",
  "CANCEL_GENERATION",
  "SEND_TO_PROVIDER",
  "UPLOAD_ATTACHMENT",
  "READ_ATTACHMENT",
  "IMPORT_DATA",
  "EXPORT_DATA",
] as const;
export const SCOPED_MEMORY_OPERATIONS: ReadonlySet<string> = new Set([
  "READ_MEMORY",
  "PROPOSE_MEMORY",
  "EDIT_MEMORY",
  "REVIEW_MEMORY",
  "PUBLISH_MEMORY",
  "CHANGE_MEMORY_SCOPE",
  "RETRACT_MEMORY",
]);
export const APP_OPERATIONS = [
  ...PUBLIC_USER_OPERATIONS,
  "READ_PRIVATE_SEGMENT",
  "BACKUP_DATA",
  "RESTORE_BACKUP",
  ...SCOPED_MEMORY_OPERATIONS,
  "MANAGE_VAULT",
];
export function requiresExactScope(operation: string): boolean {
  return (
    operation === "READ_PRIVATE_SEGMENT" ||
    SCOPED_MEMORY_OPERATIONS.has(operation)
  );
}
