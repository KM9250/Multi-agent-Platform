import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { appFixture } from "./app-data-fixture.ts";
import { lineageFixture } from "./memory-lineage-fixture.ts";
import { PUBLIC_USER_OPERATIONS } from "../server/auth/authorization.ts";
import { createAiSearchBinding, assertAiSearchBinding } from "../server/search/ai-binding.ts";
import { SearchSources } from "../server/search/sources.ts";
import { SQLiteSearchBackend } from "../server/search/backend.ts";
import { ReferenceSearchBackend } from "../server/search/backend-reference.ts";
import { requestIndexUpdate, shutdownIndexWorkers } from "../server/search/index.ts";
import { searchAiContext, searchRoom } from "../server/search/service.ts";
import { searchInput } from "../server/search/input.ts";
import type { SearchSource } from "../shared/search-sources.ts";
import { registerVault, setVaultPaused } from "../server/memory/vault.ts";
import { registerHandwrittenNote } from "../server/memory/importer.ts";
import { digest } from "../server/app-data/validation.ts";
import { configureSearchProfile } from "../server/search/profile.ts";
import { buildDenseIndex } from "../server/search/dense.ts";
import { scanCorpus, scanCorpusAsync } from "../server/search/dense-corpus.ts";
import { hasVerifiedNoteAncestors } from "../server/memory/source-validation.ts";
import { spaceId, type EmbeddingProvider } from "../server/search/embedding.ts";

function activate(f: ReturnType<typeof appFixture>, options: { actor?: typeof f.actor; personaId?: string; exclude?: string } = {}) {
  const actor = options.actor ?? f.actor;
  const personaId = options.personaId ?? f.persona.id;
  const run = f.generation.accept(actor, f.room.id, {
    requestId: randomUUID(), expectedRoomRevision: f.repository.getRoom(actor, f.room.id).revision,
    content: "以前の記録を確認", recipient: { type: "agent", agentIds: [personaId] },
  });
  f.app.db.prepare("UPDATE app_generation_runs SET state='RUNNING',target_message_id=? WHERE run_id=?")
    .run(options.exclude ?? null, run.runId);
  return createAiSearchBinding(f.app, f.policy, actor, {
    runId: run.runId, planId: randomUUID(), consumerPersonaId: personaId, provider: "synthetic", model: "synthetic",
  });
}

function archive(reader: SearchSources) {
  const out: SearchSource[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = reader.archivePage(cursor);
    out.push(...page.upserts);
    cursor = page.cursor;
    if (!page.hasMore) return { out, cursor };
  }
}

test("AI binding is signed, server-derived, current-run-only, and is rejected by the human entry", async (t) => {
  const f = appFixture(); t.after(f.dispose);
  const binding = activate(f);
  assertAiSearchBinding(f.app, f.policy, f.actor, f.room.id, binding);
  for (const forged of [
    { ...binding, maxArchiveMessageSeq: 9999 },
    { ...binding, audience: "private" },
    { ...binding, consumerPersonaId: "different" },
    { ...binding, signature: "0".repeat(64) },
    { ...binding, inputBinding: { ...binding.inputBinding, seq: 9999 } },
  ]) assert.throws(() => assertAiSearchBinding(f.app, f.policy, f.actor, f.room.id, forged as any), /INVALID_AI_CONTEXT_BINDING/);
  const req = searchInput({ requestId: randomUUID(), target: "archive", query: "記録" });
  await assert.rejects(searchRoom(f.app, f.policy, f.actor, f.room.id, req, {
    purpose: "ai_context", consumerPersonaId: f.persona.id, roomId: f.room.id,
    scope: "archive", destination: "synthetic", externalPurpose: "answer",
  }), /FORBIDDEN/);
  await assert.rejects(searchAiContext(f.app, f.policy, f.actor, f.room.id, { ...req, revisionMode: "include_history" }, binding), /AI_CURRENT_REVISION_REQUIRED/);
  f.app.db.prepare("UPDATE app_generation_runs SET cancelled_at=1,state='CANCELLED' WHERE run_id=?").run(binding.runId);
  assert.throws(() => new SearchSources(f.app, f.policy, f.actor, f.room.id, binding).assertRoom("archive"), /RUN_NOT_ACTIVE/);
});

test("AI scope precedes both backend TopK; private, old revisions, regeneration target and future never resolve", (t) => {
  const f = appFixture(); t.after(f.dispose);
  f.policy.grant(f.actor.actorId, f.actor.workspaceId, "READ_PRIVATE_SEGMENT", {
    roomId: f.room.id, personaId: f.persona.id, visibility: "self_only",
  });
  for (let i = 0; i < 110; i++) f.repository.appendMessage(f.actor, f.room.id, {
    role: "model", personaId: f.persona.id,
    segments: [{ channel: "private_state", visibility: "self_only", content: "記録".repeat(10) }],
  });
  const valid = f.repository.appendMessage(f.actor, f.room.id, { role: "user", content: "公開の記録😀\r\nです" });
  const replaced = f.repository.appendMessage(f.actor, f.room.id, { role: "user", content: "訂正前の記録" });
  f.repository.correctMessage(f.actor, f.room.id, replaced.id, { expectedRevision: 1, content: "訂正後の記録" });
  const target = f.repository.appendMessage(f.actor, f.room.id, { role: "model", personaId: f.persona.id, content: "再生成対象の記録" });
  const binding = activate(f, { exclude: target.id });
  const future = f.repository.appendMessage(f.actor, f.room.id, { role: "user", content: "未来の記録".repeat(10) });
  const human = new SearchSources(f.app, f.policy, f.actor, f.room.id);
  const records = archive(human).out;
  const ai = new SearchSources(f.app, f.policy, f.actor, f.room.id, binding);
  for (const backend of [new SQLiteSearchBackend(":memory:", { create: true }), new ReferenceSearchBackend()]) {
    t.after(() => backend.close());
    backend.applyPage({ deletes: [], upserts: records });
    const result = ai.withCandidateSnapshot("archive", () => backend.query({
      target: "archive", query: "記録", includeHistory: true, scopeLocalRanking: true, limit: 20,
      allowsScope: ai.allowsScope.bind(ai), eligible: ai.eligible.bind(ai),
    }));
    assert(result.hits.some((hit) => hit.citation.target === "archive" && hit.citation.messageId === valid.id));
    assert(result.hits.every((hit) => hit.visibility === "public" && hit.current));
    assert(!result.hits.some((hit) => hit.citation.target === "archive" && [future.id, target.id].includes(hit.citation.messageId)));
    assert.equal(result.limited, false);
  }
  for (const source of records.filter((s) => s.visibility !== "public" || !s.current || [target.id, future.id].includes(s.groupId))) {
    assert.equal(ai.eligible(source.ref, true), false);
    assert.throws(() => ai.resolve({ ...source.ref, start: 0, end: 1 }, { includeHistory: true }), /NOT_FOUND|SOURCE_CHANGED/);
  }
  const source = records.find((s) => s.groupId === valid.id)!;
  const opened = ai.resolve({ ...source.ref, start: 5, end: 9 }, { surrounding: 4 });
  assert.equal(opened.text, source.text.slice(5, 9));
  assert(opened.surrounding.every((e) => e.visibility === "public" && e.current));
  assert(!opened.surrounding.some((e) => e.citation.target === "archive" && [future.id, target.id].includes(e.citation.messageId)));
  assert.throws(() => ai.archivePage(), /AI_INDEX_SCOPE_FORBIDDEN/);
});

test("AI freshness ignores readable private changes and public messages after the bound input", (t) => {
  const f = appFixture(); t.after(f.dispose);
  f.policy.grant(f.actor.actorId, f.actor.workspaceId, "READ_PRIVATE_SEGMENT", {
    roomId: f.room.id, personaId: f.persona.id, visibility: "self_only",
  });
  const privateMessage = f.repository.appendMessage(f.actor, f.room.id, {
    role: "model", personaId: f.persona.id,
    segments: [{ channel: "private_state", visibility: "self_only", content: "非公開" }],
  });
  const publicMessage = f.repository.appendMessage(f.actor, f.room.id, { role: "user", content: "公開" });
  const binding = activate(f);
  const human = new SearchSources(f.app, f.policy, f.actor, f.room.id);
  const cursor = archive(human).cursor;
  const ai = new SearchSources(f.app, f.policy, f.actor, f.room.id, binding);
  f.repository.appendRevision(f.actor, f.room.id, privateMessage.id, {
    expectedRevision: 1, reason: "regeneration",
    segments: [{ channel: "private_state", visibility: "self_only", content: "非公開変更" }],
  });
  f.repository.appendMessage(f.actor, f.room.id, { role: "user", content: "入力後の公開" });
  assert.equal(human.hasUnindexedChanges("archive", cursor), true);
  assert.equal(ai.hasUnindexedChanges("archive", cursor), false);
  f.repository.correctMessage(f.actor, f.room.id, publicMessage.id, { expectedRevision: 1, content: "公開変更" });
  assert.equal(ai.hasUnindexedChanges("archive", cursor), true);
});

test("real lexical worker uses the AI scope and does not reveal human index update metadata", async (t) => {
  const f = appFixture();
  t.after(async () => { await shutdownIndexWorkers(f.app); f.dispose(); });
  f.repository.appendMessage(f.actor, f.room.id, { role: "user", content: "検索する記録" });
  const binding = activate(f);
  f.repository.appendMessage(f.actor, f.room.id, { role: "user", content: "検索する未来" });
  await requestIndexUpdate(f.app, f.policy, f.actor, f.room.id, { force: true });
  const result = await searchAiContext(f.app, f.policy, f.actor, f.room.id,
    searchInput({ requestId: randomUUID(), target: "archive", query: "検索する", limit: 5 }), binding);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].snippet, "検索する記録");
  assert.equal(result.status, "ready");
  assert(result.generationId);
  assert.equal(result.coverage.syncedAt, undefined);
  assert.equal(result.coverage.updating, undefined);
  assert.deepEqual(result.external, { status: "none", calls: 0 });
  const controller = new AbortController(); controller.abort(new Error("parent cancelled"));
  await assert.rejects(searchAiContext(f.app, f.policy, f.actor, f.room.id,
    searchInput({ requestId: randomUUID(), target: "archive", query: "検索" }), binding, controller.signal), /parent cancelled/);
});

test("AI can use another owner's shared Note while the consumer actor cannot read its private ancestry", async (t) => {
  const f = lineageFixture(); t.after(f.close);
  const sharedScope = { roomId: f.room.id, personaId: f.persona.id, visibility: "room_shared" };
  f.policy.grant(f.actor.actorId, f.actor.workspaceId, "EDIT_MEMORY", { ...sharedScope, visibility: "persona_private" });
  for (const op of ["READ_MEMORY", "PUBLISH_MEMORY", "CHANGE_MEMORY_SCOPE"])
    f.policy.grant(f.actor.actorId, f.actor.workspaceId, op, sharedScope);
  const exported = await f.memory();
  const edited = f.candidates.edit(f.actor, f.room.id, exported.candidate.id, {
    requestId: randomUUID(), expectedRevision: exported.candidate.revision,
    body: "共有された方針", kind: exported.candidate.kind, assertionType: exported.candidate.assertionType, scope: "room_shared",
  });
  f.publish(edited.id);
  const consumer = f.repository.createPersona(f.actor, f.room.id, { name: "Consumer", model: "synthetic" });
  const viewer = { workspaceId: f.actor.workspaceId, actorId: "ai-shared-reader" };
  f.app.db.prepare("INSERT INTO principals VALUES(?,?,1)").run(viewer.actorId, viewer.workspaceId);
  for (const op of PUBLIC_USER_OPERATIONS) f.policy.grant(viewer.actorId, viewer.workspaceId, op);
  f.policy.grant(viewer.actorId, viewer.workspaceId, "READ_MEMORY", sharedScope);
  const binding = activate(f, { actor: viewer, personaId: consumer.id });
  const human = new SearchSources(f.app, f.policy, viewer, f.room.id);
  const originalPage = human.memoryPage();
  const source = originalPage.upserts[0];
  const transaction = f.app.transaction.bind(f.app);
  let verifiedReads = 0;
  f.app.transaction = ((read: () => unknown, phase?: string) => {
    if (phase !== "memory_change_feed") {
      assert.equal(hasVerifiedNoteAncestors(f.app, exported.candidate.id), true);
      verifiedReads++;
    }
    return transaction(read, phase);
  }) as typeof f.app.transaction;
  try {
    // Cursor seals use fresh nonces; their page selection/content must remain identical.
    const { cursor: asyncCursor, ...asyncPage } = await human.memoryPageAsync();
    const { cursor: originalCursor, ...originalSelection } = originalPage;
    assert.deepEqual(asyncPage, originalSelection);
    assert.equal(typeof asyncCursor, "string");
    assert.equal(typeof originalCursor, "string");
  } finally { f.app.transaction = transaction; }
  assert.equal(verifiedReads, 1);
  assert.equal(hasVerifiedNoteAncestors(f.app, exported.candidate.id), false);
  const cancelled = new AbortController(); cancelled.abort(new Error("index cancelled"));
  await assert.rejects(human.memoryPageAsync(undefined, cancelled.signal), /index cancelled/);
  const reader = new SearchSources(f.app, f.policy, viewer, f.room.id, binding);
  const opened = reader.resolve({ ...source.ref, start: 0, end: source.text.length });
  assert.equal(opened.text, "共有された方針");
  assert.equal(opened.personaId, f.persona.id);
  for (const hidden of [exported.outputId, f.vault, "relativePath", "sourceRefs"]) assert(!JSON.stringify(opened).includes(hidden));
  const path = f.app.db.prepare("SELECT relative_path FROM memory_documents WHERE note_id=?").get(source.sourceId)!.relative_path;
  writeFileSync(join(f.vault, String(path)), "changed before the watcher");
  assert.throws(() => reader.resolve({ ...source.ref, start: 0, end: source.text.length }), /MEMORY_UNAVAILABLE/);
});

test("AI Dense coverage and source reads are shared-only even when a human profile indexes private notes", async (t) => {
  const f = appFixture(); t.after(f.dispose);
  const vault = mkdtempSync(join(tmpdir(), "map-ai-corpus-"));
  t.after(() => rmSync(vault, { recursive: true, force: true }));
  registerVault(f.app, vault, { trustNew: true }); setVaultPaused(f.app, false);
  f.policy.grant(f.actor.actorId, f.actor.workspaceId, "MANAGE_VAULT");
  const owner = f.repository.createPersona(f.actor, f.room.id, { name: "Source owner", model: "synthetic" });
  for (const visibility of ["room_shared", "persona_private"]) {
    for (const operation of ["READ_MEMORY", "REVIEW_MEMORY", "PUBLISH_MEMORY", "CHANGE_MEMORY_SCOPE"])
      f.policy.grant(f.actor.actorId, f.actor.workspaceId, operation, { roomId: f.room.id, personaId: owner.id, visibility });
  }
  async function note(noteId: string, scope: "room_shared" | "persona_private") {
    const markdown = `---\nmap_id: ${noteId}\n---\n${noteId}の記録`;
    writeFileSync(join(vault, noteId + ".md"), markdown);
    await registerHandwrittenNote(f.app, f.policy, f.actor, {
      roomId: f.room.id, personaId: owner.id, scope, noteId, relativePath: noteId + ".md",
      expectedDigest: digest(markdown), requestId: randomUUID(), trusted: true,
    });
  }
  await note("shared-ai-note", "room_shared");
  await note("private-ai-note", "persona_private");
  const human = new SearchSources(f.app, f.policy, f.actor, f.room.id);
  const indexPath = join(f.root, "ai-corpus.sqlite");
  const index = new SQLiteSearchBackend(indexPath, { create: true }); t.after(() => index.close());
  index.applyPage({ deletes: [], upserts: human.memoryPage().upserts });
  const profile = configureSearchProfile(f.app, f.actor, f.room.id, {
    personaId: owner.id, scopes: ["room_shared", "persona_private"],
    purposes: ["DOCUMENT_EMBEDDING", "QUERY_EMBEDDING"],
    maxCalls: 20, maxTokens: 200000, maxCostMicros: 100000, priceMicrosPerThousandTokens: 100,
    aiContext: { queryEmbedding: true, consumerPersonaIds: [f.persona.id] },
  });
  let documentCalls = 0;
  const provider: EmbeddingProvider = {
    spaceId,
    async embed() {
      documentCalls++;
      return { vector: Float32Array.from({ length: 768 }, (_, i) => i === 0 ? 1 : 0), usage: { completeness: "COMPLETE", unit: "input_token", quantity: 1 } };
    },
  };
  const built = await buildDenseIndex(f.app, f.policy, f.actor, f.room.id, indexPath, new AbortController().signal, provider);
  assert.equal(built.state, "ready");
  assert.equal(documentCalls, 2);
  const binding = activate(f);
  const ai = new SearchSources(f.app, f.policy, f.actor, f.room.id, binding);
  const privateRef = human.memoryPage().upserts.find((s) => s.visibility === "persona_private")!.ref;
  assert.equal(human.eligible(privateRef), true);
  assert.equal(ai.eligible(privateRef), false);
  assert.equal(ai.allowsScope("memory", binding.consumerPersonaId, "persona_private", "note"), false);
  const scan = () => scanCorpus(f.app, f.policy, f.actor, f.room.id, index, indexPath, profile, undefined, binding);
  assert.deepEqual(await scanCorpusAsync(f.app, f.policy, f.actor, f.room.id, index, indexPath, profile, undefined, binding), scan());
  assert.deepEqual([scan().state, scan().planned, scan().indexed], ["ready", 1, 1]);
  await note("unembedded-private", "persona_private");
  index.applyPage({ deletes: [], upserts: human.memoryPage().upserts });
  assert.deepEqual([scan().state, scan().planned, scan().indexed], ["ready", 1, 1]);
  writeFileSync(join(vault, "private-ai-note.md"), "private original changed without watcher");
  assert.deepEqual([scan().state, scan().planned, scan().indexed], ["ready", 1, 1]);
  assert.equal(documentCalls, 2);
});
