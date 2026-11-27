import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lineageFixture } from "./memory-lineage-fixture.ts";
import { answerUsing, finish, permissions, share } from "./memory-context-fixture.ts";
import { GenerationCoordinator } from "../server/generation/coordinator.ts";
import { FakeProvider } from "../server/generation/provider.ts";
import { requestIndexUpdate, shutdownIndexWorkers } from "../server/search/index.ts";

for (const boundary of ["beforeIntentCommit", "afterProviderResponse"] as const) {
  test(`MEM-3A a changed unsupplied Note ancestor at ${boundary} reports CONTEXT_CHANGED and preserves acquired usage`, async t => {
    const f = lineageFixture();
    let generation: GenerationCoordinator | undefined;
    t.after(async () => {
      await generation?.shutdown();
      await f.generation.shutdown();
      await shutdownIndexWorkers(f.app);
      f.close();
    });
    permissions(f);
    const initialPersona = f.repository.getPersona(f.actor, f.room.id, f.persona.id);
    f.repository.updatePersona(f.actor, f.room.id, f.persona.id, {
      expectedRevision: initialPersona.revision, contextMode: "none",
    });
    f.original();
    const ancestor = await f.memory();
    share(f, ancestor.candidate.id);
    await answerUsing(f, ancestor.noteId);
    const descendant = await f.memory();
    finish(f);
    const candidate = f.candidates.get(f.actor, f.room.id, descendant.candidate.id);
    f.candidates.edit(f.actor, f.room.id, candidate.id, {
      requestId: randomUUID(), expectedRevision: candidate.revision,
      body: "CEDAR_DESCENDANT_ONLY", kind: candidate.kind, assertionType: candidate.assertionType,
      scope: "room_shared",
    });
    f.publish(candidate.id);
    assert.equal(f.app.db.prepare(`SELECT COUNT(*) n FROM memory_dependencies
      WHERE candidate_id=? AND resource_type='NOTE' AND resource_id=?`).get(candidate.id, ancestor.noteId)!.n, 1);
    const persona = f.repository.getPersona(f.actor, f.room.id, f.persona.id);
    f.repository.updatePersona(f.actor, f.room.id, persona.id, {
      expectedRevision: persona.revision, historyWindow: 1, pinFirstMessage: false,
    });
    const row = f.app.db.prepare("SELECT relative_path FROM memory_documents WHERE note_id=?").get(ancestor.noteId)!;
    const path = join(f.vault, String(row.relative_path));
    let mutations = 0;
    const provider = new FakeProvider(() => ({
      text: JSON.stringify({ public_message: "Synthetic derived answer [[MAP_SOURCE:S1]]" }),
      finish: "STOP",
      usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15, completeness: "COMPLETE", semantics: "synthetic-ancestor-boundary" },
    }));
    generation = new GenerationCoordinator(f.app, f.repository, f.policy, {
      provider, defaultModel: "synthetic",
      hooks: { [boundary]: () => {
        mutations++;
        writeFileSync(path, readFileSync(path, "utf8").replace("月曜", "火曜"));
      } },
    });
    const accepted = generation.accept(f.actor, f.room.id, {
      requestId: randomUUID(), expectedRoomRevision: f.room.revision,
      content: "CEDAR_DESCENDANT_ONLY", context: { mode: "memory" }, recipient: { type: "all" },
    });
    await requestIndexUpdate(f.app, f.policy, f.actor, f.room.id, { rebuild: true });
    await generation.execute(accepted.runId);
    const result = generation.get(f.actor, f.room.id, accepted.runId);
    const call = f.app.db.prepare("SELECT manifest_json,reason,usage_state,usage_json FROM app_provider_calls WHERE run_id=? AND purpose='answer'")
      .get(accepted.runId)!;
    const plan = JSON.parse(String(call.manifest_json)).retrieval;
    assert.deepEqual(plan.sources.map((source: any) => source.citation.noteId), [descendant.noteId], "only the descendant was supplied; the changed ancestor remains internal");
    assert.equal(mutations, 1);
    assert.equal(result.errorCode, "CONTEXT_CHANGED", JSON.stringify(result));
    assert.equal(result.results.length, 0);
    const sent = boundary === "afterProviderResponse";
    assert.equal(provider.calls.length, sent ? 1 : 0);
    if (sent) {
      assert.equal(call.reason, "CONTEXT_CHANGED");
      assert.equal(call.usage_state, "COMPLETE");
      assert.equal(JSON.parse(String(call.usage_json)).totalTokens, 15);
    }
    await generation.execute(accepted.runId);
    assert.equal(provider.calls.length, sent ? 1 : 0, "a failed frozen plan is not resent");
    assert.equal(f.app.db.prepare("SELECT COUNT(*) n FROM search_operations").get()!.n, 0);
  });
}
