import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appFixture } from "./app-data-fixture.ts";
import { digest } from "../server/app-data/validation.ts";
import { GenerationCoordinator } from "../server/generation/coordinator.ts";
import { registerHandwrittenNote } from "../server/memory/importer.ts";
import { registerVault, setVaultPaused } from "../server/memory/vault.ts";
import { requestIndexUpdate, shutdownIndexWorkers } from "../server/search/index.ts";
import { stable } from "../server/generation/types.ts";

const sentence = "cedarの保存先はSQLiteです。";
const content = "cedarの保存先を述べた冒頭の一文だけを原文のまま引用してください。";
const archiveText = sentence + "補足説明です。".repeat(700);

async function runCase(maxInputTokens: number, swapped = false) {
  const f = appFixture(), vault = mkdtempSync(join(tmpdir(), "map-pr41-budget-meta-"));
  const generation = new GenerationCoordinator(f.app, f.repository, f.policy, {
    provider: f.provider, defaultModel: "synthetic", limits: { maxInputTokens },
  });
  try {
    registerVault(f.app, vault, { trustNew: true }); setVaultPaused(f.app, false);
    f.policy.grant(f.actor.actorId, f.actor.workspaceId, "MANAGE_VAULT");
    for (const operation of ["READ_MEMORY", "REVIEW_MEMORY", "PUBLISH_MEMORY", "CHANGE_MEMORY_SCOPE"])
      f.policy.grant(f.actor.actorId, f.actor.workspaceId, operation, {
        roomId: f.room.id, personaId: f.persona.id, visibility: "room_shared",
      });
    const memoryText = swapped ? archiveText : sentence + "x";
    const conversationText = swapped ? sentence + "x" : archiveText;
    const markdown = "---\nmap_id: quote-memory\n---\n" + memoryText;
    writeFileSync(join(vault, "quote-memory.md"), markdown);
    await registerHandwrittenNote(f.app, f.policy, f.actor, {
      roomId: f.room.id, personaId: f.persona.id, scope: "room_shared", noteId: "quote-memory",
      relativePath: "quote-memory.md", expectedDigest: digest(markdown), requestId: randomUUID(), trusted: true,
    });
    f.repository.updatePersona(f.actor, f.room.id, f.persona.id, { expectedRevision: 1, historyWindow: 1, pinFirstMessage: false });
    const source = f.repository.appendMessage(f.actor, f.room.id, { role: "user", content: conversationText });
    const run = generation.accept(f.actor, f.room.id, {
      requestId: randomUUID(), expectedRoomRevision: f.room.revision, content,
      recipient: { type: "all" }, context: { mode: "both" },
    });
    await requestIndexUpdate(f.app, f.policy, f.actor, f.room.id, { force: true });
    await generation.execute(run.runId);
    const result = generation.get(f.actor, f.room.id, run.runId);
    const row = f.app.db.prepare("SELECT manifest_json FROM app_provider_calls WHERE run_id=? AND purpose='answer'").get(run.runId);
    const manifest = row ? JSON.parse(String(row.manifest_json)) : null;
    const payload = f.provider.calls.at(-1);
    let envelope: any;
    if (payload) for (const c of payload.contents) for (const part of c.parts) if ("text" in part && part.text) {
      try { const e = JSON.parse(part.text); if (e.type === "MAP_RETRIEVED_CONTEXT") envelope = e; } catch {}
    }
    return { status: result.status, errorCode: result.errorCode, maxInputTokens, sourceId: source.id,
      originals: { memory: memoryText, archive: conversationText },
      providerCalls: f.provider.calls.length, manifest, envelope,
      payload: payload ? { systemInstruction: payload.systemInstruction, contents: payload.contents } : null };
  } finally {
    await generation.shutdown(); await f.generation.shutdown(); await shutdownIndexWorkers(f.app);
    f.dispose(); rmSync(vault, { force: true, recursive: true });
  }
}

function assertActualQuotes(actual: Awaited<ReturnType<typeof runCase>>, shortTarget: "memory" | "archive") {
  assert.equal(actual.status, "COMPLETED", actual.errorCode);
  assert.equal(actual.providerCalls, 1);
  const { manifest, envelope, payload } = actual;
  assert(payload);
  assert.equal(manifest.retrieval.route.requiresFullSource, false);
  assert(!manifest.messages.some((m: any) => m.id === actual.sourceId));
  assert.equal(manifest.retrieval.sources.length, 2);
  assert.equal(manifest.estimatedInputTokens,
    Math.ceil(Buffer.byteLength(payload.systemInstruction + stable(payload.contents), "utf8") / 3));
  assert(manifest.estimatedInputTokens <= actual.maxInputTokens);
  for (const source of manifest.retrieval.sources) {
    const ref = source.citation, original = actual.originals[ref.target as "memory" | "archive"];
    const supplied = envelope.references.find((r: any) => r.alias === source.alias).text;
    assert(supplied.includes(sentence));
    assert.equal(supplied, original.slice(ref.start, ref.end));
    if (ref.target === "memory") {
      assert.equal(ref.noteId, "quote-memory"); assert.equal(ref.bodyDigest, digest(original));
    } else {
      assert.equal(ref.messageId, actual.sourceId); assert.equal(ref.segmentDigest, digest(original));
    }
    const search = envelope.searches.find((s: any) => s.target === ref.target);
    const savedSearch = manifest.retrieval.searches.find((s: any) => s.target === ref.target);
    assert.deepEqual({ status: search.status, reasons: search.reasons }, { status: savedSearch.status, reasons: savedSearch.reasons });
    if (ref.target === shortTarget) {
      assert.equal(ref.start, 0); assert.equal(ref.end, original.length);
      assert.equal(search.status, "ready"); assert(!search.reasons.includes("EXCERPT_TRUNCATED"));
    } else {
      assert.equal(search.status, "partial"); assert(search.reasons.includes("EXCERPT_TRUNCATED"));
      assert(ref.end - ref.start < original.length);
    }
  }
}

test("PR41 v1.1: two-target quote packing includes actual metadata cost in its required baseline", async () => {
  const generous = await runCase(16384);
  assert.equal(generous.status, "COMPLETED", JSON.stringify(generous));
  assert.equal(generous.manifest.retrieval.sources.length, 2);
  const source = generous.manifest.retrieval.sources.find((s: any) => s.citation.target === "archive");
  assert(source && !generous.manifest.messages.some((m: any) => m.id === generous.sourceId));
  const witness = structuredClone(generous.payload)!;
  for (const c of witness.contents) for (const part of c.parts) if ("text" in part && part.text) {
    let envelope: any; try { envelope = JSON.parse(part.text); } catch { continue; }
    if (envelope.type !== "MAP_RETRIEVED_CONTEXT") continue;
    const archive = envelope.references.find((r: any) => r.alias === source.alias);
    archive.text = sentence;
    const search = envelope.searches.find((s: any) => s.target === "archive");
    search.status = "partial"; search.reasons.push("EXCERPT_TRUNCATED");
    part.text = stable(envelope);
  }
  const capacity = Math.ceil(Buffer.byteLength(witness.systemInstruction + stable(witness.contents), "utf8") / 3);
  const tightControl = await runCase(capacity + 17);
  const actual = await runCase(capacity + 1);
  const report = { auditedHead: "1869fb7d0feb82662a7704e0d97e98002cc74022", sentence, content,
    explanation: "Pure witness retains the complete 20-unit Memory and the required 19-unit Archive sentence, with actual Archive truncation metadata. Witness is not dispatched.",
    witnessEstimatedInputTokens: capacity, witness, generous, tightControl, actual, realProviderCalls: 0 };
  writeFileSync(join(process.env.PR41_V11_EVIDENCE_DIR ?? "/tmp", "compat-metadata-budget.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ witnessEstimatedInputTokens: capacity, tightControl: { status: tightControl.status, maxInputTokens: tightControl.maxInputTokens, estimatedInputTokens: tightControl.manifest?.estimatedInputTokens, sources: tightControl.manifest?.retrieval.sources, envelope: tightControl.envelope }, actual: { status: actual.status, errorCode: actual.errorCode, maxInputTokens: actual.maxInputTokens, providerCalls: actual.providerCalls } }));
  assert.equal(tightControl.status, "COMPLETED", "Actual Coordinator control must complete, not merely a hypothetical packing witness");
  assert.equal(tightControl.providerCalls, 1);
  assert(tightControl.manifest.estimatedInputTokens <= actual.maxInputTokens, "The actual completed control payload itself fits the rejected lower cap");
  assert.equal(tightControl.manifest.estimatedInputTokens, Math.ceil(Buffer.byteLength(tightControl.payload!.systemInstruction + stable(tightControl.payload!.contents), "utf8") / 3));
  assert.equal(actual.status, "COMPLETED", "Both required quotes fit when the one-byte optional Memory tail is retained instead of adding a larger truncation reason");
  assert.equal(actual.providerCalls, 1);
  assertActualQuotes(actual, "memory");
});

test("F-02-B metadata-aware required packing also retains a short Archive beside a long Memory", async () => {
  const generous = await runCase(16384, true);
  assert.equal(generous.status, "COMPLETED");
  const memory = generous.manifest.retrieval.sources.find((s: any) => s.citation.target === "memory");
  const witness = structuredClone(generous.payload)!;
  for (const c of witness.contents) for (const part of c.parts) if ("text" in part && part.text) {
    let envelope: any; try { envelope = JSON.parse(part.text); } catch { continue; }
    if (envelope.type !== "MAP_RETRIEVED_CONTEXT") continue;
    envelope.references.find((r: any) => r.alias === memory.alias).text = sentence;
    const search = envelope.searches.find((s: any) => s.target === "memory");
    search.status = "partial"; search.reasons.push("EXCERPT_TRUNCATED");
    part.text = stable(envelope);
  }
  const capacity = Math.ceil(Buffer.byteLength(witness.systemInstruction + stable(witness.contents), "utf8") / 3);
  const actual = await runCase(capacity + 1, true);
  writeFileSync(join(process.env.PR41_V11_EVIDENCE_DIR ?? "/tmp", "compat-metadata-budget-swapped.json"),
    JSON.stringify({ witnessEstimatedInputTokens: capacity, actual, realProviderCalls: 0 }, null, 2));
  assertActualQuotes(actual, "archive");
});
