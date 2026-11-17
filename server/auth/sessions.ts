import { randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { AppDatabase } from "../app-data/db.ts";
import {
  AuthError,
  AuthorizationPolicy,
  PUBLIC_USER_OPERATIONS,
  secretHash,
  type Actor,
} from "./authorization.ts";

const scryptAsync = promisify(scrypt);
// OWASP scrypt minimum: 128*N*r = 128 MiB, p=1. At most two hashes in flight.
const SCRYPT = { N: 131072, r: 8, p: 1, maxmem: 144 * 1024 * 1024 };
let hashing = 0;
async function derive(password: string, salt: Buffer): Promise<Buffer> {
  if (hashing >= 2) throw new AuthError("AUTH_BUSY", 429);
  hashing++;
  try {
    return await (scryptAsync as any)(password, salt, 64, SCRYPT);
  } finally {
    hashing--;
  }
}
function passwordInput(password: string): void {
  if (
    typeof password !== "string" ||
    Buffer.byteLength(password) < 12 ||
    Buffer.byteLength(password) > 1024
  )
    throw new AuthError("PASSWORD_LENGTH", 400);
}
export async function hashPassword(password: string): Promise<string> {
  passwordInput(password);
  const salt = randomBytes(16),
    result = await derive(password, salt);
  return `scrypt$131072$8$1$${salt.toString("hex")}$${result.toString("hex")}`;
}
export async function verifyPassword(
  password: string,
  encoded: string,
): Promise<boolean> {
  if (typeof password !== "string" || Buffer.byteLength(password) > 1024)
    return false;
  const parts = encoded.split("$");
  if (
    parts.length !== 6 ||
    parts.slice(0, 4).join("$") !== "scrypt$131072$8$1" ||
    !/^[a-f0-9]{32}$/.test(parts[4]) ||
    !/^[a-f0-9]{128}$/.test(parts[5])
  )
    return false;
  const actual = await derive(password, Buffer.from(parts[4], "hex"));
  return timingSafeEqual(actual, Buffer.from(parts[5], "hex"));
}
export interface SessionOptions {
  absoluteTimeoutMs?: number;
  idleTimeoutMs?: number;
  now?: () => number;
}
export interface SessionResult {
  actor: Actor;
  token: string;
  csrfToken: string;
  expiresAt: number;
}

export class SessionService {
  readonly absoluteTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly now: () => number;
  constructor(
    readonly app: AppDatabase,
    options: SessionOptions = {},
  ) {
    this.absoluteTimeoutMs = options.absoluteTimeoutMs ?? 12 * 60 * 60_000;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 30 * 60_000;
    this.now = options.now ?? (() => Date.now());
    if (
      !(
        this.absoluteTimeoutMs > 0 &&
        this.absoluteTimeoutMs <= 7 * 86400_000 &&
        this.idleTimeoutMs > 0 &&
        this.idleTimeoutMs <= this.absoluteTimeoutMs
      )
    )
      throw new AuthError("INVALID_CONFIGURATION", 500);
  }

  async createAccount(input: {
    username: string;
    password: string;
    workspaceId?: string;
    actorId?: string;
    publicGrants?: boolean;
  }): Promise<Actor> {
    if (
      typeof input.username !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_.@-]{2,79}$/.test(input.username)
    )
      throw new AuthError("INVALID_USERNAME", 400);
    const username = input.username.toLowerCase(),
      passwordHash = await hashPassword(input.password);
    const actor = {
      actorId: input.actorId ?? randomUUID(),
      workspaceId: input.workspaceId ?? randomUUID(),
    };
    this.app.transaction(() => {
      this.app.db
        .prepare(
          "INSERT OR IGNORE INTO workspaces(workspace_id,acl_revision) VALUES(?,1)",
        )
        .run(actor.workspaceId);
      this.app.db
        .prepare(
          "INSERT INTO principals(actor_id,workspace_id,active) VALUES(?,?,1)",
        )
        .run(actor.actorId, actor.workspaceId);
      this.app.db
        .prepare(
          "INSERT INTO auth_accounts(actor_id,username,password_hash,created_at) VALUES(?,?,?,?)",
        )
        .run(actor.actorId, username, passwordHash, this.now());
      if (input.publicGrants !== false)
        for (const operation of PUBLIC_USER_OPERATIONS)
          this.app.db
            .prepare(
              "INSERT INTO access_grants(grant_id,workspace_id,actor_id,operation) VALUES(?,?,?,?)",
            )
            .run(randomUUID(), actor.workspaceId, actor.actorId, operation);
      this.app.db
        .prepare(
          "UPDATE workspaces SET acl_revision=acl_revision+1 WHERE workspace_id=?",
        )
        .run(actor.workspaceId);
      this.app.audit(
        actor.actorId,
        actor.workspaceId,
        "ACCOUNT_CREATED",
        actor.actorId,
      );
      this.app.change?.(
        actor.workspaceId,
        null,
        "ACL",
        actor.actorId,
        Number(
          this.app.db
            .prepare("SELECT acl_revision FROM workspaces WHERE workspace_id=?")
            .get(actor.workspaceId)!.acl_revision,
        ),
        "ACCOUNT_CREATE",
      );
    });
    return actor;
  }

  private attempt(username: string, clientAddress: string): void {
    const now = this.now();
    this.app.transaction(() => {
      // One bucket per account and one per network address prevents account spraying.
      for (const key of [`account:${username}`, `address:${clientAddress}`]) {
        const hash = secretHash(key),
          row = this.app.db
            .prepare(
              "SELECT attempts,reset_at FROM auth_login_limits WHERE key_hash=?",
            )
            .get(hash);
        if (row && Number(row.reset_at) > now && Number(row.attempts) >= 10)
          throw new AuthError("LOGIN_RATE_LIMIT", 429);
        this.app.db
          .prepare(
            `INSERT INTO auth_login_limits(key_hash,attempts,reset_at) VALUES(?,1,?)
          ON CONFLICT(key_hash) DO UPDATE SET attempts=CASE WHEN reset_at<=? THEN 1 ELSE attempts+1 END,
          reset_at=CASE WHEN reset_at<=? THEN excluded.reset_at ELSE reset_at END`,
          )
          .run(hash, now + 15 * 60_000, now, now);
      }
      this.app.db
        .prepare("DELETE FROM auth_login_limits WHERE reset_at<?")
        .run(now - 86400_000);
    });
  }

  async login(
    username: string,
    password: string,
    clientAddress = "local",
  ): Promise<SessionResult> {
    if (
      typeof username !== "string" ||
      username.length > 80 ||
      typeof password !== "string" ||
      Buffer.byteLength(password) > 1024
    )
      throw new AuthError("INVALID_INPUT", 400);
    username = username.toLowerCase();
    this.attempt(username, clientAddress);
    const account = this.app.db
      .prepare(
        `SELECT a.*,p.workspace_id,p.active FROM auth_accounts a JOIN principals p ON p.actor_id=a.actor_id WHERE username=?`,
      )
      .get(username);
    // The same KDF is performed for unknown accounts, without registering a default password.
    const dummy =
      "scrypt$131072$8$1$" + "00".repeat(16) + "$" + "00".repeat(64);
    const correct = await verifyPassword(
      password,
      String(account?.password_hash ?? dummy),
    );
    if (!account || account.active !== 1 || !correct)
      throw new AuthError("LOGIN_FAILED", 401);
    const token = randomBytes(32).toString("base64url"),
      sessionId = secretHash(token),
      csrfToken = secretHash(`csrf:${token}`),
      now = this.now();
    const actor = {
      actorId: String(account.actor_id),
      workspaceId: String(account.workspace_id),
      sessionId,
    };
    this.app.transaction(() => {
      const current = this.app.db
        .prepare(
          `SELECT a.credential_revision,p.active FROM auth_accounts a JOIN principals p ON p.actor_id=a.actor_id WHERE a.actor_id=?`,
        )
        .get(actor.actorId);
      if (
        !current ||
        current.active !== 1 ||
        current.credential_revision !== account.credential_revision
      )
        throw new AuthError("LOGIN_FAILED", 401);
      this.app.db
        .prepare(
          `INSERT INTO auth_sessions(session_hash,actor_id,csrf_hash,credential_revision,created_at,expires_at,last_seen_at)
        VALUES(?,?,?,?,?,?,?)`,
        )
        .run(
          sessionId,
          actor.actorId,
          secretHash(csrfToken),
          account.credential_revision,
          now,
          now + this.absoluteTimeoutMs,
          now,
        );
      this.app.audit(
        actor.actorId,
        actor.workspaceId,
        "SESSION_CREATED",
        actor.actorId,
      );
    });
    return { actor, token, csrfToken, expiresAt: now + this.absoluteTimeoutMs };
  }

  authenticate(
    token: string | undefined,
    touch = true,
  ): { actor: Actor; csrfToken: string; expiresAt: number } {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new AuthError("UNAUTHENTICATED", 401);
    const sessionId = secretHash(token),
      now = this.now();
    const row = this.app.db
      .prepare(
        `SELECT s.*,p.workspace_id,p.active,a.credential_revision AS current_revision
      FROM auth_sessions s JOIN principals p ON p.actor_id=s.actor_id JOIN auth_accounts a ON a.actor_id=s.actor_id WHERE session_hash=?`,
      )
      .get(sessionId);
    if (
      !row ||
      row.active !== 1 ||
      row.revoked_at !== null ||
      row.credential_revision !== row.current_revision ||
      Number(row.expires_at) <= now ||
      Number(row.last_seen_at) + this.idleTimeoutMs <= now
    )
      throw new AuthError("UNAUTHENTICATED", 401);
    if (touch)
      this.app.db
        .prepare(
          "UPDATE auth_sessions SET last_seen_at=? WHERE session_hash=? AND revoked_at IS NULL",
        )
        .run(now, sessionId);
    return {
      actor: {
        actorId: String(row.actor_id),
        workspaceId: String(row.workspace_id),
        sessionId,
      },
      csrfToken: secretHash(`csrf:${token}`),
      expiresAt: Number(row.expires_at),
    };
  }

  verifyCsrf(actor: Actor, token: string | undefined): void {
    if (!token || !/^[a-f0-9]{64}$/.test(token) || !actor.sessionId)
      throw new AuthError("CSRF_REJECTED", 403);
    const row = this.app.db
      .prepare(
        "SELECT csrf_hash FROM auth_sessions WHERE session_hash=? AND revoked_at IS NULL",
      )
      .get(actor.sessionId);
    if (
      !row ||
      !timingSafeEqual(
        Buffer.from(String(row.csrf_hash), "hex"),
        Buffer.from(secretHash(token), "hex"),
      )
    )
      throw new AuthError("CSRF_REJECTED", 403);
  }

  logout(actor: Actor): void {
    this.app.transaction(() => {
      this.app.db
        .prepare(
          "UPDATE auth_sessions SET revoked_at=? WHERE session_hash=? AND actor_id=?",
        )
        .run(this.now(), actor.sessionId ?? "", actor.actorId);
      this.app.audit(
        actor.actorId,
        actor.workspaceId,
        "SESSION_REVOKED",
        actor.actorId,
      );
    });
  }

  revokeAccount(actorId: string): void {
    this.app.transaction(() => {
      const p = this.app.db
        .prepare("SELECT workspace_id FROM principals WHERE actor_id=?")
        .get(actorId);
      if (!p) throw new AuthError("NOT_FOUND", 404);
      this.app.db
        .prepare("UPDATE principals SET active=0 WHERE actor_id=?")
        .run(actorId);
      this.app.db
        .prepare("UPDATE auth_sessions SET revoked_at=? WHERE actor_id=?")
        .run(this.now(), actorId);
      this.app.db
        .prepare(
          "UPDATE workspaces SET acl_revision=acl_revision+1 WHERE workspace_id=?",
        )
        .run(p.workspace_id);
      this.app.audit(
        actorId,
        String(p.workspace_id),
        "ACCOUNT_REVOKED",
        actorId,
      );
      this.app.change?.(
        String(p.workspace_id),
        null,
        "ACL",
        actorId,
        Number(
          this.app.db
            .prepare("SELECT acl_revision FROM workspaces WHERE workspace_id=?")
            .get(p.workspace_id)!.acl_revision,
        ),
        "ACCOUNT_REVOKE",
      );
    });
  }

  async resetPassword(actorId: string, password: string): Promise<void> {
    const hash = await hashPassword(password);
    const transaction =
      this.app.maintenanceTransaction?.bind(this.app) ??
      this.app.transaction.bind(this.app);
    transaction(() => {
      const p = this.app.db
        .prepare("SELECT workspace_id FROM principals WHERE actor_id=?")
        .get(actorId);
      if (!p) throw new AuthError("NOT_FOUND", 404);
      this.app.db
        .prepare(
          "UPDATE auth_accounts SET password_hash=?,credential_revision=credential_revision+1 WHERE actor_id=?",
        )
        .run(hash, actorId);
      this.app.db
        .prepare("UPDATE auth_sessions SET revoked_at=? WHERE actor_id=?")
        .run(this.now(), actorId);
      this.app.audit(
        actorId,
        String(p.workspace_id),
        "PASSWORD_RESET",
        actorId,
      );
    });
  }
}
