import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { httpFixture } from "./http-fixture.ts";

test("context HTTP accepts revisioned defaults and turns, rejects forged trusted bindings before any call", async t => {
  const f = await httpFixture(t);
  await f.login();
  const created = await f.request("/rooms", "POST", { title: "Context HTTP", contextMode: "memory" });
  assert.equal(created.response.status, 201);
  assert.equal(created.data.contextMode, "memory");
  const room = created.data;
  const persona = await f.request(`/rooms/${room.id}/personas`, "POST", { name: "Persona", model: "synthetic", contextMode: "archive" });
  assert.equal(persona.response.status, 201);
  assert.equal(persona.data.contextMode, "archive");
  const cleared = await f.request(`/rooms/${room.id}/personas/${persona.data.id}`, "PATCH", {
    expectedRevision: persona.data.revision, contextMode: null,
  });
  assert.equal(cleared.response.status, 200);
  assert.equal(cleared.data.contextMode, undefined);
  const turn = { requestId: randomUUID(), expectedRoomRevision: room.revision, content: "hello", recipient: { type: "all" }, context: { mode: "none" } };
  for (const forged of ["consumerPersonaId", "runId", "planId", "audience", "destination", "purpose", "sourceRef", "maxArchiveMessageSeq"]) {
    const rejected = await f.request(`/rooms/${room.id}/turns`, "POST", { ...turn, context: { ...turn.context, [forged]: "forged" } });
    assert.equal(rejected.response.status, 400, forged);
  }
  const contradictory = await f.request(`/rooms/${room.id}/turns`, "POST", { ...turn,
    context: { mode: "none", date: { mode: "strict", anchorDate: "2026-11-11" } } });
  assert.equal(contradictory.response.status, 400);
  assert.equal(contradictory.data.error.code, "INVALID_CONTEXT_DATE_MODE");
  assert.equal(f.provider.calls.length, 0);
  const accepted = await f.request(`/rooms/${room.id}/turns`, "POST", turn);
  assert.equal(accepted.response.status, 202, JSON.stringify(accepted.data));
  const repeat = await f.request(`/rooms/${room.id}/turns`, "POST", turn);
  assert.equal(repeat.response.status, 202);
  assert.equal(repeat.data.runId, accepted.data.runId);
  const changed = await f.request(`/rooms/${room.id}/turns`, "POST", { ...turn, context: { mode: "memory" } });
  assert.equal(changed.response.status, 409);
  assert.equal(changed.data.error.code, "REQUEST_CONFLICT");
  await f.generation.execute(accepted.data.runId);
  assert.equal(f.provider.calls.length, 1);
});
