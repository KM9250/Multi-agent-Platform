import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { AppDatabase } from "../server/app-data/db.ts";
import { ConversationRepository } from "../server/app-data/repository.ts";
import {
  AuthorizationPolicy,
  PUBLIC_USER_OPERATIONS,
} from "../server/auth/authorization.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "map-storage-")),
    app = new AppDatabase({ root });
  app.db.exec(
    "INSERT INTO workspaces VALUES('w',1);INSERT INTO principals(actor_id,workspace_id,active) VALUES('a','w',1),('b','w',1)",
  );
  const actor = { actorId: "a", workspaceId: "w" },
    other = { actorId: "b", workspaceId: "w" },
    policy = new AuthorizationPolicy(app);
  for (const operation of PUBLIC_USER_OPERATIONS)
    policy.grant(actor.actorId, actor.workspaceId, operation);
  const repo = new ConversationRepository(app, policy),
    room = repo.createRoom(actor, { title: "Room" }),
    persona = repo.createPersona(actor, room.id, {
      name: "P",
      model: "synthetic",
    });
  return {
    root,
    app,
    actor,
    other,
    policy,
    repo,
    room,
    persona,
    close() {
      app.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("D1-01/D1-06 immutable revisions and timestamps survive database restart", () => {
  const f = fixture();
  try {
    const m = f.repo.appendMessage(f.actor, f.room.id, {
      role: "user",
      content: "original",
      occurredAt: 1000,
    });
    const revised = f.repo.correctMessage(f.actor, f.room.id, m.id, {
      expectedRevision: 1,
      content: "corrected",
    });
    assert.equal(revised.revision, 2);
    assert.equal(revised.occurredAt, 1000);
    assert.deepEqual(
      f.repo.history(f.actor, f.room.id, m.id).map((x) => x.content),
      ["corrected", "original"],
    );
    const second = new AppDatabase({ root: f.root });
    try {
      const r = new ConversationRepository(
        second,
        new AuthorizationPolicy(second),
      );
      assert.equal(r.getMessage(f.actor, f.room.id, m.id).content, "corrected");
      assert.equal(r.getRoom(f.actor, f.room.id).agents[0].id, f.persona.id);
    } finally {
      second.close();
    }
  } finally {
    f.close();
  }
});

test("D1-05 stale room and persona edits roll back audit and changes", () => {
  const f = fixture();
  try {
    f.repo.updateRoom(f.actor, f.room.id, {
      expectedRevision: 1,
      title: "New",
    });
    f.repo.updatePersona(f.actor, f.room.id, f.persona.id, {
      expectedRevision: 1,
      name: "New P",
    });
    const audits = f.app.db
      .prepare("SELECT count(*) n FROM app_audit_events")
      .get()!.n;
    assert.throws(
      () =>
        f.repo.updateRoom(f.actor, f.room.id, {
          expectedRevision: 1,
          title: "Old",
        }),
      /REVISION_CONFLICT/,
    );
    assert.throws(
      () =>
        f.repo.updatePersona(f.actor, f.room.id, f.persona.id, {
          expectedRevision: 1,
          name: "Old",
        }),
      /REVISION_CONFLICT/,
    );
    assert.equal(
      f.app.db.prepare("SELECT count(*) n FROM app_audit_events").get()!.n,
      audits,
    );
    assert.equal(f.repo.getRoom(f.actor, f.room.id).title, "New");
  } finally {
    f.close();
  }
});

test("D1-11 private classification survives separation OFF and requires exact private grant", () => {
  const f = fixture();
  try {
    const m = f.repo.appendMessage(f.actor, f.room.id, {
      role: "model",
      personaId: f.persona.id,
      segments: [
        { channel: "public_message", visibility: "public", content: "visible" },
        {
          channel: "private_state",
          visibility: "self_only",
          content: "PRIVATE CANARY",
        },
      ],
    });
    f.repo.updateRoom(f.actor, f.room.id, {
      expectedRevision: 1,
      internalStateSettings: { enabled: false },
    });
    assert.ok(
      !JSON.stringify(f.repo.getMessage(f.actor, f.room.id, m.id)).includes(
        "PRIVATE CANARY",
      ),
    );
    assert.deepEqual(f.repo.readPrivateSegments(f.actor, f.room.id, m.id), []);
    f.policy.grant(
      f.actor.actorId,
      f.actor.workspaceId,
      "READ_PRIVATE_SEGMENT",
      { roomId: f.room.id, personaId: f.persona.id, visibility: "self_only" },
    );
    assert.equal(
      f.repo.readPrivateSegments(f.actor, f.room.id, m.id)[0].content,
      "PRIVATE CANARY",
    );
    f.policy.revoke(
      f.actor.actorId,
      f.actor.workspaceId,
      "READ_PRIVATE_SEGMENT",
    );
    assert.deepEqual(f.repo.readPrivateSegments(f.actor, f.room.id, m.id), []);
  } finally {
    f.close();
  }
});

test("RT-DATA-01 private-only source has no public message or history DTO", () => {
  const f = fixture();
  try {
    const m = f.repo.appendMessage(f.actor, f.room.id, {
      role: "model",
      personaId: f.persona.id,
      segments: [
        {
          channel: "memory_export",
          visibility: "self_only",
          content: "private memory",
        },
      ],
    });
    assert.ok(m.id);
    assert.equal(f.repo.listMessages(f.actor, f.room.id).messages.length, 0);
    assert.throws(
      () => f.repo.getMessage(f.actor, f.room.id, m.id),
      /NOT_FOUND/,
    );
    assert.deepEqual(f.repo.history(f.actor, f.room.id, m.id), []);
  } finally {
    f.close();
  }
});

test("RT-DATA-10 opaque cursor binds actor, room and current ACL", () => {
  const f = fixture();
  try {
    for (let i = 0; i < 4; i++)
      f.repo.appendMessage(f.actor, f.room.id, {
        role: "user",
        content: `message ${i}`,
      });
    const page = f.repo.listMessages(f.actor, f.room.id, { limit: 2 });
    assert.deepEqual(
      page.messages.map((m) => m.content),
      ["message 2", "message 3"],
    );
    assert.ok(page.cursor);
    assert.ok(
      !Buffer.from(page.cursor!, "base64url").toString().includes("seq"),
    );
    const older = f.repo.listMessages(f.actor, f.room.id, {
      limit: 2,
      cursor: page.cursor,
    });
    assert.deepEqual(
      older.messages.map((m) => m.content),
      ["message 0", "message 1"],
    );
    for (const op of ["READ_ROOM", "READ_CONVERSATION"])
      f.policy.grant("b", "w", op, { roomId: f.room.id });
    assert.throws(
      () => f.repo.listMessages(f.other, f.room.id, { cursor: page.cursor }),
      /INVALID_CURSOR/,
    );
    assert.throws(
      () => f.repo.listMessages(f.actor, f.room.id, { cursor: page.cursor }),
      /INVALID_CURSOR/,
    );
    assert.equal(f.repo.listRooms(f.other).length, 1);
  } finally {
    f.close();
  }
});

test("C1-07 nested caught failure poisons entire transaction", () => {
  const f = fixture();
  try {
    assert.throws(
      () =>
        f.app.transaction(() => {
          f.repo.appendMessage(f.actor, f.room.id, {
            role: "user",
            content: "must rollback",
          });
          try {
            f.app.transaction(() => {
              throw new Error("inner");
            });
          } catch {}
        }),
      /TRANSACTION_ABORTED/,
    );
    assert.equal(f.repo.listMessages(f.actor, f.room.id).messages.length, 0);
    f.app.db.exec(
      "CREATE TRIGGER fail_audit BEFORE INSERT ON app_audit_events BEGIN SELECT RAISE(ABORT,'audit failure'); END",
    );
    assert.throws(() =>
      f.repo.appendMessage(f.actor, f.room.id, {
        role: "user",
        content: "audit rollback",
      }),
    );
    assert.equal(
      f.app.db.prepare("SELECT count(*) n FROM messages").get()!.n,
      0,
    );
  } finally {
    f.close();
  }
});

test("C1-08 foreign database refused before any modification", () => {
  const root = mkdtempSync(join(tmpdir(), "map-foreign-")),
    path = join(root, "app-data.sqlite");
  try {
    const db = new DatabaseSync(path);
    db.exec(
      "CREATE TABLE coordination_schema(version INTEGER); INSERT INTO coordination_schema VALUES(11)",
    );
    db.close();
    const before = readFileSync(path);
    assert.throws(() => new AppDatabase({ root }), /WRONG_DATABASE/);
    assert.deepEqual(readFileSync(path), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("RT-DATA-14 deletion hides current, historic and persona source", () => {
  const f = fixture();
  try {
    const user = f.repo.appendMessage(f.actor, f.room.id, {
      role: "user",
      content: "erase",
    });
    f.repo.correctMessage(f.actor, f.room.id, user.id, {
      expectedRevision: 1,
      content: "revision",
    });
    f.repo.deleteMessage(f.actor, f.room.id, user.id, { expectedRevision: 2 });
    assert.throws(
      () => f.repo.getMessage(f.actor, f.room.id, user.id, 1),
      /NOT_FOUND/,
    );
    assert.throws(
      () => f.repo.history(f.actor, f.room.id, user.id),
      /NOT_FOUND/,
    );
    const model = f.repo.appendMessage(f.actor, f.room.id, {
      role: "model",
      personaId: f.persona.id,
      content: "persona source",
    });
    f.repo.deletePersona(f.actor, f.room.id, f.persona.id, {
      expectedRevision: 1,
    });
    assert.throws(
      () => f.repo.getMessage(f.actor, f.room.id, model.id),
      /NOT_FOUND/,
    );
    assert.deepEqual(f.repo.listMessages(f.actor, f.room.id).messages, []);
  } finally {
    f.close();
  }
});

test("closed settings and non-JSON input do not execute getters", () => {
  const f = fixture();
  try {
    let called = 0;
    const value = {
      get title() {
        called++;
        return "unsafe";
      },
    };
    assert.throws(() => f.repo.createRoom(f.actor, value), /INVALID_INPUT/);
    assert.equal(called, 0);
    assert.throws(
      () =>
        f.repo.updateRoom(f.actor, f.room.id, {
          expectedRevision: 1,
          isAdmin: true,
        }),
      /UNKNOWN_FIELD/,
    );
    assert.throws(
      () =>
        f.repo.createPersona(f.actor, f.room.id, {
          name: "P",
          providerUrl: "https://evil.invalid",
        }),
      /UNKNOWN_FIELD/,
    );
    assert.equal(f.repo.getRoom(f.actor, f.room.id).revision, 1);
  } finally {
    f.close();
  }
});

test("RT-DATA-05 hostile authorization callback cannot mutate actor or target binding", () => {
  const f = fixture();
  try {
    let caught = 0;
    const policy = {
      assert(actor: any, _operation: string, scope: any) {
        try {
          actor.workspaceId = "other";
        } catch {
          caught++;
        }
        try {
          scope.roomId = "another-room";
        } catch {
          caught++;
        }
      },
      canReadSegment(actor: any, segment: any) {
        try {
          segment.visibility = "public";
        } catch {
          caught++;
        }
        return false;
      },
    };
    const repository = new ConversationRepository(f.app, policy);
    const actor = { ...f.actor };
    assert.equal(repository.getRoom(actor, f.room.id).id, f.room.id);
    assert.equal(actor.workspaceId, "w");
    assert.ok(caught >= 2);
    const raw = f.app.db.prepare("SELECT count(*) n FROM rooms").get()!.n;
    assert.equal(raw, 1);
  } finally {
    f.close();
  }
});

test("transaction metrics retain COMMIT acknowledgement uncertainty without leaking payloads", () => {
  const root = mkdtempSync(join(tmpdir(), "map-metrics-"));
  const app = new AppDatabase({
    root,
    hooks: {
      afterCommit(phase) {
        if (phase === "lose-ack") throw new Error("ack lost");
      },
    },
  });
  try {
    assert.throws(
      () =>
        app.transaction(
          () => app.audit("a", "w", "TEST", "target"),
          "lose-ack",
        ),
      /ack lost/,
    );
    assert.equal(
      app.db.prepare("SELECT count(*) n FROM app_audit_events").get()!.n,
      1,
    );
    const metrics = app.metrics();
    assert.equal(metrics.transactionCount, 1);
    assert.equal(metrics.transactionFailures, 1);
    assert.equal(metrics.commitAckUncertain, 1);
    assert.ok(metrics.transactionMs >= 0);
    assert.ok(Object.isFrozen(metrics));
    assert.deepEqual(
      Object.keys(metrics).sort(),
      [
        "commitAckUncertain",
        "transactionCount",
        "transactionFailures",
        "transactionMs",
      ].sort(),
    );
  } finally {
    app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("authorization adapters reject async and truthy nonboolean decisions without invoking then getters", () => {
  const f = fixture();
  try {
    let invoked = 0;
    const thenable = {
      get then() {
        invoked++;
        return () => {};
      },
    };
    const asyncAssert = new ConversationRepository(f.app, {
      assert: () => thenable,
      canReadSegment: () => false,
    } as any);
    assert.throws(
      () => asyncAssert.getRoom(f.actor, f.room.id),
      /INVALID_AUTHORIZATION_CALLBACK/,
    );
    const m = f.repo.appendMessage(f.actor, f.room.id, {
      role: "model",
      personaId: f.persona.id,
      segments: [
        {
          channel: "private_state",
          visibility: "self_only",
          content: "secret",
        },
      ],
    });
    const truthyReader = new ConversationRepository(f.app, {
      assert: () => {},
      canReadSegment: () => thenable,
    } as any);
    assert.throws(
      () => truthyReader.readPrivateSegments(f.actor, f.room.id, m.id),
      /INVALID_AUTHORIZATION_CALLBACK/,
    );
    assert.equal(invoked, 0);
  } finally {
    f.close();
  }
});
