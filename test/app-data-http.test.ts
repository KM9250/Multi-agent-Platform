import assert from "node:assert/strict";
import test from "node:test";
import { createServer, request as httpRequest } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../server/app-data/db.ts";
import { ConversationRepository } from "../server/app-data/repository.ts";
import { AttachmentStore } from "../server/attachments/store.ts";
import { SessionService } from "../server/auth/sessions.ts";
import { AuthorizationPolicy } from "../server/auth/authorization.ts";
import { createAppHandler } from "../server/http/server.ts";
import { GenerationCoordinator } from "../server/generation/coordinator.ts";
import { FakeProvider } from "../server/generation/provider.ts";

async function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), "map-http-")),
    app = new AppDatabase({ root }),
    sessions = new SessionService(app),
    policy = new AuthorizationPolicy(app);
  const actor = await sessions.createAccount({
    username: "synthetic-user",
    password: "synthetic-long-password",
  });
  const repository = new ConversationRepository(app, policy),
    attachments = new AttachmentStore(app, policy),
    provider = new FakeProvider();
  const generation = new GenerationCoordinator(app, repository, policy, {
    provider,
    defaultModel: "synthetic",
    attachmentStore: attachments,
  });
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  server.on(
    "request",
    createAppHandler({
      app,
      sessions,
      policy,
      repository,
      attachments,
      generation,
      origin,
      development: true,
      allowedModels: ["synthetic"],
    }),
  );
  t.after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    app.close();
    rmSync(root, { recursive: true, force: true });
  });
  let cookie = "",
    csrf = "";
  const request = async (
    path: string,
    method = "GET",
    input?: any,
    extra: Record<string, string> = {},
  ) => {
    const response = await fetch(origin + "/api/app/v1" + path, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(method !== "GET"
          ? { "content-type": "application/json", origin, "x-csrf-token": csrf }
          : {}),
        ...extra,
      },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    const text = await response.text();
    return { response, data: text ? JSON.parse(text) : undefined };
  };
  const login = async () => {
    const result = await request("/session/login", "POST", {
      username: "synthetic-user",
      password: "synthetic-long-password",
    });
    assert.equal(result.response.status, 200);
    cookie = result.response.headers.get("set-cookie")!.split(";")[0];
    csrf = result.data.csrfToken;
    return result;
  };
  return {
    app,
    actor,
    policy,
    repository,
    provider,
    generation,
    origin,
    request,
    login,
    get cookie() {
      return cookie;
    },
    get csrf() {
      return csrf;
    },
  };
}

test("HTTP login, server generation, ACK retry, attachment, reconnect and logout use real cookies and persistence", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request("/rooms")).response.status, 401);
  const login = await f.login();
  assert.match(login.response.headers.get("set-cookie")!, /HttpOnly/);
  assert.match(login.response.headers.get("set-cookie")!, /SameSite=Strict/);
  assert.equal(login.response.headers.get("cache-control"), "no-store");
  const created = await f.request("/rooms", "POST", { title: "HTTP Room" });
  assert.equal(created.response.status, 201);
  const room = created.data;
  const persona = await f.request(`/rooms/${room.id}/personas`, "POST", {
    name: "HTTP Persona",
    model: "synthetic",
  });
  assert.equal(persona.response.status, 201);
  const upload = await f.request(`/rooms/${room.id}/attachments`, "POST", {
    name: "sample.txt",
    mimeType: "text/plain",
    data: Buffer.from("attachment canary").toString("base64"),
  });
  assert.equal(upload.response.status, 201);
  const turn = {
    requestId: "http-turn-request",
    expectedRoomRevision: room.revision,
    content: "hello synthetic",
    attachmentIds: [upload.data.id],
    recipient: { type: "all", agentIds: [persona.data.id] },
  };
  const first = await f.request(`/rooms/${room.id}/turns`, "POST", turn);
  assert.equal(first.response.status, 202);
  const repeat = await f.request(`/rooms/${room.id}/turns`, "POST", turn);
  assert.equal(repeat.data.runId, first.data.runId);
  let receipt: any;
  for (let i = 0; i < 100; i++) {
    receipt = await f.request(
      `/rooms/${room.id}/generations/${first.data.runId}`,
    );
    if (!["QUEUED", "RUNNING"].includes(receipt.data.status)) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(receipt.data.status, "COMPLETED", JSON.stringify(receipt.data));
  const page = await f.request(`/rooms/${room.id}/messages`);
  assert.equal(page.response.status, 200, JSON.stringify(page.data));
  assert.equal(page.data.messages.length, 2);
  assert.equal(page.data.messages[0].content, "hello synthetic");
  assert.equal(page.data.messages[1].content, "Synthetic server response.");
  const before = f.provider.calls.length;
  const secondSession = await f.login();
  assert.equal(secondSession.data.actorId, f.actor.actorId);
  assert.deepEqual(
    (await f.request(`/rooms/${room.id}/messages`)).data,
    page.data,
  );
  assert.equal(f.provider.calls.length, before);
  const original = await fetch(f.origin + upload.data.url, {
    headers: { cookie: f.cookie },
  });
  assert.equal(original.status, 200);
  assert.equal(await original.text(), "attachment canary");
  const logout = await f.request("/session/logout", "POST", {});
  assert.equal(logout.response.status, 200);
  assert.equal(
    (await f.request(`/rooms/${room.id}/messages`)).response.status,
    401,
  );
  assert.equal(
    (await fetch(f.origin + upload.data.url, { headers: { cookie: f.cookie } }))
      .status,
    401,
  );
  assert.equal(f.provider.calls.length, before);
});

test("HTTP forgery, CSRF, unknown fields, stale revisions, cross-room grants and deleted originals reject before effects", async (t) => {
  const f = await fixture(t);
  await f.login();
  const before = Number(
    f.app.db.prepare("SELECT count(*) AS n FROM rooms").get()!.n,
  );
  for (const headers of [
    { "x-csrf-token": "wrong" },
    { origin: "https://attacker.invalid" },
  ])
    assert.equal(
      (await f.request("/rooms", "POST", { title: "forged" }, headers)).response
        .status,
      403,
    );
  const hostStatus = await new Promise<number>((resolve, reject) => {
    const req = httpRequest(
      f.origin + "/api/app/v1/rooms",
      {
        method: "POST",
        headers: {
          host: "attacker.invalid",
          origin: f.origin,
          cookie: f.cookie,
          "x-csrf-token": f.csrf,
          "content-type": "application/json",
        },
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode!));
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify({ title: "forged" }));
  });
  assert.equal(hostStatus, 403);
  const injected = await f.request("/rooms", "POST", {
    title: "injected",
    isAdmin: true,
  });
  assert.equal(injected.response.status, 400);
  assert.equal(
    f.app.db.prepare("SELECT count(*) AS n FROM rooms").get()!.n,
    before,
  );
  const room = (await f.request("/rooms", "POST", { title: "valid" })).data;
  assert.equal(
    (
      await f.request(`/rooms/${room.id}`, "PATCH", {
        expectedRevision: room.revision,
        title: "updated",
      })
    ).response.status,
    200,
  );
  assert.equal(
    (
      await f.request(`/rooms/${room.id}`, "PATCH", {
        expectedRevision: room.revision,
        title: "stale",
      })
    ).response.status,
    409,
  );
  const current = (await f.request(`/rooms/${room.id}`)).data;
  assert.equal(current.title, "updated");
  const bad = await f.request(`/rooms/${room.id}/personas`, "POST", {
    name: "bad",
    providerUrl: "https://attacker.invalid",
  });
  assert.equal(bad.response.status, 400);
  assert.equal(bad.data.error.code, "UNKNOWN_FIELD");
  assert.equal(f.provider.calls.length, 0);
  const message = f.repository.appendMessage(f.actor, room.id, {
    role: "user",
    content: "original beyond the history window",
  });
  for (let revision = 1; revision <= 201; revision++) {
    f.repository.correctMessage(f.actor, room.id, message.id, {
      expectedRevision: revision,
      content: `correction ${revision}`,
    });
  }
  const messagePath = `/rooms/${room.id}/messages/${message.id}`;
  const history = await f.request(`${messagePath}/history`);
  assert.equal(history.data.length, 200);
  assert.ok(history.data.every((entry: any) => entry.revision > 1));
  const original = await f.request(`${messagePath}/revisions/1`);
  assert.equal(original.response.status, 200);
  assert.equal(original.data.content, "original beyond the history window");
  assert.equal(original.data.revision, 1);
  assert.equal(
    (await f.request(`${messagePath}/revisions/0`)).response.status,
    400,
  );
  const removed = await f.request(messagePath, "DELETE", {
    expectedRevision: 202,
  });
  assert.equal(removed.response.status, 200);
  const deletedOriginal = await f.request(`${messagePath}/revisions/1`);
  assert.equal(deletedOriginal.response.status, 404);
  assert.deepEqual(deletedOriginal.data, { error: { code: "NOT_FOUND" } });
  assert.equal(f.provider.calls.length, 0);
  const roomCount = f.app.db.prepare("SELECT count(*) AS n FROM rooms").get()!
    .n;
  f.policy.revoke(f.actor.actorId, f.actor.workspaceId, "READ_ROOM");
  assert.equal((await f.request(`/rooms/${room.id}`)).response.status, 403);
  assert.equal(
    f.app.db.prepare("SELECT count(*) AS n FROM rooms").get()!.n,
    roomCount,
  );
  assert.equal(f.provider.calls.length, 0);
});

test("memory HTTP isolates owner rows, direct ID lookups and original private material", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request("/memory/vault")).response.status, 401);
  const login = await f.login();
  assert.deepEqual(login.data.memoryLimits, {
    maxCalls: f.generation.limits.maxCalls,
    maxTotalTokens: f.generation.limits.maxTotalTokens,
    maxHistory: f.generation.limits.maxHistory,
  });
  const room = f.repository.createRoom(f.actor, {
    title: "Synthetic memories",
    internalStateSettings: { enabled: true },
  });
  const a = f.repository.createPersona(f.actor, room.id, {
    name: "One",
    model: "synthetic",
  });
  const b = f.repository.createPersona(f.actor, room.id, {
    name: "Two",
    model: "synthetic",
  });
  const scope = (personaId: string) => ({
    roomId: room.id,
    personaId,
    visibility: "persona_private",
  });
  for (const persona of [a, b])
    f.policy.grant(
      f.actor.actorId,
      f.actor.workspaceId,
      "PROPOSE_MEMORY",
      scope(persona.id),
    );
  const run = f.generation.accept(f.actor, room.id, {
    requestId: "http-memory-owner-1",
    expectedRoomRevision: f.repository.getRoom(f.actor, room.id).revision,
    content: " /memory ",
  });
  await f.generation.execute(run.runId);
  const candidates = f.app.db
    .prepare(
      "SELECT candidate_id,owner_persona_id FROM memory_candidates ORDER BY candidate_id",
    )
    .all();
  assert.equal(candidates.length, 2);
  const prefix = `/rooms/${room.id}/memory`;
  const privateList = await f.request(prefix + "/candidates");
  assert.equal(privateList.response.status, 200);
  assert.deepEqual(privateList.data.items, []);
  f.policy.grant(
    f.actor.actorId,
    f.actor.workspaceId,
    "READ_MEMORY",
    scope(a.id),
  );
  const allowed = await f.request(prefix + "/candidates");
  assert.equal(allowed.response.status, 200);
  assert.equal(allowed.response.headers.get("cache-control"), "no-store");
  assert.equal(allowed.data.items.length, 1);
  assert.equal(allowed.data.items[0].ownerPersonaId, a.id);
  const sourcePath =
    prefix + "/candidates/" + allowed.data.items[0].id + "/source";
  const deniedSource = await f.request(sourcePath);
  assert.equal(deniedSource.response.status, 404);
  assert.ok(
    !JSON.stringify(deniedSource.data).includes(allowed.data.items[0].body),
  );
  f.policy.grant(f.actor.actorId, f.actor.workspaceId, "READ_PRIVATE_SEGMENT", {
    roomId: room.id,
    personaId: a.id,
    visibility: "self_only",
  });
  const source = await f.request(sourcePath);
  assert.equal(source.response.status, 200);
  assert.equal(source.data.body, allowed.data.items[0].body);
  const hidden = candidates.find((row) => row.owner_persona_id === b.id)!;
  const hiddenResult = await f.request(
    prefix + "/candidates/" + hidden.candidate_id,
  );
  const absentResult = await f.request(prefix + "/candidates/absent");
  assert.equal(hiddenResult.response.status, 404);
  assert.deepEqual(hiddenResult.data, absentResult.data);
  const wrongRoom = await f.request(
    "/rooms/other-room/memory/candidates/" + allowed.data.items[0].id,
  );
  assert.equal(wrongRoom.response.status, 404);
  const publicPage = await f.request(`/rooms/${room.id}/messages`);
  assert.ok(
    !JSON.stringify(publicPage.data).includes(allowed.data.items[0].body),
  );
  assert.equal((await f.request("/memory/vault")).response.status, 403);
  f.policy.grant(f.actor.actorId, f.actor.workspaceId, "MANAGE_VAULT");
  assert.deepEqual((await f.request("/memory/vault")).data, {
    registered: false,
    paused: true,
    trustNew: false,
  });
  assert.equal(
    (await f.request(prefix + "/candidates/" + hidden.candidate_id)).response
      .status,
    404,
  );
  const review = {
    requestId: "http-memory-review",
    decision: "approve",
    items: [allowed.data.items[0].binding],
  };
  for (const headers of [
    { "x-csrf-token": "wrong" },
    { origin: "https://other.example" },
  ]) {
    const rejected = await f.request(
      prefix + "/reviews",
      "POST",
      review,
      headers,
    );
    assert.equal(rejected.response.status, 403);
  }
  assert.equal(
    (await f.request(prefix + "/reviews", "POST", review)).response.status,
    403,
  );
  assert.equal(
    f.app.db.prepare("SELECT COUNT(*) n FROM memory_jobs").get()!.n,
    0,
  );
  assert.equal(f.provider.calls.length, 2);
  f.app.db
    .prepare("UPDATE memory_candidates SET state='CONFLICT' WHERE room_id=?")
    .run(room.id);
  const conflicts = await f.request(prefix + "/conflicts");
  assert.equal(conflicts.response.status, 200);
  assert.deepEqual(
    conflicts.data.publications.map((item: any) => item.candidateId),
    [allowed.data.items[0].id],
  );
  assert.ok(
    !JSON.stringify(conflicts.data).includes(String(hidden.candidate_id)),
  );
});
