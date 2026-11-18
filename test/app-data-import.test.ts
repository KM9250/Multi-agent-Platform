import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../server/app-data/db.ts";
import { ConversationRepository } from "../server/app-data/repository.ts";
import {
  AuthorizationPolicy,
  PUBLIC_USER_OPERATIONS,
} from "../server/auth/authorization.ts";
import { AttachmentStore } from "../server/attachments/store.ts";
import { ImportService } from "../server/operations/import.ts";
import { ExportService } from "../server/operations/export.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "map-import-")),
    app = new AppDatabase({ root });
  app.db.exec(
    "INSERT INTO workspaces VALUES('w',1);INSERT INTO principals VALUES('a','w',1),('other','w',1)",
  );
  const actor = { actorId: "a", workspaceId: "w" },
    policy = new AuthorizationPolicy(app);
  for (const operation of PUBLIC_USER_OPERATIONS)
    policy.grant("a", "w", operation);
  const repo = new ConversationRepository(app, policy),
    attachments = new AttachmentStore(app, policy),
    service = new ImportService(app, repo, attachments, policy),
    exporter = new ExportService(app, repo, attachments, policy);
  return {
    root,
    app,
    actor,
    policy,
    repo,
    attachments,
    service,
    exporter,
    close() {
      app.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
const persona = (id = "p") => ({
  id,
  name: "same name",
  description: "",
  systemInstruction: "instruction",
  model: "synthetic",
  framework: "standard",
  color: "#123456",
  avatar: "🙂",
  avatarType: "emoji",
  isEnabled: true,
  thinkingBudget: 0,
  historyWindow: 0,
});
const legacy = () => ({
  sourceId: "browser-archive-1",
  rooms: [
    {
      id: "r",
      title: "old room",
      description: "",
      type: "Sandbox",
      agents: [persona(), persona("p2")],
      messages: [
        {
          id: "u",
          role: "user",
          content: "original input",
          timestamp: 1600000000000,
          attachments: [
            {
              id: "text",
              type: "text",
              name: "notes.txt",
              mimeType: "text/plain",
              data: "attachment original",
            },
          ],
        },
        {
          id: "m",
          role: "model",
          agentId: "p",
          content: "public response",
          timestamp: 1600000001000,
          segments: [
            {
              id: "public",
              channel: "public_message",
              visibility: "public",
              content: "public response",
            },
            {
              id: "private",
              channel: "private_state",
              visibility: "self_only",
              content: "PRIVATE_IMPORT_CANARY",
            },
          ],
        },
      ],
      decisionEvents: [
        {
          id: "decision",
          turnId: "old-turn",
          timestamp: 1600000001000,
          agentId: "p",
          agentName: "same name",
          outcome: "STAMP",
          source: "llm_decision",
          latencyMs: 12,
          rawDecision: "PRIVATE_RAW_DECISION",
          reaction: "ACK",
        },
      ],
      reactions: [
        {
          id: "reaction",
          messageId: "u",
          agentId: "p",
          semantic: "ACK",
          timestamp: 1600000001000,
          turnId: "old-turn",
        },
      ],
      updatedAt: 1600000001000,
    },
  ],
});

test("C1-06 import reconciles original text, times, private segments, decisions, reactions and attachment digests", async () => {
  const f = fixture();
  try {
    const payload = legacy(),
      preview = f.service.dryRun(f.actor, payload);
    assert.deepEqual(preview.counts, {
      rooms: 1,
      personas: 2,
      messages: 2,
      revisions: 2,
      segments: 3,
      decisions: 1,
      reactions: 1,
      attachments: 1,
    });
    assert.equal(f.repo.listRooms(f.actor).length, 0);
    const receipt = await f.service.start(f.actor, {
      requestId: "import-1",
      ...payload,
    });
    assert.equal(receipt.status, "COMPLETE");
    assert.equal(receipt.reconciliation.digestsVerified, true);
    const room = f.repo.listRooms(f.actor)[0],
      page = f.repo.listMessages(f.actor, room.id);
    assert.equal(room.agents.length, 2);
    assert.notEqual(room.agents[0].id, room.agents[1].id);
    assert.equal(page.messages[0].occurredAt, 1600000000000);
    assert.equal(page.messages[0].content, "original input");
    assert.ok(!JSON.stringify(page).includes("PRIVATE_IMPORT_CANARY"));
    assert.ok(!JSON.stringify(receipt).includes("PRIVATE_IMPORT_CANARY"));
    const attachment = await f.attachments.read(
      f.actor,
      room.id,
      page.messages[0].attachments[0].id,
    );
    assert.equal(attachment.data.toString(), "attachment original");
    assert.equal(
      f.app.db.prepare("SELECT count(*) n FROM import_decisions").get()!.n,
      1,
    );
    assert.equal(
      f.app.db.prepare("SELECT count(*) n FROM import_reactions").get()!.n,
      1,
    );
    const again = await f.service.start(f.actor, {
      requestId: "different-request",
      ...payload,
    });
    assert.equal(again.batchId, receipt.batchId);
    assert.equal(
      f.app.db.prepare("SELECT count(*) n FROM messages").get()!.n,
      2,
    );
    assert.equal(
      f.app.db.prepare("SELECT count(*) n FROM attachments").get()!.n,
      1,
    );
  } finally {
    f.close();
  }
});

test("C1-04 interrupted import remains unpublished and resumes exact item mappings without duplicate uploads", async () => {
  const f = fixture();
  try {
    let stop = true;
    const service = new ImportService(f.app, f.repo, f.attachments, f.policy, {
      afterItem(kind) {
        if (kind === "message" && stop) {
          stop = false;
          throw new Error("simulated process boundary");
        }
      },
    });
    await assert.rejects(
      service.start(f.actor, { requestId: "request", ...legacy() }),
      /simulated process/,
    );
    assert.equal(f.repo.listRooms(f.actor).length, 0);
    const before = f.app.db
      .prepare("SELECT attachment_id FROM attachments")
      .get()!.attachment_id;
    const resumed = await f.service.start(f.actor, {
      requestId: "request",
      ...legacy(),
    });
    assert.equal(resumed.status, "COMPLETE");
    assert.equal(
      f.app.db.prepare("SELECT count(*) n FROM attachments").get()!.n,
      1,
    );
    assert.equal(
      f.app.db.prepare("SELECT attachment_id FROM attachments").get()!
        .attachment_id,
      before,
    );
    assert.equal(
      f.app.db.prepare("SELECT count(*) n FROM messages").get()!.n,
      2,
    );
  } finally {
    f.close();
  }
});

test("D1-03 concurrent import converges to one batch, room, message and attachment", async () => {
  const f = fixture();
  try {
    const secondDb = new AppDatabase({ root: f.root }),
      secondPolicy = new AuthorizationPolicy(secondDb),
      secondRepo = new ConversationRepository(secondDb, secondPolicy),
      secondAttachments = new AttachmentStore(secondDb, secondPolicy);
    try {
      const second = new ImportService(
          secondDb,
          secondRepo,
          secondAttachments,
          secondPolicy,
        ),
        input = { requestId: "concurrent", ...legacy() };
      const [one, two] = await Promise.all([
        f.service.start(f.actor, input),
        second.start(f.actor, input),
      ]);
      assert.equal(one.batchId, two.batchId);
      assert.equal(one.status, "COMPLETE");
      assert.equal(two.status, "COMPLETE");
      for (const [table, count] of [
        ["rooms", 1],
        ["messages", 2],
        ["attachments", 1],
        ["import_batches", 1],
      ] as const)
        assert.equal(
          f.app.db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n,
          count,
        );
    } finally {
      secondDb.close();
    }
  } finally {
    f.close();
  }
});

test("C1-05 changed old IDs conflict across browser exports, identical copies reuse stable IDs", async () => {
  const f = fixture();
  try {
    const first = await f.service.start(f.actor, {
        requestId: "first",
        ...legacy(),
      }),
      copy = legacy();
    copy.sourceId = "browser-copy";
    const second = await f.service.start(f.actor, {
      requestId: "copy",
      ...copy,
    });
    assert.equal(second.status, "COMPLETE");
    assert.equal(f.app.db.prepare("SELECT count(*) n FROM rooms").get()!.n, 1);
    assert.equal(
      f.app.db.prepare("SELECT count(*) n FROM attachments").get()!.n,
      1,
    );
    copy.rooms[0].messages[0].content = "conflicting original";
    assert.throws(
      () => f.service.dryRun(f.actor, copy),
      /IMPORT_SOURCE_CONFLICT/,
    );
    assert.equal(
      f.app.db.prepare("SELECT count(*) n FROM messages").get()!.n,
      2,
    );
    const repeated = legacy();
    repeated.sourceId = "changed-source";
    await assert.rejects(
      f.service.start(f.actor, { requestId: "first", ...repeated }),
      /IDEMPOTENCY_CONFLICT/,
    );
    assert.equal(f.service.status(f.actor, first.batchId).status, "COMPLETE");
  } finally {
    f.close();
  }
});

test("RT-DATA-11 invalid legacy fields and incomplete raw output confer no authority and trigger zero calls", async () => {
  const f = fixture();
  try {
    const injected: any = legacy();
    injected.rooms[0].owner = "admin";
    assert.throws(
      () => f.service.dryRun(f.actor, injected),
      /IMPORT_UNKNOWN_FIELD/,
    );
    const secret: any = legacy();
    secret.rooms[0].agents[0].apiKey = "canary-secret";
    assert.throws(
      () => f.service.dryRun(f.actor, secret),
      /IMPORT_UNTRUSTED_FIELD/,
    );
    const input: any = legacy();
    input.rooms[0].messages.push({
      id: "unfinished",
      role: "model",
      agentId: "p",
      content: '{"private_state":"RAW_PARTIAL_CANARY"',
      isStreaming: true,
    });
    input.rooms[0].messages.push({
      id: "unclassified",
      role: "model",
      agentId: "p",
      content: "",
      timestamp: 100,
      segments: [
        {
          id: "unknown",
          channel: "mystery",
          visibility: "public",
          content: "UNKNOWN_PRIVATE_CANARY",
        },
      ],
    });
    const preview = f.service.dryRun(f.actor, input);
    assert.ok(
      preview.warnings.some(
        (w) => w.code === "UNKNOWN_CLASSIFICATION_QUARANTINED",
      ),
    );
    await f.service.start(f.actor, { requestId: "safe", ...input });
    const room = f.repo.listRooms(f.actor)[0];
    const output = JSON.stringify(f.repo.listMessages(f.actor, room.id));
    assert.ok(!output.includes("RAW_PARTIAL_CANARY"));
    assert.ok(!output.includes("UNKNOWN_PRIVATE_CANARY"));
    assert.equal(
      f.app.db.prepare("SELECT count(*) n FROM app_provider_calls").get()!.n,
      0,
    );
    assert.equal(
      f.app.db.prepare("SELECT count(*) n FROM app_generation_runs").get()!.n,
      0,
    );
    assert.equal(
      f.app.db
        .prepare(
          "SELECT original_content FROM import_source_records WHERE incomplete=1",
        )
        .get()!.original_content,
      '{"private_state":"RAW_PARTIAL_CANARY"',
    );
  } finally {
    f.close();
  }
});

test("RT-DATA-12 legacy depth, prototype, oversized values and getters reject before durable changes", () => {
  const f = fixture();
  try {
    let invoked = 0;
    assert.throws(
      () =>
        f.service.dryRun(f.actor, {
          get sourceId() {
            invoked++;
            return "x";
          },
          rooms: [],
        }),
      /IMPORT_UNTRUSTED_FIELD/,
    );
    assert.equal(invoked, 0);
    const deep: any = { sourceId: "x", rooms: [] };
    let current = deep;
    for (let i = 0; i < 20; i++) {
      current.x = {};
      current = current.x;
    }
    assert.throws(() => f.service.dryRun(f.actor, deep), /IMPORT_DEPTH_LIMIT/);
    assert.throws(
      () =>
        f.service.dryRun(
          f.actor,
          JSON.parse('{"sourceId":"x","rooms":[],"__proto__":{}}'),
        ),
      /IMPORT_UNTRUSTED_FIELD/,
    );
    const large = legacy();
    large.rooms[0].messages[0].content = "x".repeat(32769);
    assert.throws(() => f.service.dryRun(f.actor, large), /IMPORT_INVALID/);
    assert.equal(
      f.app.db.prepare("SELECT count(*) n FROM import_batches").get()!.n,
      0,
    );
    assert.equal(f.app.db.prepare("SELECT count(*) n FROM rooms").get()!.n, 0);
  } finally {
    f.close();
  }
});

test("Export current grants cover private-only originals; chunks/cursors, revisions and deletion stay bound", async () => {
  const f = fixture();
  try {
    const room = f.repo.createRoom(f.actor, { title: "export" }),
      p = f.repo.createPersona(f.actor, room.id, {
        name: "persona",
        model: "synthetic",
      });
    const original = f.repo.appendMessage(f.actor, room.id, {
      role: "user",
      content: "old",
    });
    f.repo.correctMessage(f.actor, room.id, original.id, {
      expectedRevision: 1,
      content: "new",
    });
    f.repo.appendMessage(f.actor, room.id, {
      role: "model",
      personaId: p.id,
      segments: [
        {
          channel: "memory_export",
          visibility: "self_only",
          content: "PRIVATE_MEMORY_EXPORT",
        },
      ],
    });
    assert.ok(
      !JSON.stringify(await f.exporter.exportRoom(f.actor, room.id)).includes(
        "PRIVATE_MEMORY_EXPORT",
      ),
    );
    f.policy.grant("a", "w", "READ_PRIVATE_SEGMENT", {
      roomId: room.id,
      personaId: p.id,
      visibility: "self_only",
    });
    const first = await f.exporter.exportRoom(f.actor, room.id, { limit: 1 });
    assert.ok(JSON.stringify(first).includes("PRIVATE_MEMORY_EXPORT"));
    assert.ok(first.nextCursor);
    const second = await f.exporter.exportRoom(f.actor, room.id, {
      limit: 1,
      cursor: first.nextCursor!,
    });
    assert.equal(second.messages[0].revisions.length, 2);
    assert.equal(second.nextCursor, null);
    f.policy.revoke("a", "w", "READ_PRIVATE_SEGMENT");
    await assert.rejects(
      f.exporter.exportRoom(f.actor, room.id, { cursor: first.nextCursor! }),
      /INVALID_CURSOR/,
    );
    f.repo.deleteMessage(f.actor, room.id, original.id, {
      expectedRevision: 2,
    });
    const deleted = await f.exporter.exportRoom(f.actor, room.id);
    assert.equal(deleted.messages.length, 0);
    const other = { actorId: "other", workspaceId: "w" };
    await assert.rejects(f.exporter.exportRoom(other, room.id), /FORBIDDEN/);
  } finally {
    f.close();
  }
});

test("Export final output rejects deletion or ACL withdrawal during chunk yields", async () => {
  const f = fixture();
  try {
    const room = f.repo.createRoom(f.actor, { title: "race" }),
      message = f.repo.appendMessage(f.actor, room.id, {
        role: "user",
        content: "WITHDRAW_CANARY",
      });
    const exporting = f.exporter.exportRoom(f.actor, room.id);
    f.repo.deleteMessage(f.actor, room.id, message.id, { expectedRevision: 1 });
    await assert.rejects(exporting, /EXPORT_SOURCE_CHANGED/);
    const p = f.repo.createPersona(f.actor, room.id, {
      name: "p",
      model: "synthetic",
    });
    f.repo.appendMessage(f.actor, room.id, {
      role: "model",
      personaId: p.id,
      content: "WITHDRAW_PERSONA",
    });
    const personaExport = f.exporter.exportRoom(f.actor, room.id);
    f.repo.deletePersona(f.actor, room.id, p.id, { expectedRevision: 1 });
    await assert.rejects(personaExport, /EXPORT_SOURCE_CHANGED/);
  } finally {
    f.close();
  }
});

test("D1-04 every alias request remains bound to its original import payload", async () => {
  const f = fixture();
  try {
    await f.service.start(f.actor, { requestId: "original", ...legacy() });
    await f.service.start(f.actor, { requestId: "alias", ...legacy() });
    const other = legacy();
    other.sourceId = "new-browser";
    other.rooms[0].id = "different-room";
    await assert.rejects(
      f.service.start(f.actor, { requestId: "alias", ...other }),
      /IDEMPOTENCY_CONFLICT/,
    );
    assert.equal(
      f.app.db.prepare("SELECT count(*) n FROM import_batches").get()!.n,
      1,
    );
  } finally {
    f.close();
  }
});

for (const boundary of [
  "message:item",
  "import-publish:before",
  "import-publish:after",
])
  test(`C1-04 actual SIGKILL at ${boundary} preserves publication barrier and resume mapping`, async () => {
    const f = fixture();
    try {
      const input = { requestId: "killed-import", ...legacy() },
        inputPath = join(f.root, "synthetic-import.json");
      writeFileSync(inputPath, JSON.stringify(input), { mode: 0o600 });
      const child = spawn(
        process.execPath,
        [
          "--experimental-transform-types",
          "--loader",
          "./test/ts-loader.mjs",
          "test/app-data-import-child.ts",
          f.root,
          inputPath,
          boundary,
        ],
        { stdio: ["ignore", "pipe", "pipe"], cwd: process.cwd() },
      );
      let output = "",
        errors = "";
      child.stderr.on("data", (part) => (errors += part.toString()));
      const exit = once(child, "exit");
      try {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error(`import boundary timeout: ${errors}`)),
            15000,
          );
          child.stdout.on("data", (part) => {
            output += part.toString();
            if (output.includes("IMPORT_BOUNDARY")) {
              clearTimeout(timeout);
              resolve();
            }
          });
          child.on("exit", (code) => {
            clearTimeout(timeout);
            reject(new Error(`early exit ${code}: ${errors}`));
          });
          child.on("error", reject);
        });
        child.kill("SIGKILL");
        const result = await exit;
        assert.equal(result[1], "SIGKILL");
      } finally {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
      }
      assert.equal(
        f.repo.listRooms(f.actor).length,
        boundary === "import-publish:after" ? 1 : 0,
      );
      const result = await f.service.start(f.actor, input);
      assert.equal(result.status, "COMPLETE");
      assert.equal(f.repo.listRooms(f.actor).length, 1);
      assert.equal(
        f.app.db.prepare("SELECT count(*) n FROM messages").get()!.n,
        2,
      );
      assert.equal(
        f.app.db.prepare("SELECT count(*) n FROM attachments").get()!.n,
        1,
      );
      assert.equal(
        f.app.db.prepare("SELECT count(*) n FROM app_provider_calls").get()!.n,
        0,
      );
      assert.deepEqual(f.app.db.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      f.close();
    }
  });
