import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { AppDatabase } from "../server/app-data/db.ts";
import { AuthorizationPolicy } from "../server/auth/authorization.ts";
import { checkValue, object } from "../server/app-data/validation.ts";
import { appFixture } from "./app-data-fixture.ts";
import { GenerationCoordinator } from "../server/generation/coordinator.ts";
import { FakeProvider } from "../server/generation/provider.ts";

function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), "map-redteam-"));
  chmodSync(root, 0o700);
  const app = new AppDatabase({ root });
  t.after(() => {
    app.close();
    rmSync(root, { recursive: true, force: true });
  });
  app.db.exec(
    "INSERT INTO workspaces VALUES('w',1),('other',1); INSERT INTO principals VALUES('a','w',1),('b','w',1),('c','other',1)",
  );
  return {
    app,
    policy: new AuthorizationPolicy(app),
    actor: { actorId: "a", workspaceId: "w" },
  };
}

test("RT-DATA-02/12: closed input rejects authority fields, prototypes and getters without evaluating them", () => {
  let invoked = 0;
  const getter = Object.defineProperty({}, "content", {
    enumerable: true,
    get() {
      invoked++;
      return "private";
    },
  });
  for (const value of [
    getter,
    Object.assign(Object.create({ isAdmin: true }), { content: "x" }),
    JSON.parse('{"__proto__":{"isAdmin":true}}'),
    { content: "x", role: "admin" },
    { content: "x", owner: "victim" },
    { content: "x", privateContext: "secret" },
  ]) {
    assert.throws(() => object(value, ["content"]));
  }
  assert.equal(invoked, 0);
  let deep: any = {};
  for (let i = 0; i < 40; i++) deep = { next: deep };
  assert.throws(() => checkValue(deep));
  assert.throws(() => checkValue({ n: Infinity }));
  assert.throws(() => checkValue({ call: () => true }));
});

test("RT-DATA-01/10/15: administration and known identifiers do not grant private content", (t) => {
  const { app, policy, actor } = fixture(t);
  for (const operation of [
    "READ_CONVERSATION",
    "EDIT_ROOM",
    "EDIT_PERSONA",
    "BACKUP_DATA",
    "RESTORE_BACKUP",
  ])
    policy.grant("a", "w", operation, { roomId: "r" });
  const segment = {
    workspaceId: "w",
    roomId: "r",
    ownerPersonaId: "p",
    channel: "private_state",
    visibility: "self_only",
  };
  assert.equal(policy.canReadSegment(actor, segment), false);
  assert.throws(() => policy.grant("a", "w", "READ_PRIVATE_SEGMENT"));
  policy.grant("a", "w", "READ_PRIVATE_SEGMENT", {
    roomId: "r",
    personaId: "p",
    visibility: "self_only",
  });
  assert.equal(policy.canReadSegment(actor, segment), true);
  for (const changed of [
    { roomId: "other" },
    { workspaceId: "other" },
    { ownerPersonaId: "other" },
    { visibility: "gm_only" },
    { visibility: "developer_only" },
  ])
    assert.equal(
      policy.canReadSegment(actor, { ...segment, ...changed }),
      false,
    );
  assert.equal(
    policy.canReadSegment({ actorId: "b", workspaceId: "w" }, segment),
    false,
  );
  const before = app.db
    .prepare("SELECT count(*) AS n FROM app_audit_events")
    .get()!.n;
  assert.throws(() => policy.assert(actor, "GENERATE", { roomId: "r" }));
  assert.throws(() =>
    policy.assert({ ...actor, workspaceId: "other" }, "READ_CONVERSATION", {
      roomId: "r",
    }),
  );
  assert.equal(
    app.db.prepare("SELECT count(*) AS n FROM app_audit_events").get()!.n,
    before,
  );
  policy.revoke("a", "w", "READ_PRIVATE_SEGMENT");
  assert.equal(policy.canReadSegment(actor, segment), false);
});

test("C1-07: caught nested failure poisons outer transaction; audit failure cannot commit business prefix", (t) => {
  const { app } = fixture(t);
  assert.throws(() =>
    app.transaction(() => {
      app.db
        .prepare("UPDATE workspaces SET acl_revision=9 WHERE workspace_id='w'")
        .run();
      try {
        app.transaction(() => {
          throw new Error("synthetic failure");
        });
      } catch {}
      app.audit("a", "w", "TEST", "target");
    }),
  );
  assert.equal(
    app.db
      .prepare("SELECT acl_revision FROM workspaces WHERE workspace_id='w'")
      .get()!.acl_revision,
    1,
  );
  assert.equal(
    app.db.prepare("SELECT count(*) AS n FROM app_audit_events").get()!.n,
    0,
  );
  app.db.exec(
    "CREATE TRIGGER reject_audit BEFORE INSERT ON app_audit_events BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END",
  );
  assert.throws(() =>
    app.transaction(() => {
      app.db
        .prepare("UPDATE workspaces SET acl_revision=10 WHERE workspace_id='w'")
        .run();
      app.audit("a", "w", "TEST", "target");
    }),
  );
  assert.equal(
    app.db
      .prepare("SELECT acl_revision FROM workspaces WHERE workspace_id='w'")
      .get()!.acl_revision,
    1,
  );
});

test("C1-08: wrong database is refused without changing bytes or adding application tables", (t) => {
  const root = mkdtempSync(join(tmpdir(), "map-wrong-db-"));
  chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "app-data.sqlite");
  const original = new DatabaseSync(path);
  original.exec(
    "CREATE TABLE coordination_migrations(version INTEGER PRIMARY KEY); INSERT INTO coordination_migrations VALUES(11)",
  );
  original.close();
  const before = readFileSync(path);
  assert.throws(() => new AppDatabase({ root }), /WRONG_DATABASE/);
  assert.deepEqual(readFileSync(path), before);
  const probe = new DatabaseSync(path, { readOnly: true });
  assert.equal(
    probe
      .prepare(
        "SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'app_%'",
      )
      .get()!.n,
    0,
  );
  probe.close();
});

test("C1-07: actual SQLite BUSY and FULL preserve messages, revisions, room sequence and audit", (t) => {
  const f = appFixture();
  t.after(() => f.dispose());
  const snapshot = () => ({
    counts: [
      "messages",
      "message_revisions",
      "message_segments",
      "app_audit_events",
    ].map(
      (table) =>
        f.app.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n,
    ),
    sequence: f.app.db
      .prepare("SELECT next_seq FROM rooms WHERE workspace_id=? AND room_id=?")
      .get(f.actor.workspaceId, f.room.id)!.next_seq,
  });
  const before = snapshot(),
    other = new DatabaseSync(f.app.path);
  t.after(() => other.close());
  f.app.db.exec("PRAGMA busy_timeout=20");
  other.exec("BEGIN IMMEDIATE");
  assert.throws(
    () =>
      f.repository.appendMessage(f.actor, f.room.id, {
        role: "user",
        content: "Busy must not save",
      }),
    /locked|busy/i,
  );
  other.exec("ROLLBACK");
  assert.deepEqual(snapshot(), before);
  const pages = Number(f.app.db.prepare("PRAGMA page_count").get()!.page_count);
  f.app.db.exec(`PRAGMA max_page_count=${pages}`);
  assert.throws(
    () =>
      f.repository.appendMessage(f.actor, f.room.id, {
        role: "user",
        content: "x".repeat(32768),
      }),
    /full/i,
  );
  assert.deepEqual(snapshot(), before);
  assert.deepEqual(f.app.db.prepare("PRAGMA foreign_key_check").all(), []);
  f.app.db.exec("PRAGMA max_page_count=2147483646");
  assert.equal(
    f.repository.appendMessage(f.actor, f.room.id, {
      role: "user",
      content: "Recovered after capacity restored",
    }).content,
    "Recovered after capacity restored",
  );
});

test("G1-08: real synchronous event-loop blocking cannot turn an expired response into success", async (t) => {
  const f = appFixture();
  t.after(() => f.dispose());
  const provider = new FakeProvider(() => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120);
    return {
      text: "Expired body must not become a message",
      finish: "STOP",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        completeness: "COMPLETE",
        semantics: "synthetic-v1",
      },
    };
  });
  const generation = new GenerationCoordinator(f.app, f.repository, f.policy, {
    provider,
    defaultModel: "synthetic",
    limits: { deadlineMs: 80 },
  });
  const receipt = generation.accept(f.actor, f.room.id, {
    requestId: "blocked-deadline",
    expectedRoomRevision: 1,
    content: "synthetic deadline input",
    recipient: { type: "all" },
  });
  await generation.execute(receipt.runId);
  const result = generation.get(f.actor, f.room.id, receipt.runId);
  assert.equal(provider.calls.length, 1);
  assert.equal(result.errorCode, "DEADLINE_EXCEEDED");
  assert.equal(result.results.length, 0);
  assert.equal(result.usage[0].completeness, "COMPLETE");
  assert.equal(
    f.repository.listMessages(f.actor, f.room.id).messages.length,
    1,
  );
});
