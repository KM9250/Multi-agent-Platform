import { createHash, randomUUID } from "node:crypto";
import type { AppDatabase } from "../app-data/db.ts";

export interface Actor {
  actorId: string;
  workspaceId: string;
  sessionId?: string;
}
export interface ResourceScope {
  workspaceId?: string;
  roomId?: string;
  personaId?: string;
  provider?: string;
  visibility?: string;
}
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
const SCOPED_MEMORY_OPERATIONS: ReadonlySet<string> = new Set([
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
function hasMemoryScope(scope: ResourceScope): boolean {
  return (
    typeof scope.roomId === "string" &&
    !!scope.roomId &&
    scope.roomId !== "*" &&
    typeof scope.personaId === "string" &&
    !!scope.personaId &&
    scope.personaId !== "*" &&
    (scope.visibility === "persona_private" ||
      scope.visibility === "room_shared")
  );
}
export class AuthError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code = "FORBIDDEN", status = 403) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
export const secretHash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
function plainStrings(value: unknown, keys: string[]): void {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new AuthError("INVALID_INPUT", 400);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !keys.includes(key) ||
      !descriptor ||
      !("value" in descriptor) ||
      (descriptor.value !== undefined && typeof descriptor.value !== "string")
    )
      throw new AuthError("INVALID_INPUT", 400);
  }
}

/** Grants are operation-specific. Administration never implies private content access. */
export class AuthorizationPolicy {
  constructor(
    readonly app: AppDatabase,
    readonly idleTimeoutMs = 30 * 60_000,
    readonly now = () => Date.now(),
  ) {}

  private current(actor: Actor): void {
    plainStrings(actor, ["actorId", "workspaceId", "sessionId"]);
    if (
      !actor ||
      typeof actor.actorId !== "string" ||
      typeof actor.workspaceId !== "string"
    )
      throw new AuthError();
    const principal = this.app.db
      .prepare(
        "SELECT active FROM principals WHERE workspace_id=? AND actor_id=?",
      )
      .get(actor.workspaceId, actor.actorId);
    if (!principal || principal.active !== 1)
      throw new AuthError("UNAUTHENTICATED", 401);
    if (actor.sessionId) {
      const row = this.app.db
        .prepare(
          `SELECT s.* FROM auth_sessions s JOIN auth_accounts a ON a.actor_id=s.actor_id
        WHERE s.session_hash=? AND s.actor_id=? AND s.revoked_at IS NULL AND s.credential_revision=a.credential_revision`,
        )
        .get(actor.sessionId, actor.actorId);
      const now = this.now();
      if (
        !row ||
        Number(row.expires_at) <= now ||
        Number(row.last_seen_at) + this.idleTimeoutMs <= now
      )
        throw new AuthError("UNAUTHENTICATED", 401);
    }
  }

  revision(actor: Actor, workspaceId = actor.workspaceId): number {
    this.current(actor);
    if (workspaceId !== actor.workspaceId) throw new AuthError();
    return Number(
      this.app.db
        .prepare("SELECT acl_revision FROM workspaces WHERE workspace_id=?")
        .get(workspaceId)?.acl_revision,
    );
  }

  assert(actor: Actor, operation: string, scope: ResourceScope = {}): void {
    this.current(actor);
    plainStrings(scope, [
      "workspaceId",
      "roomId",
      "personaId",
      "provider",
      "visibility",
    ]);
    if (
      !APP_OPERATIONS.includes(operation as any) ||
      (scope.workspaceId && scope.workspaceId !== actor.workspaceId)
    )
      throw new AuthError();
    const privateRead = operation === "READ_PRIVATE_SEGMENT";
    if (privateRead && (!scope.personaId || !scope.visibility || !scope.roomId))
      throw new AuthError();
    const memoryOperation = SCOPED_MEMORY_OPERATIONS.has(operation);
    if (memoryOperation && !hasMemoryScope(scope)) throw new AuthError();
    const exactScope = privateRead || memoryOperation;
    const row = this.app.db
      .prepare(
        `SELECT 1 FROM access_grants WHERE workspace_id=? AND actor_id=? AND operation=? AND revoked_at IS NULL
      AND ${exactScope ? "room_id=? AND persona_id=? AND visibility=?" : "(room_id='*' OR room_id=?) AND (persona_id='*' OR persona_id=?) AND (visibility='*' OR visibility=?)"}
      AND (provider='*' OR provider=?) LIMIT 1`,
      )
      .get(
        actor.workspaceId,
        actor.actorId,
        operation,
        scope.roomId ?? "",
        scope.personaId ?? "",
        scope.visibility ?? "",
        scope.provider ?? "",
      );
    if (!row) throw new AuthError();
  }

  can(actor: Actor, operation: string, scope: ResourceScope = {}): boolean {
    try {
      this.assert(actor, operation, scope);
      return true;
    } catch {
      return false;
    }
  }

  canReadSegment(actor: Actor, segment: Record<string, any>): boolean {
    const scope = {
      workspaceId: segment.workspaceId ?? segment.workspace_id,
      roomId: segment.roomId ?? segment.room_id,
      personaId:
        segment.ownerPersonaId ??
        segment.owner_persona_id ??
        segment.personaId ??
        segment.persona_id,
      visibility: segment.visibility,
    };
    if (
      !scope.workspaceId ||
      !scope.roomId ||
      !this.can(actor, "READ_CONVERSATION", scope)
    )
      return false;
    if (
      segment.visibility === "public" &&
      ["public_message", "shared_summary"].includes(segment.channel)
    )
      return true;
    // Every private classification requires an explicit owner-scoped content grant.
    // Persona ownership and GM/developer UI flags do not confer one.
    return !!scope.personaId && this.can(actor, "READ_PRIVATE_SEGMENT", scope);
  }

  /** Host CLI only; never exposed as a general grant-management HTTP endpoint. */
  grant(
    actorId: string,
    workspaceId: string,
    operation: string,
    scope: ResourceScope = {},
  ): void {
    if (
      !APP_OPERATIONS.includes(operation as any) ||
      (scope.workspaceId && scope.workspaceId !== workspaceId)
    )
      throw new AuthError("INVALID_INPUT", 400);
    if (SCOPED_MEMORY_OPERATIONS.has(operation) && !hasMemoryScope(scope))
      throw new AuthError("MEMORY_GRANT_SCOPE_REQUIRED", 400);
    if (
      operation === "MANAGE_VAULT" &&
      (scope.roomId || scope.personaId || scope.visibility || scope.provider)
    )
      throw new AuthError("INVALID_INPUT", 400);
    if (
      operation === "READ_PRIVATE_SEGMENT" &&
      (!scope.roomId ||
        !scope.personaId ||
        !["self_only", "self_and_gm", "gm_only", "developer_only"].includes(
          scope.visibility ?? "",
        ) ||
        [scope.roomId, scope.personaId].includes("*"))
    )
      throw new AuthError("PRIVATE_GRANT_SCOPE_REQUIRED", 400);
    this.app.transaction(() => {
      this.app.db
        .prepare(
          `INSERT INTO access_grants(grant_id,workspace_id,actor_id,operation,room_id,persona_id,provider,visibility)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,actor_id,operation,room_id,persona_id,provider,visibility) DO UPDATE SET revoked_at=NULL`,
        )
        .run(
          randomUUID(),
          workspaceId,
          actorId,
          operation,
          scope.roomId ?? "*",
          scope.personaId ?? "*",
          scope.provider ?? "*",
          scope.visibility ?? "*",
        );
      this.app.db
        .prepare(
          "UPDATE workspaces SET acl_revision=acl_revision+1 WHERE workspace_id=?",
        )
        .run(workspaceId);
      this.app.audit(actorId, workspaceId, "ACL_GRANT", operation);
      this.app.change?.(
        workspaceId,
        scope.roomId ?? null,
        "ACL",
        actorId,
        Number(
          this.app.db
            .prepare("SELECT acl_revision FROM workspaces WHERE workspace_id=?")
            .get(workspaceId)!.acl_revision,
        ),
        "GRANT",
      );
    });
  }

  revoke(actorId: string, workspaceId: string, operation?: string): void {
    this.app.transaction(() => {
      const sql = `UPDATE access_grants SET revoked_at=? WHERE workspace_id=? AND actor_id=?${operation ? " AND operation=?" : ""}`;
      this.app.db
        .prepare(sql)
        .run(
          ...[
            this.now(),
            workspaceId,
            actorId,
            ...(operation ? [operation] : []),
          ],
        );
      this.app.db
        .prepare(
          "UPDATE workspaces SET acl_revision=acl_revision+1 WHERE workspace_id=?",
        )
        .run(workspaceId);
      this.app.audit(actorId, workspaceId, "ACL_REVOKE", operation ?? "ALL");
      this.app.change?.(
        workspaceId,
        null,
        "ACL",
        actorId,
        Number(
          this.app.db
            .prepare("SELECT acl_revision FROM workspaces WHERE workspace_id=?")
            .get(workspaceId)!.acl_revision,
        ),
        "REVOKE",
      );
    });
  }
}
