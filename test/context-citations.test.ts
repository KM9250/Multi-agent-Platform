import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { citedSourceAliases, answerSourceParts } from "../shared/context-citations.ts";
import { appFixture } from "./app-data-fixture.ts";
import { FakeProvider } from "../server/generation/provider.ts";
import { GenerationCoordinator } from "../server/generation/coordinator.ts";
import { requestIndexUpdate } from "../server/search/index.ts";
import { SearchSources } from "../server/search/sources.ts";
import { digest } from "../server/app-data/validation.ts";
import { lineageFixture } from "./memory-lineage-fixture.ts";
import { permissions, share } from "./memory-context-fixture.ts";

test("source syntax links only exact supplied aliases; arbitrary URLs, HTML, unknown aliases stay plain text", () => {
  const allowed = new Set(["S1", "S2"]);
  const text = '<img src="https://example.invalid/leak"> [[MAP_SOURCE:S1]] [[MAP_SOURCE:S900]] https://example.invalid [[MAP_SOURCE:S1]]';
  assert.deepEqual(citedSourceAliases(text, allowed), ["S1"]);
  const parts = answerSourceParts(text, allowed);
  assert.deepEqual(parts.filter(part => part.alias).map(part => part.alias), ["S1", "S1"]);
  assert.ok(parts.filter(part => part.text).map(part => part.text).join("").includes("[[MAP_SOURCE:S900]]"));
  assert.deepEqual(answerSourceParts("ordinary answer without citations", allowed), [{ text: "ordinary answer without citations" }]);
});

test("sidecar rejects a validly shaped manifest bound to a different actor, input or provider", async () => {
  const f = appFixture();
  try {
    const receipt = f.generation.accept(f.actor, f.room.id, { requestId: randomUUID(), expectedRoomRevision: f.room.revision,
      content: "ordinary answer", recipient: { type: "all" }, context: { mode: "none" } });
    await f.generation.execute(receipt.runId);
    const answer = f.repository.listMessages(f.actor, f.room.id).messages.find(message => message.role === "model")!;
    assert.equal(answer.context?.state, "ready");
    const row = f.app.db.prepare("SELECT call_id,manifest_json,manifest_digest FROM app_provider_calls WHERE run_id=? AND purpose='answer'").get(receipt.runId)!;
    for (const mutate of [
      (manifest: any) => { manifest.retrieval.actorId = "another-actor"; },
      (manifest: any) => { manifest.retrieval.inputBinding.seq++; },
      (manifest: any) => { manifest.provider = manifest.retrieval.provider = "another-provider"; },
      (manifest: any) => { manifest.retrieval.inputBinding.excludeMessageId = "unrelated-answer"; },
    ]) {
      const manifest = JSON.parse(String(row.manifest_json));
      mutate(manifest);
      const json = JSON.stringify(manifest);
      f.app.db.prepare("UPDATE app_provider_calls SET manifest_json=?,manifest_digest=? WHERE call_id=?").run(json, digest(json), row.call_id);
      const sidecar = f.repository.getMessage(f.actor, f.room.id, answer.id).context;
      assert.equal(sidecar?.state, "unavailable");
      assert.deepEqual(sidecar?.supplied, []);
    }
    f.app.db.prepare("UPDATE app_provider_calls SET manifest_json=?,manifest_digest=? WHERE call_id=?").run(row.manifest_json, row.manifest_digest, row.call_id);
    assert.deepEqual(f.repository.getMessage(f.actor, f.room.id, answer.id).context, answer.context);
    assert.equal(f.provider.calls.length, 1);
  } finally { f.dispose(); }
});

test("Room/Persona defaults use revisioned settings; a Persona override can be removed", () => {
  const f = appFixture();
  try {
    const room = f.repository.updateRoom(f.actor, f.room.id, { expectedRevision: f.room.revision, contextMode: "archive" });
    assert.equal(room.contextMode, "archive");
    const persona = f.repository.updatePersona(f.actor, room.id, f.persona.id, { expectedRevision: f.persona.revision, contextMode: "memory" });
    assert.equal(persona.contextMode, "memory");
    assert.equal(f.repository.updatePersona(f.actor, room.id, persona.id, { expectedRevision: persona.revision, contextMode: null }).contextMode, undefined);
    assert.throws(() => f.repository.updateRoom(f.actor, room.id, { expectedRevision: room.revision, contextMode: "private" }), /INVALID_INPUT/);
    assert.throws(() => f.repository.updatePersona(f.actor, room.id, persona.id, { expectedRevision: persona.revision + 1, contextMode: { mode: "both" } }), /INVALID_INPUT/);
  } finally { f.dispose(); }
});

test("answer source sidecar follows the receipt revision, survives reconnect, distinguishes supplied/cited and never substitutes changed sources", async () => {
  const f = appFixture();
  try {
    f.repository.updatePersona(f.actor, f.room.id, f.persona.id, { expectedRevision: f.persona.revision, historyWindow: 1, pinFirstMessage: false });
    const original = f.repository.appendMessage(f.actor, f.room.id, { role: "user", content: "星砂の仕様はUTF-16😀\r\n原文です。" });
    await requestIndexUpdate(f.app, f.policy, f.actor, f.room.id, { rebuild: true });
    const provider = new FakeProvider(request => ({
      text: request.structured ? JSON.stringify({ public_message: "星砂の仕様 [[MAP_SOURCE:S1]] [[MAP_SOURCE:S999]] <b>plain</b>" }) : "星砂の仕様 [[MAP_SOURCE:S1]] [[MAP_SOURCE:S999]] <b>plain</b>",
      finish: "STOP", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, completeness: "COMPLETE", semantics: "synthetic-v1" },
    }));
    const generation = new GenerationCoordinator(f.app, f.repository, f.policy, { provider, defaultModel: "synthetic" });
    const receipt = generation.accept(f.actor, f.room.id, { requestId: randomUUID(), expectedRoomRevision: f.room.revision,
      content: "星砂の仕様", recipient: { type: "all" }, context: { mode: "archive" } });
    await generation.execute(receipt.runId);
    const run = generation.get(f.actor, f.room.id, receipt.runId);
    assert.equal(run.status, "COMPLETED", JSON.stringify(run));
    const answer = f.repository.listMessages(f.actor, f.room.id).messages.find(message => message.role === "model")!;
    assert.ok(answer.context, "an answer must have a revision-bound context sidecar");
    assert.ok(answer.context.supplied.length > 0, JSON.stringify({ context: answer.context, manifest: f.app.db.prepare("SELECT manifest_json FROM app_provider_calls WHERE purpose='answer'").get() }));
    assert.deepEqual(answer.context.citedAliases, ["S1"]);
    assert.equal(answer.context.revision, answer.revision);
    assert.equal(answer.context.messageId, answer.id);
    assert.deepEqual(f.repository.getMessage(f.actor, f.room.id, answer.id).context, answer.context);
    assert.equal(JSON.stringify(answer.context).includes("query"), false);
    assert.equal(JSON.stringify(answer.context).includes("permissions"), false);
    const source = answer.context.supplied.find(source => source.citation.target === "archive" && source.citation.messageId === original.id)!;
    assert.ok(source);
    const resolver = new SearchSources(f.app, f.policy, f.actor, f.room.id);
    const resolved = resolver.resolve(source.citation, { includeHistory: false });
    assert.equal(resolved.text, original.content.slice(source.citation.start, source.citation.end));
    f.repository.correctMessage(f.actor, f.room.id, original.id, { expectedRevision: original.revision, content: "訂正後" });
    assert.throws(() => resolver.resolve(source.citation, { includeHistory: false }), /SOURCE_CHANGED|NOT_FOUND/);
    const retry = generation.regenerate(f.actor, f.room.id, answer.id, { requestId: randomUUID(), expectedRevision: answer.revision });
    await generation.execute(retry.runId);
    assert.equal(generation.get(f.actor, f.room.id, retry.runId).status, "COMPLETED");
    const regenerated = f.repository.getMessage(f.actor, f.room.id, answer.id);
    assert.equal(regenerated.revision, answer.revision + 1);
    assert.equal(regenerated.context?.revision, regenerated.revision);
    assert.notEqual(regenerated.context?.receiptId, answer.context.receiptId);
    assert.deepEqual(regenerated.context?.supplied, [], "regeneration must not inherit the old source after its original changes");
    assert.deepEqual(regenerated.context?.citedAliases, []);
    assert.deepEqual(f.repository.getMessage(f.actor, f.room.id, answer.id, answer.revision).context, answer.context);
    const corrected = f.repository.appendRevision(f.actor, f.room.id, answer.id, { expectedRevision: regenerated.revision, content: "Revision without a generation receipt [[MAP_SOURCE:S1]]", reason: "correction" });
    assert.equal(corrected.context, undefined, "correction must not inherit a different answer receipt");
    assert.deepEqual(f.repository.getMessage(f.actor, f.room.id, answer.id, answer.revision).context, answer.context);
    assert.equal(provider.calls.length, 2);
  } finally { f.dispose(); }
});

test("shared Memory reaches a structured answer; its private provenance stays internal and current READ_MEMORY is required for the sidecar and original", async () => {
  const f = lineageFixture();
  try {
    permissions(f);
    f.original();
    const memory = await f.memory();
    share(f, memory.candidate.id);
    const persona = f.repository.getPersona(f.actor, f.room.id, f.persona.id);
    f.repository.updatePersona(f.actor, f.room.id, persona.id, { expectedRevision: persona.revision, historyWindow: 1, pinFirstMessage: false });
    await requestIndexUpdate(f.app, f.policy, f.actor, f.room.id, { rebuild: true });
    const provider = new FakeProvider(() => ({ text: JSON.stringify({ public_message: "月曜です [[MAP_SOURCE:S1]]" }), finish: "STOP",
      usage: { completeness: "COMPLETE", inputTokens: 4, outputTokens: 2, totalTokens: 6, semantics: "synthetic-v1" } }));
    const generation = new GenerationCoordinator(f.app, f.repository, f.policy, { provider, defaultModel: "synthetic" });
    const accepted = generation.accept(f.actor, f.room.id, { requestId: randomUUID(), expectedRoomRevision: f.room.revision,
      content: "予定", context: { mode: "memory" }, recipient: { type: "all" } });
    await generation.execute(accepted.runId);
    const run = generation.get(f.actor, f.room.id, accepted.runId);
    assert.equal(run.status, "COMPLETED", JSON.stringify(run));
    const answer = f.repository.listMessages(f.actor, f.room.id).messages.filter(message => message.role === "model").at(-1)!;
    assert.equal(answer.context?.supplied[0]?.citation.target, "memory", JSON.stringify(answer.context));
    assert.deepEqual(answer.context?.citedAliases, ["S1"]);
    assert.ok(!JSON.stringify(answer.context).includes(memory.outputId));
    assert.ok(!JSON.stringify(answer.context).includes(f.vault));
    const citation = answer.context!.supplied[0].citation;
    const resolver = new SearchSources(f.app, f.policy, f.actor, f.room.id);
    assert.ok(resolver.resolve(citation).text.includes("月曜"));
    f.policy.revoke(f.actor.actorId, f.actor.workspaceId, "READ_MEMORY");
    const current = f.repository.getMessage(f.actor, f.room.id, answer.id).context!;
    assert.equal(current.state, "partial");
    assert.deepEqual(current.supplied, []);
    assert.deepEqual(current.citedAliases, []);
    assert.throws(() => resolver.resolve(citation), /FORBIDDEN|NOT_FOUND|SOURCE_CHANGED/);
    assert.equal(provider.calls.length, 1);
  } finally { f.close(); }
});
