import assert from "node:assert/strict";
import test, { before } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { AUTH_SCHEMA } from "../server/auth/schema.ts";
import {
  AuthorizationPolicy,
  AuthError,
  secretHash,
} from "../server/auth/authorization.ts";
import {
  SessionService,
  hashPassword,
  verifyPassword,
} from "../server/auth/sessions.ts";

let passwordHash: string;
const password = "synthetic-test-password-32";
before(async () => {
  passwordHash = await hashPassword(password);
});
function fixture(t: any) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(AUTH_SCHEMA);
  db.exec(
    "CREATE TABLE audit(actor TEXT,workspace TEXT,action TEXT,target TEXT) STRICT",
  );
  const app: any = {
    db,
    transaction<T>(fn: () => T): T {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    audit(actor: string, workspace: string, action: string, target: string) {
      db.prepare("INSERT INTO audit VALUES(?,?,?,?)").run(
        actor,
        workspace,
        action,
        target,
      );
    },
  };
  db.prepare("INSERT INTO workspaces VALUES(?,1)").run("workspace");
  db.prepare("INSERT INTO principals VALUES(?,?,1)").run("actor", "workspace");
  db.prepare("INSERT INTO auth_accounts VALUES(?,?,?,1,?)").run(
    "actor",
    "test-user",
    passwordHash,
    Date.now(),
  );
  t.after(() => db.close());
  return { app, db, actor: { actorId: "actor", workspaceId: "workspace" } };
}

test("real scrypt hashing uses random salts and rejects wrong passwords without plaintext persistence", async (t) => {
  assert.match(passwordHash, /^scrypt\$131072\$8\$1\$/);
  assert.equal(await verifyPassword(password, passwordHash), true);
  assert.equal(
    await verifyPassword("incorrect-test-password", passwordHash),
    false,
  );
  assert.equal(await verifyPassword(password, "sha256$not-supported"), false);
  const f = fixture(t),
    sessions = new SessionService(f.app);
  const actor = await sessions.createAccount({
    username: "second-user",
    password,
    workspaceId: "workspace",
    publicGrants: false,
  });
  const row = f.db
    .prepare("SELECT password_hash FROM auth_accounts WHERE actor_id=?")
    .get(actor.actorId)!;
  assert.notEqual(row.password_hash, passwordHash);
  assert.ok(!String(row.password_hash).includes(password));
});

test("sessions are fresh opaque tokens, stored hashed, CSRF protected, and revoked on logout", async (t) => {
  const f = fixture(t),
    sessions = new SessionService(f.app),
    a = await sessions.login("test-user", password),
    b = await sessions.login("test-user", password);
  assert.notEqual(a.token, b.token);
  assert.equal(a.actor.sessionId, secretHash(a.token));
  assert.equal(
    f.db
      .prepare("SELECT count(*) AS n FROM auth_sessions WHERE session_hash=?")
      .get(a.token)!.n,
    0,
  );
  assert.equal(sessions.authenticate(a.token).actor.actorId, "actor");
  sessions.verifyCsrf(a.actor, a.csrfToken);
  assert.throws(() => sessions.verifyCsrf(a.actor, b.csrfToken), {
    code: "CSRF_REJECTED",
  });
  sessions.logout(a.actor);
  assert.throws(() => sessions.authenticate(a.token), {
    code: "UNAUTHENTICATED",
  });
  assert.equal(sessions.authenticate(b.token).actor.actorId, "actor");
});

test("absolute expiry, idle expiry, password change and account revocation invalidate existing sessions", async (t) => {
  const f = fixture(t);
  let now = 1000;
  const sessions = new SessionService(f.app, {
    now: () => now,
    absoluteTimeoutMs: 1000,
    idleTimeoutMs: 200,
  });
  const idle = await sessions.login("test-user", password);
  now += 201;
  assert.throws(() => sessions.authenticate(idle.token), {
    code: "UNAUTHENTICATED",
  });
  const active = await sessions.login("test-user", password);
  for (let i = 0; i < 5; i++) {
    now += 190;
    sessions.authenticate(active.token);
  }
  now += 51;
  assert.throws(() => sessions.authenticate(active.token), {
    code: "UNAUTHENTICATED",
  });
  const reset = await sessions.login("test-user", password);
  await sessions.resetPassword("actor", "changed-synthetic-password");
  assert.throws(() => sessions.authenticate(reset.token), {
    code: "UNAUTHENTICATED",
  });
  const revoked = await sessions.login(
    "test-user",
    "changed-synthetic-password",
  );
  sessions.revokeAccount("actor");
  assert.throws(() => sessions.authenticate(revoked.token), {
    code: "UNAUTHENTICATED",
  });
});

test("authorization distinguishes read, generate, provider and exact private classification; admin grants reveal nothing", (t) => {
  const f = fixture(t),
    policy = new AuthorizationPolicy(f.app),
    scope = { roomId: "room", personaId: "persona" };
  let getterCalls = 0;
  assert.throws(
    () =>
      policy.assert(
        {
          get actorId() {
            getterCalls++;
            return "actor";
          },
          workspaceId: "workspace",
        },
        "READ_ROOM",
        scope,
      ),
    { code: "INVALID_INPUT" },
  );
  assert.equal(getterCalls, 0);
  assert.throws(() => policy.assert(f.actor, "READ_ROOM", scope), {
    code: "FORBIDDEN",
  });
  policy.grant("actor", "workspace", "READ_CONVERSATION", { roomId: "room" });
  policy.grant("actor", "workspace", "BACKUP_DATA");
  assert.throws(() => policy.assert(f.actor, "GENERATE", scope), {
    code: "FORBIDDEN",
  });
  const segment = {
    workspaceId: "workspace",
    roomId: "room",
    ownerPersonaId: "persona",
    channel: "private_state",
    visibility: "self_only",
  };
  assert.equal(policy.canReadSegment(f.actor, segment), false);
  assert.throws(
    () => policy.grant("actor", "workspace", "READ_PRIVATE_SEGMENT"),
    { code: "PRIVATE_GRANT_SCOPE_REQUIRED" },
  );
  policy.grant("actor", "workspace", "READ_PRIVATE_SEGMENT", {
    ...scope,
    visibility: "self_only",
  });
  assert.equal(policy.canReadSegment(f.actor, segment), true);
  assert.equal(
    policy.canReadSegment(f.actor, {
      ...segment,
      visibility: "developer_only",
      channel: "debug_thoughts",
    }),
    false,
  );
  assert.equal(
    policy.canReadSegment(f.actor, { ...segment, roomId: "another-room" }),
    false,
  );
  assert.equal(
    policy.canReadSegment(f.actor, {
      ...segment,
      ownerPersonaId: "another-persona",
    }),
    false,
  );
  assert.equal(
    policy.canReadSegment(f.actor, {
      ...segment,
      visibility: "public",
      channel: "private_state",
    }),
    false,
  );
});

test("current ACL and current session are checked at every invocation and changes are audited atomically", async (t) => {
  const f = fixture(t),
    sessions = new SessionService(f.app),
    session = await sessions.login("test-user", password),
    policy = new AuthorizationPolicy(f.app);
  policy.grant("actor", "workspace", "SEND_TO_PROVIDER", {
    roomId: "room",
    personaId: "persona",
    provider: "google",
  });
  const before = policy.revision(session.actor);
  policy.assert(session.actor, "SEND_TO_PROVIDER", {
    roomId: "room",
    personaId: "persona",
    provider: "google",
  });
  assert.throws(
    () =>
      policy.assert(session.actor, "SEND_TO_PROVIDER", {
        roomId: "room",
        personaId: "persona",
        provider: "attacker",
      }),
    { code: "FORBIDDEN" },
  );
  policy.revoke("actor", "workspace", "SEND_TO_PROVIDER");
  assert.ok(policy.revision(session.actor) > before);
  assert.throws(
    () =>
      policy.assert(session.actor, "SEND_TO_PROVIDER", {
        roomId: "room",
        personaId: "persona",
        provider: "google",
      }),
    { code: "FORBIDDEN" },
  );
  sessions.logout(session.actor);
  assert.throws(() => policy.revision(session.actor), {
    code: "UNAUTHENTICATED",
  });
  const count = f.db.prepare("SELECT count(*) AS n FROM access_grants").get()!
    .n;
  f.app.audit = () => {
    throw new Error("injected audit disk error");
  };
  assert.throws(() => policy.grant("actor", "workspace", "GENERATE"));
  assert.equal(
    f.db.prepare("SELECT count(*) AS n FROM access_grants").get()!.n,
    count,
  );
});

test("login rate limits persist in the DB and oversized inputs never invoke password verification", async (t) => {
  const f = fixture(t),
    sessions = new SessionService(f.app),
    now = Date.now();
  f.db
    .prepare("INSERT INTO auth_login_limits VALUES(?,10,?)")
    .run(secretHash("account:test-user"), now + 60000);
  await assert.rejects(sessions.login("test-user", password), {
    code: "LOGIN_RATE_LIMIT",
  });
  await assert.rejects(sessions.login("test-user", "x".repeat(1025)), {
    code: "INVALID_INPUT",
  });
  assert.equal(
    f.db.prepare("SELECT count(*) AS n FROM auth_sessions").get()!.n,
    0,
  );
});

test("memory grants are opt-in and bind operation, workspace, room, owner and disclosure scope", async (t) => {
  const f = fixture(t);
  const policy = new AuthorizationPolicy(f.app);
  const actor = await new SessionService(f.app).createAccount({
    username: "memory-reader",
    workspaceId: "workspace",
    password,
  });
  const scope = {
    roomId: "r",
    personaId: "alice",
    visibility: "persona_private",
  };
  for (const operation of [
    "READ_MEMORY",
    "PROPOSE_MEMORY",
    "EDIT_MEMORY",
    "REVIEW_MEMORY",
    "PUBLISH_MEMORY",
    "CHANGE_MEMORY_SCOPE",
    "RETRACT_MEMORY",
    "MANAGE_VAULT",
  ])
    assert.equal(policy.can(actor, operation, scope), false);
  assert.equal(policy.can(actor, "READ_CONVERSATION", scope), true);
  for (const invalid of [
    {},
    { ...scope, personaId: "*" },
    { ...scope, roomId: "*" },
    { ...scope, visibility: "*" },
  ])
    assert.throws(
      () =>
        policy.grant(actor.actorId, actor.workspaceId, "READ_MEMORY", invalid),
      { code: "MEMORY_GRANT_SCOPE_REQUIRED" },
    );
  policy.grant(actor.actorId, actor.workspaceId, "READ_MEMORY", scope);
  assert.equal(policy.can(actor, "READ_MEMORY", scope), true);
  for (const other of [
    { ...scope, roomId: "r2" },
    { ...scope, personaId: "bob" },
    { ...scope, visibility: "room_shared" },
    { ...scope, workspaceId: "other" },
  ])
    assert.equal(policy.can(actor, "READ_MEMORY", other), false);
  assert.equal(
    policy.can(actor, "READ_PRIVATE_SEGMENT", {
      ...scope,
      visibility: "self_only",
    }),
    false,
  );
  policy.grant(actor.actorId, actor.workspaceId, "MANAGE_VAULT");
  assert.equal(policy.can(actor, "MANAGE_VAULT"), true);
  assert.equal(policy.can(actor, "PUBLISH_MEMORY", scope), false);
  assert.equal(policy.can(actor, "REVIEW_MEMORY", scope), false);
  policy.revoke(actor.actorId, actor.workspaceId, "READ_MEMORY");
  assert.equal(policy.can(actor, "READ_MEMORY", scope), false);
});
