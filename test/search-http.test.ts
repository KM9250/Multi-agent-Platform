import assert from "node:assert/strict";
import test from "node:test";
import { httpFixture } from "./http-fixture.ts";
import { requestIndexUpdate } from "../server/search/index.ts";
import { searchInput } from "../server/search/input.ts";
import { searchRoom } from "../server/search/service.ts";

test("HTTP S-01–06/08/09/11: compare near-day evidence before the candidate cap, then open the exact authorized version", async (t) => {
  const f = await httpFixture(t);
  await f.login();
  const room = f.repository.createRoom(f.actor, { title: "検索" });
  const other = f.repository.createRoom(f.actor, { title: "他の部屋" });
  const url = "/rooms/" + room.id + "/search";
  const origin = "https://different.invalid";
  const post = (input: Record<string, unknown>) =>
    f.request(url, "POST", {
      requestId: crypto.randomUUID(),
      query: "設計 呼称",
      target: "archive",
      ...input,
    });
  const base = {
    mode: "approx",
    anchorDate: "2026-11-11",
    timeZone: "Asia/Tokyo",
  };
  const save = (day: string, content: string) =>
    f.repository.appendMessage(f.actor, room.id, {
      role: "user",
      content,
      occurredAt: Date.parse(day + "T12:00:00+09:00"),
    });
  const exact = "😺\r\n設計 呼称：Cafe\u0301";
  const primary = save("2026-11-05", exact);
  const alternate = save("2026-11-09", "会議で設計 呼称を確認");
  f.app.transaction(() => {
    for (let i = 0; i < 110; i++) save("2026-11-11", "設計だけを話した " + i);
  });
  f.repository.appendMessage(f.actor, other.id, {
    role: "user",
    content: "設計 呼称 private-other-room",
  });
  assert.equal(
    (await f.request(url, "POST", {}, { origin })).response.status,
    403,
  );
  assert.equal(
    (await f.request(url, "POST", {}, { "x-csrf-token": "invalid" })).response
      .status,
    403,
  );
  assert.equal((await post({ actorId: "intruder" })).response.status, 400);
  assert.equal(
    (await post({ target: "memory", date: base })).response.status,
    400,
  );
  const cold = await post({ date: base });
  assert.equal(cold.data.status, "unbuilt");
  await requestIndexUpdate(f.app, f.policy, f.actor, room.id);
  const nearby = await post({ date: base, limit: 2 });
  assert.equal(nearby.response.status, 200, JSON.stringify(nearby.data));
  assert.equal(nearby.response.headers.get("cache-control"), "no-store");
  assert.deepEqual(nearby.data.methods, ["lexical"]);
  assert.deepEqual(
    [nearby.data.scope.date.firstDate, nearby.data.scope.date.lastDate],
    ["2026-11-04", "2026-11-18"],
  );
  const hits = nearby.data.results;
  assert.deepEqual(
    new Set(hits.map((h) => h.citation.messageId)),
    new Set([primary.id, alternate.id]),
    JSON.stringify(nearby.data),
  );
  assert.deepEqual(
    new Set(hits.map((h) => h.dateLayer)),
    new Set(["near3", "near7"]),
  );
  const first = hits.find((h) => h.citation.messageId === primary.id);
  assert.equal(
    first.snippet,
    exact.slice(first.citation.start, first.citation.end),
  );
  assert.ok(!JSON.stringify(nearby.data).includes("private-other-room"));
  const strict = await post({ date: { ...base, mode: "strict" } });
  assert.ok(strict.data.results.length);
  assert.ok(strict.data.results.every((h) => h.snippet.includes("だけ")));
  const memory = await post({ target: "memory", query: "呼称" });
  assert.equal(memory.data.scope.target, "memory");
  assert.deepEqual(memory.data.results, []);
  assert.equal(memory.data.external.calls, 0);
  const cite = (p: Record<string, unknown> = {}) =>
    f.request(url + "/citation", "POST", { citation: first.citation, ...p });
  assert.equal((await cite({ surrounding: true })).data.text, first.snippet);
  const forged = await f.request(
    "/rooms/" + other.id + "/search/citation",
    "POST",
    { citation: first.citation },
  );
  assert.equal(forged.response.status, 404);
  f.repository.correctMessage(f.actor, room.id, primary.id, {
    expectedRevision: 1,
    content: "書き直した事務連絡",
  });
  assert.equal((await cite()).data.error.code, "SOURCE_CHANGED");
  const historical = await cite({ includeHistory: true });
  assert.equal(historical.data.current, false);
  assert.equal(historical.data.revisionKind, "original");
  assert.equal(historical.data.text, first.snippet);
  const req = searchInput({
    target: "archive",
    query: "猫",
    requestId: crypto.randomUUID(),
  });
  await assert.rejects(
    searchRoom(f.app, f.policy, f.actor, room.id, req, {
      purpose: "ai_context",
      roomId: room.id,
      scope: "archive",
      consumerPersonaId: "other",
      destination: "external",
      externalPurpose: "RERANK",
    }),
    /FORBIDDEN/,
  );
  await requestIndexUpdate(f.app, f.policy, f.actor, room.id, { force: true });
  const current = await post({ query: "Café" });
  assert.equal(current.data.results.length, 0);
  const history = await post({
    query: "Café",
    revisionMode: "include_history",
  });
  assert.ok(
    history.data.results.some(
      (h) => !h.current && h.citation.messageId === primary.id,
    ),
    JSON.stringify(history.data),
  );
  f.repository.deleteMessage(f.actor, room.id, primary.id, {
    expectedRevision: 2,
  });
  assert.equal((await cite({ includeHistory: true })).response.status, 404);
  f.policy.revoke(f.actor.actorId, f.actor.workspaceId, "READ_CONVERSATION");
  assert.equal((await post({})).response.status, 403);
});
