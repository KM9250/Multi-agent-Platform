import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../server/app-data/db.ts";
import { ConversationRepository } from "../server/app-data/repository.ts";
import { AuthorizationPolicy } from "../server/auth/authorization.ts";
import { SessionService } from "../server/auth/sessions.ts";
import { AttachmentStore } from "../server/attachments/store.ts";
import { ImportService } from "../server/operations/import.ts";
import { ExportService } from "../server/operations/export.ts";
import { prepareLegacy } from "../server/operations/legacy.ts";
import { GenerationCoordinator } from "../server/generation/coordinator.ts";
import { FakeProvider, GeminiProvider } from "../server/generation/provider.ts";
import { createAppHandler } from "../server/http/server.ts";
import { applyHistoryWindow } from "../services/geminiService.ts";

async function fixture(t: any, options: any = {}) {
  const root = mkdtempSync(join(tmpdir(), "map-pr38-"));
  const app = new AppDatabase({ root }),
    policy = new AuthorizationPolicy(app),
    sessions = new SessionService(app);
  const actor = await sessions.createAccount({
    username: "audit",
    password: "synthetic-audit-password",
  });
  const repository = new ConversationRepository(app, policy),
    attachments = new AttachmentStore(app, policy);
  const provider = options.provider ?? new FakeProvider();
  const generation = new GenerationCoordinator(app, repository, policy, {
    provider,
    defaultModel: "synthetic",
    attachmentStore: attachments,
    ...options,
  });
  const imports = new ImportService(app, repository, attachments, policy),
    exporter = new ExportService(app, repository, attachments, policy);
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  server.on(
    "request",
    createAppHandler({
      app,
      policy,
      sessions,
      repository,
      attachments,
      generation,
      imports,
      exports: exporter,
      origin,
      development: true,
    }),
  );
  let cookie = "",
    csrf = "";
  const request = async (path: string, method = "GET", input?: any) => {
    const response = await fetch(origin + "/api/app/v1" + path, {
      method,
      headers: {
        cookie,
        ...(method === "GET"
          ? {}
          : {
              origin,
              "content-type": "application/json",
              "x-csrf-token": csrf,
            }),
      },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    const raw = await response.text();
    return {
      status: response.status,
      data: raw ? JSON.parse(raw) : undefined,
      response,
    };
  };
  const login = await request("/session/login", "POST", {
    username: "audit",
    password: "synthetic-audit-password",
  });
  assert.equal(login.status, 200);
  cookie = login.response.headers.get("set-cookie")!.split(";")[0];
  csrf = login.data.csrfToken;
  t.after(async () => {
    await generation.shutdown();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    app.close();
    rmSync(root, { recursive: true, force: true });
  });
  async function setup(config: any = {}) {
    const room = (await request("/rooms", "POST", { title: "Audit room" }))
      .data;
    const persona = (
      await request(`/rooms/${room.id}/personas`, "POST", {
        name: "Persona A",
        model: options.defaultModel ?? "synthetic",
        ...config,
      })
    ).data;
    assert.ok(persona.id);
    return { room, persona };
  }
  async function turn(room: any, key: string, extra: any = {}) {
    return request(`/rooms/${room.id}/turns`, "POST", {
      requestId: key,
      expectedRoomRevision: room.revision,
      content: "current input",
      recipient: { type: "all" },
      ...extra,
    });
  }
  async function done(roomId: string, runId: string) {
    for (let i = 0; i < 200; i++) {
      const result = await request(`/rooms/${roomId}/generations/${runId}`);
      if (!["QUEUED", "RUNNING"].includes(result.data.status))
        return result.data;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.fail("accepted run remained QUEUED/RUNNING in the same process");
  }
  return {
    app,
    actor,
    policy,
    repository,
    provider,
    generation,
    request,
    setup,
    turn,
    done,
  };
}
const oldPersona = (id: string) => ({
  id,
  name: "same name",
  model: "synthetic",
});
function archive() {
  return {
    sourceId: "deleted-persona-browser",
    rooms: [
      {
        id: "message-room",
        title: "Message only",
        agents: [oldPersona("live")],
        messages: [
          {
            id: "old-message",
            role: "model",
            agentId: "gone",
            content: "original",
            timestamp: 1234,
            segments: [
              {
                id: "public",
                channel: "public_message",
                visibility: "public",
                content: "original",
              },
              {
                id: "private",
                channel: "private_state",
                visibility: "self_only",
                content: "old private",
              },
            ],
          },
        ],
      },
      {
        id: "decision-room",
        title: "Decision only",
        agents: [],
        messages: [],
        decisionEvents: [
          {
            id: "d",
            turnId: "t",
            agentId: "gone",
            agentName: "same name",
            outcome: "IGNORE",
            source: "llm_decision",
            latencyMs: 1,
            timestamp: 1235,
          },
        ],
      },
      {
        id: "reaction-room",
        title: "Reaction only",
        agents: [],
        messages: [
          { id: "u", role: "user", content: "human", timestamp: 1236 },
        ],
        reactions: [
          {
            id: "r",
            turnId: "t",
            messageId: "u",
            agentId: "gone",
            semantic: "ACK",
            timestamp: 1237,
          },
        ],
      },
    ],
  };
}
test("PR38 F-01: deleted legacy speakers survive multi-room HTTP dry-run/import/replay/export without executable resurrection", async (t) => {
  const f = await fixture(t),
    input = archive();
  const preview = await f.request("/migrations/dry-run", "POST", input);
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  const imported = await f.request("/migrations/import", "POST", {
    ...input,
    requestId: "import",
  });
  assert.equal(imported.status, 200, JSON.stringify(imported.data));
  assert.equal(imported.data.status, "COMPLETE");
  for (const requestId of ["import", "alias"]) {
    const repeat = await f.request("/migrations/import", "POST", {
      ...input,
      requestId,
    });
    assert.equal(repeat.data.batchId, imported.data.batchId);
    assert.equal(repeat.data.status, "COMPLETE");
  }
  assert.equal(
    (await f.request("/migrations/dry-run", "POST", input)).status,
    200,
  );
  const map = imported.data.mappings;
  const identities = new Set<string>();
  for (const source of input.rooms) {
    const roomId = map.find(
      (m: any) => m.kind === "room" && m.sourceKey === source.id,
    ).targetId;
    const room = (await f.request(`/rooms/${roomId}`)).data;
    assert.equal(room.agents.length, source.agents.length);
    const historical = room.historicalPersonas;
    assert.equal(historical.length, 1);
    assert.equal(historical[0].legacyPersonaId, "gone");
    identities.add(historical[0].id);
    const edit = await f.request(
      `/rooms/${roomId}/personas/${historical[0].id}`,
      "PATCH",
      { expectedRevision: 1, isEnabled: true },
    );
    assert.notEqual(edit.status, 200);
    const denied = await f.request(`/rooms/${roomId}/turns`, "POST", {
      requestId: source.id,
      expectedRoomRevision: room.revision,
      content: "do not resurrect",
      recipient: { type: "agent", agentIds: [historical[0].id] },
    });
    assert.notEqual(denied.status, 202);
    const exported = await f.request(`/rooms/${roomId}/export`);
    assert.equal(exported.status, 200);
    assert.equal(
      exported.data.room.historicalPersonas[0].legacyPersonaId,
      "gone",
    );
    if (source.id === "message-room") {
      const m = exported.data.messages[0];
      assert.equal(m.occurredAt, 1234);
      assert.equal(m.revisions[0].segments[0].content, "original");
      assert.equal(m.legacySources[0].legacyId, "old-message");
      assert.equal(m.personaId, historical[0].id);
      assert.doesNotMatch(JSON.stringify(exported.data), /old private/);
      f.policy.grant(
        f.actor.actorId,
        f.actor.workspaceId,
        "READ_PRIVATE_SEGMENT",
        { roomId, personaId: historical[0].id, visibility: "self_only" },
      );
      assert.match(
        JSON.stringify((await f.request(`/rooms/${roomId}/export`)).data),
        /old private/,
      );
    } else if (source.id === "decision-room") {
      assert.equal(exported.data.legacyDecisions[0].timestamp, 1235);
      assert.equal(
        exported.data.legacyDecisions[0].legacySources[0].legacyId,
        "d",
      );
    } else {
      assert.equal(exported.data.legacyReactions[0].timestamp, 1237);
      assert.equal(
        exported.data.legacyReactions[0].legacySources[0].legacyId,
        "r",
      );
    }
  }
  assert.equal(identities.size, 3);
  assert.equal(f.provider.calls.length, 0);
  assert.equal(f.app.db.prepare("SELECT count(*) n FROM messages").get()!.n, 2);
  for (const field of ["role", "owner"]) {
    const forged: any = archive();
    if (field === "role") forged.rooms[0].messages[0].role = "admin";
    else forged.rooms[0].messages[0].owner = "admin";
    assert.notEqual(
      (await f.request("/migrations/dry-run", "POST", forged)).status,
      200,
    );
  }
});
test("PR38 F-02: actual HTTP failure after acceptance COMMIT before enqueue recovers one first execution", async (t) => {
  let throws = 0;
  const f = await fixture(t, {
    hooks: {
      afterAcceptCommit() {
        if (throws++ === 0) throw new Error("synthetic post-COMMIT failure");
      },
    },
  });
  const { room } = await f.setup();
  const failed = await f.turn(room, "same-request");
  assert.equal(failed.status, 500);
  assert.equal(f.provider.calls.length, 0);
  assert.equal(
    f.app.db.prepare("SELECT state FROM app_generation_runs").get()!.state,
    "QUEUED",
  );
  const retry = await f.turn(room, "same-request");
  assert.equal(retry.status, 202);
  assert.equal(retry.data.newlyAccepted, false);
  const receipt = await f.done(room.id, retry.data.runId);
  assert.equal(receipt.status, "COMPLETED");
  await f.turn(room, "same-request");
  assert.equal(
    f.app.db.prepare("SELECT count(*) n FROM app_turns").get()!.n,
    1,
  );
  assert.equal(
    f.app.db.prepare("SELECT count(*) n FROM app_generation_runs").get()!.n,
    1,
  );
  assert.equal(
    f.app.db.prepare("SELECT count(*) n FROM messages WHERE role='user'").get()!
      .n,
    1,
  );
  assert.equal(f.provider.calls.length, 1);
});
for (const mode of ["expired", "revoked"])
  test(`PR38 F-02: requeued acceptance rechecks ${mode} before any provider send`, async (t) => {
    let clock = Date.now(),
      injected = false;
    const f = await fixture(t, {
      now: () => clock,
      hooks: {
        afterAcceptCommit() {
          if (!injected) {
            injected = true;
            throw new Error("after COMMIT");
          }
        },
      },
    });
    const { room } = await f.setup();
    assert.equal((await f.turn(room, mode)).status, 500);
    if (mode === "expired") clock += 31000;
    else
      f.policy.revoke(f.actor.actorId, f.actor.workspaceId, "SEND_TO_PROVIDER");
    const retry = await f.turn(room, mode);
    assert.equal(retry.status, 202);
    assert.equal((await f.done(room.id, retry.data.runId)).status, "FAILED");
    assert.equal(f.provider.calls.length, 0);
  });
for (const state of ["DISPATCH_INTENT", "OUTCOME_UNKNOWN"])
  test(`PR38 F-02: HTTP retry never rebuilds dispatch from ${state}`, async (t) => {
    const f = await fixture(t, {
      hooks: {
        afterIntentCommit() {
          throw new Error("intent ACK failure");
        },
      },
    });
    const { room } = await f.setup();
    const first = await f.turn(room, "intent");
    assert.equal(
      (await f.done(room.id, first.data.runId)).status,
      "NEEDS_REVIEW",
    );
    // Even an inconsistent QUEUED record cannot turn a persisted intent into authority.
    f.app.db
      .prepare("UPDATE app_generation_runs SET state='QUEUED' WHERE run_id=?")
      .run(first.data.runId);
    f.app.db
      .prepare("UPDATE app_provider_calls SET state=? WHERE run_id=?")
      .run(state, first.data.runId);
    await f.turn(room, "intent");
    assert.equal(
      (await f.done(room.id, first.data.runId)).status,
      "NEEDS_REVIEW",
    );
    assert.equal(f.provider.calls.length, 0);
    assert.equal(
      f.app.db.prepare("SELECT count(*) n FROM app_provider_calls").get()!.n,
      1,
    );
  });
test("PR38 F-03: omitted legacy pinning agrees with old window semantics", () => {
  const input: any = {
    sourceId: "defaults",
    rooms: [{ id: "r", title: "r", agents: [oldPersona("p")], messages: [] }],
  };
  const p = prepareLegacy(input).rooms[0].personas[0].config;
  const messages: any = [
    { id: "first", role: "user" },
    { id: "last", role: "user" },
  ];
  assert.deepEqual(
    applyHistoryWindow(messages, { historyWindow: 1 } as any),
    applyHistoryWindow(messages, { ...p, historyWindow: 1 } as any),
  );
  assert.equal(p.framework, "standard");
  assert.equal(p.thinkingBudget, 0);
  assert.equal(p.historyWindow, 0);
});
test("PR38 F-03: framework-only requests preserve structured private debug semantics", async (t) => {
  const f = await fixture(t);
  for (const framework of ["standard", "cot", "react"]) {
    const { room } = await f.setup({ framework, pinFirstMessage: false });
    const accepted = await f.turn(room, framework);
    assert.equal(
      (await f.done(room.id, accepted.data.runId)).status,
      "COMPLETED",
    );
    const req = f.provider.calls.at(-1);
    if (framework === "standard")
      assert.doesNotMatch(req.systemInstruction, /For CoT|For ReAct/);
    else {
      assert.match(
        req.systemInstruction,
        framework === "cot" ? /For CoT/ : /For ReAct/,
      );
      assert.equal(req.structured, true);
      assert.match(req.systemInstruction, /debug_thoughts/);
    }
  }
});
const pinConflict = "HISTORY_WINDOW_PIN_CONFLICT";
async function currentAttachment(
  f: any,
  roomId: string,
  text = "current attachment marker",
) {
  const upload = await f.request(`/rooms/${roomId}/attachments`, "POST", {
    name: "current.txt",
    mimeType: "text/plain",
    data: Buffer.from(text).toString("base64"),
  });
  assert.equal(upload.status, 201);
  return upload.data.id;
}
function noCalls(f: any) {
  assert.equal(f.provider.calls.length, 0);
  assert.equal(
    f.app.db.prepare("SELECT count(*) n FROM app_provider_calls").get()!.n,
    0,
  );
}
for (const mode of ["text", "with-attachment", "attachment-only"])
  test(`PR38 F-03 follow-up: window one rejects displaced ${mode} input before reservation and preserves acceptance`, async (t) => {
    const f = await fixture(t),
      { room, persona } = await f.setup({
        historyWindow: 1,
        pinFirstMessage: true,
      });
    // Equal text still identifies two different Messages.
    f.repository.appendMessage(f.actor, room.id, {
      role: "user",
      content: "current input",
    });
    const attachmentIds =
      mode === "text" ? [] : [await currentAttachment(f, room.id)];
    const content = mode === "attachment-only" ? "" : "current input";
    const input = {
      content,
      attachmentIds,
      recipient: { type: mode === "with-attachment" ? "auto" : "all" },
    };
    const accepted = await f.turn(room, mode, input);
    assert.equal(accepted.status, 202);
    const result = await f.done(room.id, accepted.data.runId);
    assert.equal(result.status, "FAILED");
    assert.equal(result.errorCode, pinConflict);
    assert.equal(result.callCount, 0);
    assert.deepEqual(result.results, []);
    noCalls(f);
    const saved = f.repository.getMessage(
      f.actor,
      room.id,
      accepted.data.inputMessageId,
    );
    assert.equal(saved.content, content);
    assert.deepEqual(
      saved.attachments.map((a: any) => a.id),
      attachmentIds,
    );
    const run = f.app.db
      .prepare(
        "SELECT state,completed_at FROM app_generation_runs WHERE run_id=?",
      )
      .get(accepted.data.runId)!;
    assert.equal(run.state, "FAILED");
    assert.ok(run.completed_at);
    const again = await f.turn(room, mode, input);
    assert.equal(again.data.runId, accepted.data.runId);
    assert.equal(again.data.status, "FAILED");
    const cfg = (await f.request(`/rooms/${room.id}/personas/${persona.id}`))
      .data;
    assert.equal(cfg.historyWindow, 1);
    assert.equal(cfg.pinFirstMessage, true);
    assert.equal(
      f.app.db.prepare("SELECT count(*) n FROM app_generation_runs").get()!.n,
      1,
    );
    assert.equal(
      f.app.db
        .prepare("SELECT count(*) n FROM messages WHERE role='user'")
        .get()!.n,
      2,
    );
    noCalls(f);
  });
for (const pinFirstMessage of [false, true])
  for (const attached of [false, true])
    test(`PR38 F-03 follow-up: window one keeps current input with pin=${pinFirstMessage}, attachment=${attached}`, async (t) => {
      const f = await fixture(t),
        { room } = await f.setup({ historyWindow: 1, pinFirstMessage });
      if (!pinFirstMessage)
        f.repository.appendMessage(f.actor, room.id, {
          role: "user",
          content: "old anchor",
        });
      const attachmentIds = attached
        ? [await currentAttachment(f, room.id)]
        : [];
      const content = attached ? "" : "current input";
      const accepted = await f.turn(room, "compatible", {
        content,
        attachmentIds,
      });
      const result = await f.done(room.id, accepted.data.runId);
      assert.equal(result.status, "COMPLETED");
      assert.equal(f.provider.calls.length, 1);
      const request = f.provider.calls[0],
        history = JSON.parse(request.contents[0].parts[0].text);
      assert.equal(history.messageId, accepted.data.inputMessageId);
      assert.doesNotMatch(JSON.stringify(request.contents), /old anchor/);
      assert.match(
        JSON.stringify(request.contents),
        attached ? /current attachment marker/ : /current input/,
      );
    });
test("PR38 F-03 follow-up: import/save/read retains window-one pin settings while generation fails explicitly", async (t) => {
  const f = await fixture(t),
    input = {
      sourceId: "pin-legacy",
      rooms: [
        {
          id: "r",
          title: "Retained legacy settings",
          agents: [
            { ...oldPersona("p"), historyWindow: 1, pinFirstMessage: true },
          ],
          messages: [
            {
              id: "u",
              role: "user",
              content: "legacy anchor",
              timestamp: 1234,
            },
          ],
        },
      ],
    };
  assert.equal(
    (await f.request("/migrations/dry-run", "POST", input)).status,
    200,
  );
  const imported = await f.request("/migrations/import", "POST", {
    ...input,
    requestId: "pin-import",
  });
  assert.equal(imported.status, 200);
  assert.equal(imported.data.status, "COMPLETE");
  const roomId = imported.data.mappings.find(
    (m: any) => m.kind === "room",
  ).targetId;
  const room = (await f.request(`/rooms/${roomId}`)).data,
    persona = room.agents[0];
  assert.equal(persona.historyWindow, 1);
  assert.equal(persona.pinFirstMessage, true);
  const saved = await f.request(
    `/rooms/${roomId}/personas/${persona.id}`,
    "PATCH",
    {
      expectedRevision: persona.revision,
      historyWindow: 1,
      pinFirstMessage: true,
    },
  );
  assert.equal(saved.status, 200);
  assert.equal(saved.data.historyWindow, 1);
  assert.equal(saved.data.pinFirstMessage, true);
  assert.equal(
    (await f.request(`/rooms/${roomId}/messages`)).data.messages[0].content,
    "legacy anchor",
  );
  const accepted = await f.turn(room, "imported-settings");
  assert.equal(
    (await f.done(roomId, accepted.data.runId)).errorCode,
    pinConflict,
  );
  noCalls(f);
});
test("PR38 F-03 follow-up: window two retains corrected eligible anchor and current attachment, excluding deleted originals", async (t) => {
  const f = await fixture(t),
    { room } = await f.setup({ historyWindow: 2, pinFirstMessage: true });
  const deleted = f.repository.appendMessage(f.actor, room.id, {
    role: "user",
    content: "deleted anchor",
  });
  f.repository.deleteMessage(f.actor, room.id, deleted.id, {
    expectedRevision: 1,
  });
  const anchor = f.repository.appendMessage(f.actor, room.id, {
    role: "user",
    content: "obsolete anchor",
  });
  f.repository.correctMessage(f.actor, room.id, anchor.id, {
    expectedRevision: 1,
    content: "corrected anchor",
  });
  f.repository.appendMessage(f.actor, room.id, {
    role: "user",
    content: "discarded middle",
  });
  const accepted = await f.turn(room, "two-slots", {
    attachmentIds: [await currentAttachment(f, room.id)],
  });
  assert.equal(
    (await f.done(room.id, accepted.data.runId)).status,
    "COMPLETED",
  );
  const request = f.provider.calls[0];
  assert.deepEqual(
    request.contents.map((c: any) => JSON.parse(c.parts[0].text).messageId),
    [anchor.id, accepted.data.inputMessageId],
  );
  assert.match(JSON.stringify(request), /corrected anchor/);
  assert.match(JSON.stringify(request), /current input/);
  assert.match(JSON.stringify(request), /current attachment marker/);
  assert.doesNotMatch(
    JSON.stringify(request),
    /deleted anchor|obsolete anchor|discarded middle/,
  );
});
for (const boundary of ["delete", "correct", "acl"])
  test(`PR38 F-03 follow-up: window two rechecks ${boundary} after compiling pinned context with attachments`, async (t) => {
    let change = () => {};
    const f = await fixture(t, {
        hooks: {
          afterContext() {
            change();
          },
        },
      }),
      { room } = await f.setup({ historyWindow: 2, pinFirstMessage: true });
    const anchor = f.repository.appendMessage(f.actor, room.id, {
      role: "user",
      content: "pinned anchor",
    });
    change = () => {
      if (boundary === "delete")
        f.repository.deleteMessage(f.actor, room.id, anchor.id, {
          expectedRevision: 1,
        });
      else if (boundary === "correct")
        f.repository.correctMessage(f.actor, room.id, anchor.id, {
          expectedRevision: 1,
          content: "changed anchor",
        });
      else
        f.policy.revoke(
          f.actor.actorId,
          f.actor.workspaceId,
          "SEND_TO_PROVIDER",
        );
    };
    const accepted = await f.turn(room, boundary, {
      attachmentIds: [await currentAttachment(f, room.id)],
    });
    const result = await f.done(room.id, accepted.data.runId);
    assert.equal(result.status, "FAILED");
    assert.equal(
      result.errorCode,
      boundary === "acl" ? "GENERATION_FAILED" : "CONTEXT_CHANGED",
    );
    assert.equal(f.provider.calls.length, 0);
    const calls = f.app.db
      .prepare("SELECT state,dispatched_at FROM app_provider_calls")
      .all();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].state, "RESERVED");
    assert.equal(calls[0].dispatched_at, null);
    assert.equal(
      f.repository.getMessage(f.actor, room.id, accepted.data.inputMessageId)
        .content,
      "current input",
    );
  });
for (const kind of ["history", "tokens"])
  test(`PR38 F-03 follow-up: pinning never bypasses host ${kind} limit with current attachments`, async (t) => {
    const f = await fixture(t, {
        limits:
          kind === "history" ? { maxHistory: 1 } : { maxInputTokens: 1024 },
      }),
      { room } = await f.setup({ historyWindow: 2, pinFirstMessage: true });
    f.repository.appendMessage(f.actor, room.id, {
      role: "user",
      content: "first anchor",
    });
    const accepted = await f.turn(room, kind, {
      attachmentIds: [
        await currentAttachment(
          f,
          room.id,
          kind === "tokens"
            ? "bounded ".repeat(1000)
            : "current attachment marker",
        ),
      ],
    });
    const result = await f.done(room.id, accepted.data.runId);
    assert.equal(result.status, "FAILED");
    assert.equal(
      result.errorCode,
      kind === "history" ? pinConflict : "CONTEXT_LIMIT",
    );
    noCalls(f);
  });
test("PR38 F-03: unsupported or over-host thinking fails before dispatch rather than ignoring the setting", async (t) => {
  let sends = 0;
  const provider = new GeminiProvider({
    apiKey: "synthetic",
    allowedModels: [
      "gemini-2.0-flash",
      "gemini-3-pro-preview",
      "gemini-2.5-flash",
    ],
    fetch: async () => {
      sends++;
      throw new Error("must not send");
    },
  });
  const f = await fixture(t, {
    provider,
    defaultModel: "gemini-2.0-flash",
    pricing: {
      version: "synthetic",
      inputMicrosPerMillion: 1,
      outputMicrosPerMillion: 1,
    },
  });
  for (const [model, thinkingBudget] of [
    ["gemini-2.0-flash", 512],
    ["gemini-3-pro-preview", 512],
    ["gemini-2.5-flash", 4096],
  ] as const) {
    const { room } = await f.setup({ model, thinkingBudget });
    const accepted = await f.turn(room, model.replaceAll(".", "_"));
    assert.equal(accepted.status, 202);
    const result = await f.done(room.id, accepted.data.runId);
    assert.equal(result.status, "FAILED");
    assert.match(JSON.stringify(result), /THINKING_BUDGET_(UNSUPPORTED|LIMIT)/);
  }
  assert.equal(sends, 0);
  assert.equal(
    f.app.db.prepare("SELECT count(*) n FROM app_provider_calls").get()!.n,
    0,
  );
});
test("PR38 F-03: pin outside history window and each framework change actual generated requests", async (t) => {
  const f = await fixture(t);
  for (const framework of ["standard", "cot", "react"]) {
    const { room } = await f.setup({
      historyWindow: 2,
      pinFirstMessage: true,
      framework,
    });
    for (const content of [
      "first anchor",
      "discarded middle",
      "recent previous",
    ])
      f.repository.appendMessage(f.actor, room.id, { role: "user", content });
    const accept = await f.turn(room, framework);
    assert.equal(accept.status, 202);
    assert.equal(
      (await f.done(room.id, accept.data.runId)).status,
      "COMPLETED",
    );
    const req = f.provider.calls.at(-1);
    assert.match(JSON.stringify(req.contents), /first anchor/);
    assert.match(JSON.stringify(req.contents), /current input/);
    assert.doesNotMatch(
      JSON.stringify(req.contents),
      /discarded middle|recent previous/,
    );
    if (framework !== "standard") {
      assert.match(
        req.systemInstruction,
        framework === "cot" ? /For CoT/ : /For ReAct/,
      );
      assert.equal(req.structured, true);
    } else assert.doesNotMatch(req.systemInstruction, /For CoT|For ReAct/);
  }
});
test("PR38 F-03: Persona and worker thinking settings reach actual loopback HTTP generationConfig", async (t) => {
  const bodies: any[] = [];
  const receiver = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const value = JSON.parse(raw);
    bodies.push(value);
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                {
                  text:
                    value.generationConfig.responseMimeType ===
                    "application/json"
                      ? JSON.stringify({
                          public_message: "synthetic result",
                          debug_thoughts: "private framework summary",
                        })
                      : "synthetic result",
                },
              ],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 5,
          totalTokenCount: 15,
        },
      }),
    );
  });
  await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>((r) => receiver.close(() => r())));
  const provider = new GeminiProvider({
    apiKey: "synthetic",
    allowedModels: ["gemini-2.5-flash"],
    fetch: async (_url, init) =>
      fetch(`http://127.0.0.1:${(receiver.address() as any).port}`, init),
  });
  const f = await fixture(t, {
    provider,
    defaultModel: "gemini-2.5-flash",
    pricing: {
      version: "synthetic",
      inputMicrosPerMillion: 1,
      outputMicrosPerMillion: 1,
    },
  });
  const { room } = await f.setup({
    thinkingBudget: 1024,
    subAgentPolicy: { mode: "fixed_serial" },
    subAgents: [
      {
        id: "worker",
        name: "worker",
        description: "",
        provider: "google",
        model: "gemini-2.5-flash",
        systemInstruction: "private worker",
        capabilities: [],
        isEnabled: true,
        thinkingBudget: 512,
        maxOutputTokens: 2048,
        maxCallsPerTurn: 1,
      },
    ],
  });
  const accepted = await f.turn(room, "thinking");
  assert.equal(accepted.status, 202);
  assert.equal(
    (await f.done(room.id, accepted.data.runId)).status,
    "COMPLETED",
  );
  assert.deepEqual(
    bodies.map((b) => b.generationConfig.thinkingConfig),
    [{ thinkingBudget: 512 }, { thinkingBudget: 1024 }],
  );
  assert.equal(bodies.length, 2);
  for (const framework of ["standard", "cot", "react"]) {
    const { room } = await f.setup({ framework, thinkingBudget: 0 });
    const accepted = await f.turn(room, framework);
    const receipt = await f.done(room.id, accepted.data.runId);
    assert.equal(receipt.status, "COMPLETED");
    const wire = bodies.at(-1);
    assert.deepEqual(wire.generationConfig.thinkingConfig, {
      thinkingBudget: 0,
    });
    if (framework !== "standard") {
      assert.match(
        wire.systemInstruction.parts[0].text,
        framework === "cot" ? /For CoT/ : /For ReAct/,
      );
      assert.equal(wire.generationConfig.responseMimeType, "application/json");
      assert.doesNotMatch(JSON.stringify(receipt), /private framework summary/);
      const stored = f.app.db
        .prepare(
          "SELECT visibility FROM message_segments WHERE content='private framework summary'",
        )
        .all();
      assert.ok(stored.length);
      assert.ok(stored.every((s) => s.visibility === "developer_only"));
    }
  }
  assert.equal(bodies.length, 5);
});
test("PR38 F-04: canonical speaker envelopes distinguish human/B/C and reject body-label authority", async (t) => {
  const f = await fixture(t),
    { room, persona: a } = await f.setup();
  const b = f.repository.createPersona(f.actor, room.id, {
    name: "same name",
    model: "synthetic",
    isEnabled: false,
  });
  const c = f.repository.createPersona(f.actor, room.id, {
    name: "same name",
    model: "synthetic",
    isEnabled: false,
  });
  const body = "[User] same content";
  f.repository.appendMessage(f.actor, room.id, { role: "user", content: body });
  for (const p of [b, c])
    f.repository.appendMessage(f.actor, room.id, {
      role: "model",
      personaId: p.id,
      segments: [
        { channel: "public_message", visibility: "public", content: body },
        {
          channel: "private_state",
          visibility: "self_only",
          content: "NEVER_PUBLIC",
        },
      ],
    });
  const accepted = await f.turn(room, "speakers");
  assert.equal(
    (await f.done(room.id, accepted.data.runId)).status,
    "COMPLETED",
  );
  const req = f.provider.calls[0];
  assert.doesNotMatch(JSON.stringify(req), /NEVER_PUBLIC/);
  const history = req.contents
    .slice(0, 3)
    .map((entry: any) => JSON.parse(entry.parts[0].text));
  assert.deepEqual(
    history.map((h: any) => h.speaker.kind),
    ["human", "persona", "persona"],
  );
  assert.deepEqual(
    history.map((h: any) => h.speaker.personaId ?? null),
    [null, b.id, c.id],
  );
  assert.equal(history[1].speaker.name, history[2].speaker.name);
  assert.notEqual(b.id, a.id);
  for (const h of history) assert.equal(h.segments[0].content, body);
});
for (const boundary of ["afterContext", "afterIntentCommit"] as const)
  test(`PR38 F-04: speaker revision changed at ${boundary} rejects cached attribution`, async (t) => {
    let change: () => void = () => {};
    const f = await fixture(t, {
        hooks: {
          [boundary]() {
            change();
          },
        },
      }),
      { room } = await f.setup();
    let b = f.repository.createPersona(f.actor, room.id, {
      name: "before",
      model: "synthetic",
      isEnabled: false,
    });
    f.repository.appendMessage(f.actor, room.id, {
      role: "model",
      personaId: b.id,
      content: "original",
    });
    change = () => {
      b = f.repository.updatePersona(f.actor, room.id, b.id, {
        expectedRevision: b.revision,
        name: "after",
      });
    };
    const accepted = await f.turn(room, "speaker-revision");
    assert.equal(
      (await f.done(room.id, accepted.data.runId)).status,
      boundary === "afterIntentCommit" ? "NEEDS_REVIEW" : "FAILED",
    );
    assert.equal(f.provider.calls.length, 0);
  });
