import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { appFixture } from "./app-data-fixture.ts";
import { routeContext, interpretContextDate } from "../server/generation/context-router.ts";
import { requestIndexUpdate, shutdownIndexWorkers } from "../server/search/index.ts";

const evidence = `${process.env.PR41_AUDIT_EVIDENCE_DIR ?? "/tmp/pr41-audit-evidence"}`;
mkdirSync(evidence, { recursive: true });

test("PR41 audit: historical dated policy question must use Archive", async t => {
  const content = "2026年11月11日に話した保存方針について、その時の発言を確認してください";
  const dateInterpretation = interpretContextDate(content, { timeZone: "Asia/Tokyo" }, Date.parse("2026-11-26T00:00:00Z"));
  const route = routeContext({ content, purpose: "answer", dateInterpretation, context: { timeZone: "Asia/Tokyo" } });
  const control = routeContext({ content: "2026年11月11日に話した事柄Aについて、その時の発言を確認してください", purpose: "answer", dateInterpretation });
  const f = appFixture();
  t.after(async () => { await f.generation.shutdown(); await shutdownIndexWorkers(f.app); f.dispose(); });
  f.repository.updatePersona(f.actor, f.room.id, f.persona.id, { expectedRevision: 1, historyWindow: 1, pinFirstMessage: false });
  const originalText = "保存方針はサーバーDBとObsidianで管理する。ARCHIVE_POLICY_CANARY";
  const archived = f.repository.appendMessage(f.actor, f.room.id, { role: "user", content: originalText });
  f.app.db.prepare("UPDATE messages SET occurred_at=? WHERE message_id=?").run(Date.parse("2026-11-11T03:00:00Z"), archived.id);
  const run = f.generation.accept(f.actor, f.room.id, { requestId: randomUUID(), expectedRoomRevision: f.room.revision,
    content, recipient: { type: "all" }, context: { timeZone: "Asia/Tokyo" } });
  await requestIndexUpdate(f.app, f.policy, f.actor, f.room.id, { force: true });
  await f.generation.execute(run.runId);
  const receipt = f.generation.get(f.actor, f.room.id, run.runId);
  const row = f.app.db.prepare("SELECT manifest_json FROM app_provider_calls WHERE run_id=? AND purpose='answer'").get(run.runId);
  const plan = row ? JSON.parse(String(row.manifest_json)).retrieval : null;
  writeFileSync(`${evidence}/dated-policy-route.json`, JSON.stringify({ content, expectedMode: "archive", actual: route, control,
    generation: { status: receipt.status, errorCode: receipt.errorCode, plan,
      sourceMessageId: archived.id, sourceOccurredAt: "2026-11-11T03:00:00Z",
      originalInProviderPayload: JSON.stringify(f.provider.calls).includes("ARCHIVE_POLICY_CANARY"), providerCalls: f.provider.calls.length } }, null, 2));
  assert.equal(receipt.status, "COMPLETED", receipt.errorCode);
  assert.equal(dateInterpretation.status, "resolved");
  assert.equal(control.mode, "archive");
  assert.equal(plan.searches[0].target, "archive");
  assert(JSON.stringify(f.provider.calls).includes("ARCHIVE_POLICY_CANARY"));
  assert.equal(route.mode, "archive", "A dated request for the original conversation must not become current-Memory-only because it contains 方針");
});

test("PR41 audit: a short quotation from a long source must not require the whole source", async t => {
  const f = appFixture();
  t.after(async () => { await f.generation.shutdown(); await shutdownIndexWorkers(f.app); f.dispose(); });
  f.repository.updatePersona(f.actor, f.room.id, f.persona.id, { expectedRevision: 1, historyWindow: 1, pinFirstMessage: false });
  const requiredSentence = "cedarの保存先はSQLiteです。";
  const originalText = requiredSentence + "\n" + "補足説明です。".repeat(700);
  const source = f.repository.appendMessage(f.actor, f.room.id, { role: "user", content: originalText });
  const execute = async (content: string) => {
    const run = f.generation.accept(f.actor, f.room.id, { requestId: randomUUID(), expectedRoomRevision: f.room.revision, content,
      recipient: { type: "all" }, context: { mode: "archive" } });
    await requestIndexUpdate(f.app, f.policy, f.actor, f.room.id, { force: true });
    const before = f.provider.calls.length;
    await f.generation.execute(run.runId);
    const result = f.generation.get(f.actor, f.room.id, run.runId);
    const call = f.app.db.prepare("SELECT manifest_json FROM app_provider_calls WHERE run_id=? AND purpose='answer'").get(run.runId);
    return { status: result.status, errorCode: result.errorCode, providerCalls: f.provider.calls.length - before,
      plan: call ? JSON.parse(String(call.manifest_json)).retrieval : null };
  };
  const control = await execute("cedarの保存先を確認してください");
  const actual = await execute("cedarの保存先を述べた一文だけを原文のまま引用してください。補足説明は不要です。");
  writeFileSync(`${evidence}/short-quote-long-source.json`, JSON.stringify({ sourceId: source.id, originalUtf16Length: originalText.length,
    requestedSentenceUtf16Length: requiredSentence.length, control, actual, expectedStatus: "COMPLETED" }, null, 2));
  assert.equal(control.status, "COMPLETED", JSON.stringify(control));
  assert(control.plan.sources.some((item: any) => item.citation.messageId === source.id));
  assert(JSON.stringify(f.provider.calls.at(-1)!.contents).includes(requiredSentence));
  assert.equal(actual.status, "COMPLETED", "The requested short original fits all limits; unrelated remainder must not be made mandatory");
});

test("F-02 faithful partial excerpts from the middle retain UTF-16/CRLF boundaries despite long supporting hits", async t => {
  for (const request of ["一文だけを原文のまま引用", "全文から該当する一文だけを引用", "原文のまま引用して"]) await t.test(request, async t => {
    const f = appFixture(); t.after(async () => { await f.generation.shutdown(); await shutdownIndexWorkers(f.app); f.dispose(); });
    f.repository.updatePersona(f.actor, f.room.id, f.persona.id, { expectedRevision: 1, historyWindow: 1, pinFirstMessage: false });
    const sentence = "cedarの保存先はSQLiteです。😀\r\n";
    const text = "無関係の序文。".repeat(300) + sentence + "関係のない補足。".repeat(500);
    const source = f.repository.appendMessage(f.actor, f.room.id, { role: "user", content: text });
    f.repository.appendMessage(f.actor, f.room.id, { role: "user", content: "cedar 補助資料 " + "補足。".repeat(1800) });
    const run = f.generation.accept(f.actor, f.room.id, { requestId: randomUUID(), expectedRoomRevision: f.room.revision,
      content: "cedarの保存先を述べた" + request, recipient: { type: "all" }, context: { mode: "archive" } });
    await requestIndexUpdate(f.app, f.policy, f.actor, f.room.id, { force: true }); await f.generation.execute(run.runId);
    const result = f.generation.get(f.actor, f.room.id, run.runId); assert.equal(result.status, "COMPLETED", result.errorCode);
    const call = f.app.db.prepare("SELECT manifest_json FROM app_provider_calls WHERE run_id=? AND purpose='answer'").get(run.runId)!;
    const manifest = JSON.parse(String(call.manifest_json)), plan = manifest.retrieval;
    assert.equal(plan.route.requiresExactExcerpt, true); assert.equal(plan.route.requiresFullSource, false);
    const selected = plan.sources.find((s: any) => s.citation.messageId === source.id); assert(selected);
    const ref = selected.citation; assert(ref.start > 0); assert(ref.end - ref.start <= 4096);
    const envelope = f.provider.calls.at(-1)!.contents.flatMap(c => c.parts).flatMap(p => "text" in p ? [p.text] : [])
      .map(text => { try { return JSON.parse(text!); } catch { return null; } }).find(e => e?.type === "MAP_RETRIEVED_CONTEXT");
    const excerpt = envelope.references.find((s: any) => s.alias === selected.alias).text;
    assert.equal(excerpt, text.slice(ref.start, ref.end)); assert(excerpt.includes(sentence), JSON.stringify({ref, excerpt, sentence}));
    for (const offset of [ref.start, ref.end]) {
      assert(!(text[offset - 1] === "\r" && text[offset] === "\n"));
      assert(!(/[\uD800-\uDBFF]/.test(text[offset - 1] ?? "") && /[\uDC00-\uDFFF]/.test(text[offset] ?? "")));
    }
    const { readContextManifest } = await import("../server/generation/context-manifest.ts");
    assert.deepEqual(readContextManifest(manifest), manifest);
    const legacy = structuredClone(manifest); legacy.retrieval.route.version = "map-context-router-v1";
    delete legacy.retrieval.route.requiresFullSource;
    assert.deepEqual(readContextManifest(legacy), legacy, "saved v1 references remain untouched; Router is not rerun");
    for (const mutation of [(r: any) => { r.requiresFullSource = "yes"; }, (r: any) => { r.untrusted = true; }, (r: any) => { delete r.requiresFullSource; }]) {
      const invalid = structuredClone(manifest); mutation(invalid.retrieval.route);
      assert.throws(() => readContextManifest(invalid), /CONTEXT_MANIFEST_INVALID/);
    }
  });
});

test("F-02 explicit whole Source cannot silently pass the citation API's UTF-16 cap", async t => {
  const f = appFixture(); t.after(async () => { await f.generation.shutdown(); await shutdownIndexWorkers(f.app); f.dispose(); });
  f.repository.updatePersona(f.actor, f.room.id, f.persona.id, { expectedRevision: 1, historyWindow: 1, pinFirstMessage: false });
  f.repository.appendMessage(f.actor, f.room.id, { role: "user", content: "cedar " + "a".repeat(4100) });
  const run = f.generation.accept(f.actor, f.room.id, { requestId: randomUUID(), expectedRoomRevision: f.room.revision,
    content: "cedar この発言の全文を省略せず引用", recipient: { type: "all" }, context: { mode: "archive" } });
  await requestIndexUpdate(f.app, f.policy, f.actor, f.room.id, { force: true }); await f.generation.execute(run.runId);
  assert.equal(f.generation.get(f.actor, f.room.id, run.runId).errorCode, "CONTEXT_LIMIT"); assert.equal(f.provider.calls.length, 0);
});

test("F-03 dated policy/decision/agreement requests reach Archive outside ordinary history and preserve recorded dates", async t => {
  for (const [term, relative] of [["保存方針", false], ["決定事項", false], ["合意内容", true]] as const) await t.test(term, async t => {
    const originalNow = Date.now; const acceptedAt = Date.parse("2026-11-26T00:00:00Z"); Date.now = () => acceptedAt;
    t.after(() => { Date.now = originalNow; });
    const f = appFixture(); t.after(async () => { await f.generation.shutdown(); await shutdownIndexWorkers(f.app); f.dispose(); });
    f.repository.updatePersona(f.actor, f.room.id, f.persona.id, { expectedRevision: 1, historyWindow: 1, pinFirstMessage: false });
    const recordedAt = Date.parse(relative ? "2026-11-25T03:00:00Z" : "2026-11-09T03:00:00Z");
    const text = term + "はSQLiteです。SOURCE_OUTSIDE_HISTORY";
    const source = f.repository.appendMessage(f.actor, f.room.id, { role: "user", content: text, occurredAt: recordedAt });
    f.repository.appendMessage(f.actor, f.room.id, { role: "user", content: "無関係の中間発言" });
    const run = f.generation.accept(f.actor, f.room.id, { requestId: randomUUID(), expectedRoomRevision: f.room.revision,
      content: `${relative ? "昨日" : "2026年11月11日に"}話した${term}について、当時の発言を確認`, recipient: { type: "all" }, context: { timeZone: "Asia/Tokyo" } });
    await requestIndexUpdate(f.app, f.policy, f.actor, f.room.id, { force: true }); await f.generation.execute(run.runId);
    const result = f.generation.get(f.actor, f.room.id, run.runId); assert.equal(result.status, "COMPLETED", result.errorCode);
    const manifest = JSON.parse(String(f.app.db.prepare("SELECT manifest_json FROM app_provider_calls WHERE run_id=? AND purpose='answer'").get(run.runId)!.manifest_json));
    assert.equal(manifest.retrieval.route.mode, "archive"); assert.equal(manifest.retrieval.searches[0].target, "archive");
    assert(!manifest.messages.some((m: any) => m.id === source.id));
    assert.equal(manifest.retrieval.sources.find((s: any) => s.citation.messageId === source.id).recordedAt, recordedAt);
    assert(JSON.stringify(f.provider.calls.at(-1)!.contents).includes("SOURCE_OUTSIDE_HISTORY"));
    await f.generation.execute(run.runId); assert.equal(f.provider.calls.length, 1);
  });
});
