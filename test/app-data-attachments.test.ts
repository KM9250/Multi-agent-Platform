import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  symlinkSync,
  linkSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AppDatabase } from "../server/app-data/db.ts";
import { ConversationRepository } from "../server/app-data/repository.ts";
import { AttachmentStore } from "../server/attachments/store.ts";
import {
  AuthorizationPolicy,
  PUBLIC_USER_OPERATIONS,
} from "../server/auth/authorization.ts";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "map-attachment-")),
    app = new AppDatabase({ root });
  app.db.exec(
    "INSERT INTO workspaces VALUES('w',1);INSERT INTO principals(actor_id,workspace_id,active) VALUES('a','w',1),('b','w',1)",
  );
  const actor = { actorId: "a", workspaceId: "w" },
    other = { actorId: "b", workspaceId: "w" },
    policy = new AuthorizationPolicy(app);
  for (const a of [actor, other])
    for (const op of PUBLIC_USER_OPERATIONS)
      policy.grant(a.actorId, a.workspaceId, op);
  const repo = new ConversationRepository(app, policy),
    room = repo.createRoom(actor, { title: "Room" }),
    store = new AttachmentStore(app, policy);
  return {
    root,
    app,
    actor,
    other,
    policy,
    repo,
    room,
    store,
    close() {
      app.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("D1-13 upload is author-only until public message linked and deletion removes access", async () => {
  const f = fixture();
  try {
    const a = await f.store.upload(f.actor, f.room.id, {
      name: "a.txt",
      mimeType: "text/plain",
      data: Buffer.from("original"),
    });
    assert.equal(
      (await f.store.read(f.actor, f.room.id, a.id)).data.toString(),
      "original",
    );
    assert.throws(
      () => f.store.metadata(f.other, f.room.id, a.id),
      /NOT_FOUND/,
    );
    const m = f.repo.appendMessage(f.actor, f.room.id, {
      role: "user",
      content: "file",
      attachmentIds: [a.id],
    });
    assert.equal(
      (await f.store.read(f.other, f.room.id, a.id)).data.toString(),
      "original",
    );
    assert.equal(
      f.repo.getMessage(f.actor, f.room.id, m.id).attachments[0].id,
      a.id,
    );
    f.repo.deleteMessage(f.actor, f.room.id, m.id, { expectedRevision: 1 });
    await assert.rejects(f.store.read(f.actor, f.room.id, a.id), /NOT_FOUND/);
    await assert.rejects(f.store.read(f.other, f.room.id, a.id), /NOT_FOUND/);
  } finally {
    f.close();
  }
});

test("private additional context needs persona config authority and explicit generation reader", async () => {
  const f = fixture();
  try {
    const a = await f.store.upload(f.actor, f.room.id, {
      name: "private.txt",
      mimeType: "text/plain",
      data: Buffer.from("private context"),
    });
    const p = f.repo.createPersona(f.actor, f.room.id, {
      name: "P",
      model: "synthetic",
      contextAttachmentIds: [a.id],
    });
    f.policy.revoke("b", "w", "EDIT_PERSONA");
    assert.throws(
      () => f.store.metadata(f.other, f.room.id, a.id),
      /NOT_FOUND/,
    );
    assert.equal(
      (
        await f.store.readForContext(f.other, f.room.id, a.id, p.id)
      ).data.toString(),
      "private context",
    );
    f.repo.deletePersona(f.actor, f.room.id, p.id, { expectedRevision: 1 });
    await assert.rejects(
      f.store.readForContext(f.actor, f.room.id, a.id, p.id),
      /NOT_FOUND/,
    );
  } finally {
    f.close();
  }
});

test("RT-DATA-08 symlink hardlink and digest corruption fail without returning content", async () => {
  const f = fixture();
  try {
    const a = await f.store.upload(f.actor, f.room.id, {
      name: "test.txt",
      mimeType: "text/plain",
      data: Buffer.from("one"),
    });
    const row = f.app.db
        .prepare("SELECT blob_key FROM attachments WHERE attachment_id=?")
        .get(a.id)!,
      path = join(f.root, "attachments", String(row.blob_key)),
      outside = join(f.root, "secret");
    writeFileSync(outside, "SECRET");
    unlinkSync(path);
    symlinkSync(outside, path);
    await assert.rejects(f.store.read(f.actor, f.room.id, a.id), /UNSAFE_PATH/);
    unlinkSync(path);
    linkSync(outside, path);
    await assert.rejects(f.store.read(f.actor, f.room.id, a.id), /UNSAFE_PATH/);
    unlinkSync(path);
    writeFileSync(path, "two");
    await assert.rejects(
      f.store.read(f.actor, f.room.id, a.id),
      /ATTACHMENT_INTEGRITY/,
    );
  } finally {
    f.close();
  }
});

test("RT-DATA-09 unsafe MIME and mismatched image signatures leave no DB rows", async () => {
  const f = fixture();
  try {
    await assert.rejects(
      f.store.upload(f.actor, f.room.id, {
        name: "x.svg",
        mimeType: "image/svg+xml",
        data: Buffer.from('<svg onload="alert(1)"/>'),
      }),
      /UNSUPPORTED_MEDIA_TYPE/,
    );
    await assert.rejects(
      f.store.upload(f.actor, f.room.id, {
        name: "x.png",
        mimeType: "image/png",
        data: Buffer.from("<html>"),
      }),
      /MIME_MISMATCH/,
    );
    assert.equal(
      f.app.db.prepare("SELECT count(*) n FROM attachments").get()!.n,
      0,
    );
  } finally {
    f.close();
  }
});

test("C1-03 failed DB finalization preserves orphan for explicit reference-checked collection", async () => {
  const f = fixture();
  try {
    f.app.db.exec(
      "CREATE TRIGGER fail_attachment_audit BEFORE INSERT ON app_audit_events WHEN NEW.action='UPLOAD_ATTACHMENT' BEGIN SELECT RAISE(ABORT,'disk'); END",
    );
    await assert.rejects(
      f.store.upload(f.actor, f.room.id, {
        name: "x.txt",
        mimeType: "text/plain",
        data: Buffer.from("body"),
      }),
    );
    assert.equal(
      f.app.db.prepare("SELECT count(*) n FROM attachments").get()!.n,
      0,
    );
    assert.equal((await f.store.collectOrphans()).orphans.length, 1);
    await f.store.collectOrphans(true);
    assert.equal((await f.store.collectOrphans()).orphans.length, 0);
  } finally {
    f.close();
  }
});

test("C1-04 deterministic import upload retries converge without extra attachment rows", async () => {
  const f = fixture();
  try {
    const options = { attachmentId: "11111111-1111-4111-8111-111111111111" },
      input = {
        name: "legacy.txt",
        mimeType: "text/plain",
        data: Buffer.from("same source"),
      };
    const first = await f.store.upload(f.actor, f.room.id, input, options);
    const second = await f.store.upload(f.actor, f.room.id, input, options);
    assert.deepEqual(first, second);
    await assert.rejects(
      f.store.upload(
        f.actor,
        f.room.id,
        { ...input, data: Buffer.from("different") },
        options,
      ),
      /ATTACHMENT_CONFLICT/,
    );
    assert.equal(
      f.app.db.prepare("SELECT count(*) n FROM attachments").get()!.n,
      1,
    );
    assert.equal((await f.store.collectOrphans()).orphans.length, 0);
  } finally {
    f.close();
  }
});

test("D1-06 revision attachment readers preserve old public references and enforce current private grants", async () => {
  const f = fixture();
  try {
    const a = await f.store.upload(f.actor, f.room.id, {
      name: "old.txt",
      mimeType: "text/plain",
      data: Buffer.from("historic bytes"),
    });
    const m = f.repo.appendMessage(f.actor, f.room.id, {
      role: "user",
      content: "old",
      attachmentIds: [a.id],
    });
    f.repo.appendRevision(f.actor, f.room.id, m.id, {
      expectedRevision: 1,
      content: "new without attachment",
      attachmentIds: [],
      reason: "correction",
    });
    assert.equal(
      (await f.store.read(f.other, f.room.id, a.id)).data.toString(),
      "historic bytes",
    );
    const p = f.repo.createPersona(f.actor, f.room.id, {
      name: "P",
      model: "synthetic",
    });
    const secret = await f.store.upload(f.actor, f.room.id, {
      name: "private.txt",
      mimeType: "text/plain",
      data: Buffer.from("private bytes"),
    });
    f.repo.appendMessage(f.actor, f.room.id, {
      role: "model",
      personaId: p.id,
      segments: [
        {
          channel: "private_state",
          visibility: "self_only",
          content: "private",
        },
      ],
      attachmentIds: [secret.id],
    });
    await assert.rejects(
      f.store.read(f.actor, f.room.id, secret.id),
      /NOT_FOUND/,
    );
    f.policy.grant("a", "w", "READ_PRIVATE_SEGMENT", {
      roomId: f.room.id,
      personaId: p.id,
      visibility: "self_only",
    });
    assert.equal(
      (await f.store.read(f.actor, f.room.id, secret.id)).data.toString(),
      "private bytes",
    );
    f.policy.revoke("a", "w", "READ_PRIVATE_SEGMENT");
    await assert.rejects(
      f.store.read(f.actor, f.room.id, secret.id),
      /NOT_FOUND/,
    );
  } finally {
    f.close();
  }
});

test("RT-DATA-04 message and history projections respect attachment metadata permission", async () => {
  const f = fixture();
  try {
    const attachment = await f.store.upload(f.actor, f.room.id, {
      name: "restricted.txt",
      mimeType: "text/plain",
      data: Buffer.from("attachment bytes"),
    });
    const message = f.repo.appendMessage(f.actor, f.room.id, {
      role: "user",
      content: "readable message",
      attachmentIds: [attachment.id],
    });
    f.policy.revoke("b", "w", "READ_ATTACHMENT");
    assert.throws(
      () => f.store.metadata(f.other, f.room.id, attachment.id),
      /FORBIDDEN/,
    );
    const direct = f.repo.getMessage(f.other, f.room.id, message.id);
    const page = f.repo.listMessages(f.other, f.room.id);
    const history = f.repo.history(f.other, f.room.id, message.id);
    for (const result of [direct, ...page.messages, ...history]) {
      assert.equal(result.content, "readable message");
      assert.deepEqual(result.attachments, []);
      assert.ok(!JSON.stringify(result).includes(attachment.digest));
    }
    f.policy.grant("b", "w", "READ_ATTACHMENT", { roomId: f.room.id });
    assert.equal(
      f.repo.getMessage(f.other, f.room.id, message.id).attachments[0].digest,
      attachment.digest,
    );
  } finally {
    f.close();
  }
});
