import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appFixture } from "./app-data-fixture.ts";
import { PUBLIC_USER_OPERATIONS } from "../server/auth/authorization.ts";
import { createAiSearchBinding } from "../server/search/ai-binding.ts";
import { SearchSources } from "../server/search/sources.ts";
import { requestIndexUpdate, shutdownIndexWorkers, acquireActiveIndex } from "../server/search/index.ts";
import { searchAiContext, searchRoom } from "../server/search/service.ts";
import { searchInput } from "../server/search/input.ts";
import { ContextCompiler } from "../server/generation/context.ts";
import { prepareContextPlan, revalidateContextPlan } from "../server/generation/context-plan.ts";
import { DEFAULT_GENERATION_LIMITS } from "../server/generation/types.ts";

test("PR41 audit: source excluded by SEND_TO_PROVIDER still changes AI freshness", async (t) => {
  const f = appFixture();
  t.after(async () => { await shutdownIndexWorkers(f.app); f.dispose(); });
  f.repository.updatePersona(f.actor,f.room.id,f.persona.id,{expectedRevision:1,historyWindow:1,pinFirstMessage:false});
  const deniedOwner = f.repository.createPersona(f.actor, f.room.id, {name:"not-sendable-owner",model:"synthetic"});
  const visible = f.repository.appendMessage(f.actor, f.room.id, {role:"model",personaId:f.persona.id,content:"監査対象の記録 公開"});
  const blocked = f.repository.appendMessage(f.actor, f.room.id, {role:"model",personaId:deniedOwner.id,content:"監査対象の記録 送信禁止"});
  const actor = {workspaceId:f.actor.workspaceId, actorId:"limited-sender"};
  f.app.db.prepare("INSERT INTO principals VALUES(?,?,1)").run(actor.actorId,actor.workspaceId);
  for(const operation of PUBLIC_USER_OPERATIONS) if(operation!=="SEND_TO_PROVIDER") f.policy.grant(actor.actorId,actor.workspaceId,operation);
  f.policy.grant(actor.actorId,actor.workspaceId,"SEND_TO_PROVIDER",{roomId:f.room.id,personaId:f.persona.id,provider:"synthetic"});
  f.policy.grant(actor.actorId,actor.workspaceId,"SEND_TO_PROVIDER",{roomId:f.room.id,personaId:deniedOwner.id,provider:"synthetic",visibility:""});
  const run=f.generation.accept(actor,f.room.id,{requestId:randomUUID(),expectedRoomRevision:f.repository.getRoom(actor,f.room.id).revision,content:"以前の監査対象の記録について",recipient:{type:"agent",agentIds:[f.persona.id]}});
  f.app.db.prepare("UPDATE app_generation_runs SET state='RUNNING' WHERE run_id=?").run(run.runId);
  const binding=createAiSearchBinding(f.app,f.policy,actor,{runId:run.runId,planId:randomUUID(),consumerPersonaId:f.persona.id,provider:"synthetic",model:"synthetic"});
  const ai=new SearchSources(f.app,f.policy,actor,f.room.id,binding);
  await requestIndexUpdate(f.app,f.policy,actor,f.room.id,{force:true});
  const active=acquireActiveIndex(f.app,f.policy,actor,f.room.id);
  assert.equal(active.state,"ACTIVE");
  if(active.state!=="ACTIVE") throw new Error("no index");
  const cursor=active.manifest.positions!.archive;
  assert.equal(ai.hasUnindexedChanges("archive",cursor),false);
  f.repository.appendRevision(f.actor,f.room.id,blocked.id,{expectedRevision:1,reason:"regeneration",segments:[{channel:"public_message",visibility:"public",content:"監査対象の記録 送信禁止 更新"}]});
  assert.equal(ai.allowsScope("archive",deniedOwner.id,"public","public_message"),false);
  const compiler=new ContextCompiler(f.app,f.repository,f.policy,DEFAULT_GENERATION_LIMITS);
  const accepted=JSON.parse(String(f.app.db.prepare("SELECT request_json FROM app_generation_runs WHERE run_id=?").get(run.runId)!.request_json));
  const contextBinding={...accepted.inputBinding,runId:run.runId};
  const baseline=await compiler.compile(actor,f.room.id,f.persona.id,"answer","synthetic","synthetic",undefined,contextBinding);
  const plan=await prepareContextPlan(f.app,f.policy,actor,{runId:run.runId,roomId:f.room.id,personaId:f.persona.id,provider:"synthetic",model:"synthetic",baseline,limits:DEFAULT_GENERATION_LIMITS,context:{mode:"archive"}});
  const envelope=JSON.parse(revalidateContextPlan(f.app,f.policy,actor,plan).envelope);
  const packed=await compiler.compile(actor,f.room.id,f.persona.id,"answer","synthetic","synthetic",undefined,{...contextBinding,contextPlan:plan});
  assert.deepEqual(plan.sources.map(hit=>hit.citation.target==="archive"?hit.citation.messageId:"memory"),[visible.id]);
  assert.equal(JSON.stringify(packed.contents).includes("INDEX_LAGGING"), false,
    "Provider payload must agree with the corrected internal freshness result");
  console.log("PR41_AUDIT_SCOPE",JSON.stringify({blockedScopeAllowed:false,lagging:ai.hasUnindexedChanges("archive",cursor),envelope,envelopeIncludedInProviderPayload:true,realProviderCalls:f.provider.calls.length}));
  assert.equal(envelope.searches[0].reasons.includes("INDEX_LAGGING"),false,"unsendable source must not affect AI freshness");
});


function scopedFixture(t: any) {
  const f = appFixture(); t.after(async () => { await f.generation.shutdown(); await shutdownIndexWorkers(f.app); f.dispose(); });
  f.repository.updatePersona(f.actor, f.room.id, f.persona.id, { expectedRevision: 1, historyWindow: 1, pinFirstMessage: false });
  const denied = f.repository.createPersona(f.actor, f.room.id, { name: "read-only source owner", model: "synthetic" });
  const actor = { workspaceId: f.actor.workspaceId, actorId: "freshness-sender" };
  f.app.db.prepare("INSERT INTO principals VALUES(?,?,1)").run(actor.actorId, actor.workspaceId);
  for (const operation of PUBLIC_USER_OPERATIONS) if (operation !== "SEND_TO_PROVIDER") f.policy.grant(actor.actorId, actor.workspaceId, operation);
  f.policy.grant(actor.actorId, actor.workspaceId, "SEND_TO_PROVIDER", { roomId: f.room.id, personaId: f.persona.id, provider: "synthetic" });
  f.policy.grant(actor.actorId, actor.workspaceId, "SEND_TO_PROVIDER", { roomId: f.room.id, personaId: denied.id, provider: "synthetic", visibility: "" });
  const activate = (mode: "archive" | "memory", exclude?: string) => {
    const run = f.generation.accept(actor, f.room.id, { requestId: randomUUID(), expectedRoomRevision: f.repository.getRoom(actor, f.room.id).revision,
      content: "監査対象の記録を確認", recipient: { type: "agent", agentIds: [f.persona.id] }, context: { mode } });
    f.app.db.prepare("UPDATE app_generation_runs SET state='RUNNING',target_message_id=? WHERE run_id=?").run(exclude ?? null, run.runId);
    const binding = createAiSearchBinding(f.app, f.policy, actor, { runId: run.runId, planId: randomUUID(), consumerPersonaId: f.persona.id, provider: "synthetic", model: "synthetic" });
    return { run, binding, ai: new SearchSources(f.app, f.policy, actor, f.room.id, binding) };
  };
  const human = new SearchSources(f.app, f.policy, actor, f.room.id);
  const checkpoint = (target: "archive" | "memory", after?: string) => {
    for (;;) {
      const page = target === "archive" ? human.archivePage(after) : human.memoryPage(after);
      if (!page.hasMore) return page.cursor;
      after = page.cursor;
    }
  };
  return { ...f, denied, sender: actor, activate, human, checkpoint };
}

test("F-05 Archive changes use real owner READ/SEND scope, retain removal events and skip no eligible tail", async t => {
  for (const action of ["update", "delete", "private"] as const) await t.test(action, async t => {
    const f = scopedFixture(t);
    const visible = f.repository.appendMessage(f.actor, f.room.id, { role: "model", personaId: f.persona.id, content: "監査対象の記録 公開" });
    const excluded = f.repository.appendMessage(f.actor, f.room.id, { role: "model", personaId: f.persona.id, content: "再生成で除外" });
    const blocked = f.repository.appendMessage(f.actor, f.room.id, { role: "model", personaId: f.denied.id, content: "送信禁止" });
    const { ai } = f.activate("archive", excluded.id), cursor = f.checkpoint("archive");
    for (let revision = 1; revision <= 240; revision++) f.repository.appendRevision(f.actor, f.room.id, blocked.id, {
      expectedRevision: revision, reason: "regeneration", content: "送信禁止 更新 " + revision });
    f.repository.appendRevision(f.actor, f.room.id, excluded.id, { expectedRevision: 1, reason: "regeneration", content: "除外対象の更新" });
    f.repository.appendMessage(f.actor, f.room.id, { role: "model", personaId: f.persona.id, content: "cutoff後の更新" });
    assert.equal(ai.hasUnindexedChanges("archive", cursor), false);
    assert.equal(f.human.hasUnindexedChanges("archive", cursor), true);
    if (action === "delete") f.repository.deleteMessage(f.actor, f.room.id, visible.id, { expectedRevision: 1 });
    else f.repository.appendRevision(f.actor, f.room.id, visible.id, { expectedRevision: 1, reason: "regeneration",
      segments: [{ channel: action === "private" ? "private_state" : "public_message", visibility: action === "private" ? "self_only" : "public", content: "許可対象の変更" }] });
    assert.equal(ai.hasUnindexedChanges("archive", cursor), true);
    assert.equal(ai.hasUnindexedChanges("archive", f.checkpoint("archive", cursor)), false);
  });
});

test("F-05 Memory SEND-ineligible edits do not affect AI worker, Plan or payload; permitted edit/retraction still lag", async t => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path"); const { tmpdir } = await import("node:os");
  const { registerVault, setVaultPaused } = await import("../server/memory/vault.ts");
  const { registerHandwrittenNote, scanVault } = await import("../server/memory/importer.ts");
  const { retractNote } = await import("../server/memory/notes.ts");
  const { digest } = await import("../server/app-data/validation.ts");
  const f = scopedFixture(t), vault = mkdtempSync(join(tmpdir(), "pr41-freshness-memory-"));
  t.after(() => rmSync(vault, { recursive: true, force: true }));
  registerVault(f.app, vault); setVaultPaused(f.app, false);
  f.policy.grant(f.actor.actorId, f.actor.workspaceId, "MANAGE_VAULT");
  for (const [persona, id] of [[f.persona, "allowed-note"], [f.denied, "denied-note"]] as const) {
    const scope = { roomId: f.room.id, personaId: persona.id, visibility: "room_shared" };
    for (const op of ["READ_MEMORY", "REVIEW_MEMORY", "PUBLISH_MEMORY", "CHANGE_MEMORY_SCOPE", "RETRACT_MEMORY"]) f.policy.grant(f.actor.actorId, f.actor.workspaceId, op, scope);
    f.policy.grant(f.sender.actorId, f.sender.workspaceId, "READ_MEMORY", scope);
    const markdown = `---\nmap_id: ${id}\n---\n監査対象の記録 ${id}`;
    writeFileSync(join(vault, id + ".md"), markdown);
    await registerHandwrittenNote(f.app, f.policy, f.actor, { roomId: f.room.id, personaId: persona.id, noteId: id, scope: "room_shared", relativePath: id + ".md",
      expectedDigest: digest(markdown), requestId: randomUUID(), trusted: true });
  }
  const { ai, binding, run } = f.activate("memory");
  await requestIndexUpdate(f.app, f.policy, f.sender, f.room.id, { force: true });
  const active = acquireActiveIndex(f.app, f.policy, f.sender, f.room.id);
  assert.equal(active.state, "ACTIVE"); const cursor = active.manifest!.positions.memory;
  writeFileSync(join(vault, "denied-note.md"), "---\nmap_id: denied-note\n---\n監査対象の記録 送信禁止の更新");
  assert.equal((await scanVault(f.app)).status, "COMPLETE");
  assert.equal(f.human.hasUnindexedChanges("memory", cursor), true);
  assert.equal(ai.hasUnindexedChanges("memory", cursor), false);
  const response = await searchAiContext(f.app, f.policy, f.sender, f.room.id,
    searchInput({ requestId: randomUUID(), target: "memory", query: "監査対象の記録", retrievalMode: "lexical" }), binding);
  assert.equal(response.reasons.includes("INDEX_LAGGING"), false);
  const accepted = JSON.parse(String(f.app.db.prepare("SELECT request_json FROM app_generation_runs WHERE run_id=?").get(run.runId)!.request_json));
  const compiler = new ContextCompiler(f.app, f.repository, f.policy, DEFAULT_GENERATION_LIMITS);
  const input = { ...accepted.inputBinding, runId: run.runId };
  const baseline = await compiler.compile(f.sender, f.room.id, f.persona.id, "answer", "synthetic", "synthetic", undefined, input);
  const plan = await prepareContextPlan(f.app, f.policy, f.sender, { runId: run.runId, roomId: f.room.id, personaId: f.persona.id,
    provider: "synthetic", model: "synthetic", baseline, limits: DEFAULT_GENERATION_LIMITS, context: { mode: "memory" } });
  assert.deepEqual(plan.sources.map(s => s.citation.target === "memory" ? s.citation.noteId : "archive"), ["allowed-note"]);
  assert.equal(plan.searches[0].reasons.includes("INDEX_LAGGING"), false);
  const packed = await compiler.compile(f.sender, f.room.id, f.persona.id, "answer", "synthetic", "synthetic", undefined, { ...input, contextPlan: plan });
  assert.equal(JSON.stringify(packed.contents).includes("INDEX_LAGGING"), false);
  writeFileSync(join(vault, "allowed-note.md"), "---\nmap_id: allowed-note\n---\n監査対象の記録 許可対象の更新");
  await scanVault(f.app);
  assert.equal(ai.hasUnindexedChanges("memory", cursor), true);
  f.app.db.prepare("UPDATE memory_observations SET first_seen_at=0").run(); await scanVault(f.app);
  await requestIndexUpdate(f.app, f.policy, f.sender, f.room.id, { force: true });
  const refreshed = acquireActiveIndex(f.app, f.policy, f.sender, f.room.id);
  assert.equal(refreshed.state, "ACTIVE");
  const synced = refreshed.manifest.positions.memory;
  assert.equal(ai.hasUnindexedChanges("memory", synced), false);
  const note = f.app.db.prepare("SELECT version,digest FROM memory_documents WHERE note_id='allowed-note'").get()!;
  retractNote(f.app, f.policy, f.actor, "allowed-note", { expectedVersion: note.version, expectedDigest: note.digest, requestId: randomUUID() });
  assert.equal(ai.hasUnindexedChanges("memory", synced), true);
  assert.equal(ai.hasUnindexedChanges("memory", f.checkpoint("memory", synced)), false);
});

test("F-05 AI freshness metadata probes keep Room/change and Note/change index seeks", async t => {
  const f = appFixture(); t.after(f.dispose);
  const { AI_ARCHIVE_FRESHNESS_SQL, AI_MEMORY_FRESHNESS_SQL } = await import("../server/search/sources.ts");
  const details = (sql: string, args: (string | number)[]) => f.app.db.prepare("EXPLAIN QUERY PLAN " + sql).all(...args).map(r => r.detail).join("\n");
  const archive = details(AI_ARCHIVE_FRESHNESS_SQL, [f.actor.workspaceId, f.room.id, f.actor.actorId, 20, 99, "", "synthetic"]);
  const memory = details(AI_MEMORY_FRESHNESS_SQL, [f.actor.workspaceId, f.actor.actorId, f.room.id, 20, "synthetic"]);
  assert.match(archive, /search_message_changes \(workspace_id=\? AND room_id=\? AND change_id>\?\)/);
  assert.match(memory, /memory_documents_room \(workspace_id=\? AND room_id=\?\)/);
  assert.match(memory, /memory_change_note \(note_id=\? AND seq>\?\)/);
  assert.doesNotMatch(archive + memory, /\bSCAN\b/);
});
