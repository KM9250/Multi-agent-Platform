import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { appFixture } from "./app-data-fixture.ts";
import { GenerationCoordinator } from "../server/generation/coordinator.ts";
import { stable } from "../server/generation/types.ts";
import { requestIndexUpdate, shutdownIndexWorkers } from "../server/search/index.ts";

const runCase = async (sourceText: string, content: string, maxInputTokens: number, sentence: string, auxiliary?: string) => {
    const f = appFixture();
    const generation = new GenerationCoordinator(f.app, f.repository, f.policy, {
      provider: f.provider, defaultModel: "synthetic", limits: { maxInputTokens },
    });
    try {
      f.repository.updatePersona(f.actor, f.room.id, f.persona.id, { expectedRevision: 1, historyWindow: 1, pinFirstMessage: false });
      const source = f.repository.appendMessage(f.actor, f.room.id, { role: "user", content: sourceText });
      if (auxiliary) f.repository.appendMessage(f.actor, f.room.id, { role: "user", content: auxiliary });
      const run = generation.accept(f.actor, f.room.id, { requestId: randomUUID(), expectedRoomRevision: f.room.revision,
        content, recipient: { type: "all" }, context: { mode: "archive" } });
      await requestIndexUpdate(f.app, f.policy, f.actor, f.room.id, { force: true });
      await generation.execute(run.runId);
      const result = generation.get(f.actor, f.room.id, run.runId);
      const call = f.app.db.prepare("SELECT manifest_json FROM app_provider_calls WHERE run_id=? AND purpose='answer'").get(run.runId);
      const manifest = call ? JSON.parse(String(call.manifest_json)) : null;
      const envelope = f.provider.calls.at(-1)?.contents.flatMap(c => c.parts).flatMap(p => "text" in p ? [p.text] : [])
        .map(text => { try { return JSON.parse(text!); } catch { return null; } }).find(e => e?.type === "MAP_RETRIEVED_CONTEXT");
      const cited = manifest?.retrieval.sources.find((s: any) => s.citation.messageId === source.id)?.citation;
      const samePayloadWithRange = (end: number) => {
        const sent = f.provider.calls.at(-1);
        if (!sent || !envelope || !cited) return undefined;
        const contents = structuredClone(sent.contents);
        for (const content of contents) for (const part of content.parts) {
          if (!("text" in part) || !part.text) continue;
          let value: any; try { value = JSON.parse(part.text); } catch { continue; }
          if (value?.type !== "MAP_RETRIEVED_CONTEXT") continue;
          const reference = value.references.find((r: any) => r.alias === manifest.retrieval.sources.find((s: any) => s.citation.messageId === source.id).alias);
          reference.text = sourceText.slice(0, end);
          part.text = stable(value);
        }
        return { start: 0, end, requestedSentenceIncluded: sourceText.slice(0, end).includes(sentence),
          estimatedInputTokens: Math.ceil(Buffer.byteLength(sent.systemInstruction + stable(contents), "utf8") / 3),
          note: "Pure packing witness: only the reference text range changes; this payload is not sent." };
      };
      return { status: result.status, errorCode: result.errorCode, maxInputTokens, sourceUtf16Length: sourceText.length,
        providerCalls: f.provider.calls.length, estimatedInputTokens: manifest?.estimatedInputTokens,
        route: manifest?.retrieval.route, citation: cited, sourceId: source.id,
        suppliedText: envelope?.references.find((r: any) => r.alias === manifest?.retrieval.sources.find((s: any) => s.citation.messageId === source.id)?.alias)?.text,
        actualPayloadTokens: f.provider.calls.at(-1) ? Math.ceil(Buffer.byteLength(f.provider.calls.at(-1)!.systemInstruction + stable(f.provider.calls.at(-1)!.contents), "utf8") / 3) : undefined,
        requestedSentenceInPayload: JSON.stringify(envelope ?? null).includes(sentence),
        rawHistoryContainsSource: manifest?.messages.some((m: any) => m.id === source.id),
        envelope, manifest, samePayloadWithSentence: samePayloadWithRange(sentence.length),
        samePayloadWithOriginalHit: samePayloadWithRange(Math.min(768, sourceText.length)) };
    } finally {
      await generation.shutdown(); await f.generation.shutdown(); await shutdownIndexWorkers(f.app); f.dispose();
    }
  };

test("PR41 re-audit F02: a partial quotation protects the requested sentence rather than the whole index hit", async t => {
  const sentence = "cedarの保存先はSQLiteです。";
  const longText = sentence + "\n" + "補足説明です。".repeat(700);
  const quote = "cedarの保存先を述べた冒頭の一文だけを原文のまま引用してください。補足説明は不要です。";
  const ordinary = "cedarの保存先を述べた冒頭の一文だけを確認してください。補足説明は不要です。";
  const shortQuote = await runCase(sentence, quote, 1600, sentence);
  const boundedOrdinary = await runCase(longText, ordinary, 1600, sentence);
  const fullBudgetQuote = await runCase(longText, quote, 16384, sentence);
  const actual = await runCase(longText, quote, 1600, sentence);
  const dir = process.env.PR41_REAUDIT_EVIDENCE_DIR ?? "/tmp/pr41-reaudit-evidence";
  mkdirSync(dir, { recursive: true });
  const evidence = { sentence, requiredUtf16Length: sentence.length, quote, shortQuote, boundedOrdinary, fullBudgetQuote, actual,
    auditedHead: "2beb8c4bcc5836a93348b7e2c5ff11857867a1f2", realProviderCalls: 0 };
  writeFileSync(`${dir}/f02-partial-budget.json`, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ actual: { status: actual.status, citation: actual.citation, estimatedInputTokens: actual.estimatedInputTokens, providerCalls: actual.providerCalls } }));
  assert.equal(shortQuote.status, "COMPLETED", JSON.stringify(shortQuote));
  assert.equal(boundedOrdinary.status, "COMPLETED", JSON.stringify(boundedOrdinary));
  assert(boundedOrdinary.requestedSentenceInPayload);
  assert.equal(fullBudgetQuote.status, "COMPLETED");
  assert.equal(fullBudgetQuote.route.requiresFullSource, false);
  assert(fullBudgetQuote.samePayloadWithOriginalHit!.requestedSentenceIncluded);
  assert(fullBudgetQuote.samePayloadWithOriginalHit!.estimatedInputTokens <= actual.maxInputTokens);
  assert(fullBudgetQuote.samePayloadWithSentence!.estimatedInputTokens <= actual.maxInputTokens);
  assert.equal(actual.status, "COMPLETED", "A short original and its metadata fit; optional index-hit context must not be mandatory");
  assert.equal(actual.route.requiresFullSource, false);
  assert.equal(actual.rawHistoryContainsSource, false);
  assert(actual.requestedSentenceInPayload);
  assert.equal(actual.citation.messageId, actual.sourceId);
  assert.equal(actual.suppliedText, longText.slice(actual.citation.start, actual.citation.end));
  assert.equal(actual.actualPayloadTokens, actual.estimatedInputTokens);
  assert(actual.estimatedInputTokens <= 1600);
  assert.equal(actual.providerCalls, 1);
});

for (const variant of ["opening-tight", "middle-auxiliary", "cross-chunk", "emoji-crlf", "required-overflow"] as const)
  test(`F-02 capacity selects a complete original span: ${variant}`, async () => {
    const sentence = variant === "cross-chunk"
      ? "cedarの保存先は" + "重要な原文".repeat(70) + "SQLiteです。"
      : variant === "emoji-crlf" ? "cedarの保存先は😀SQLiteです。\r\n" : "cedarの保存先はSQLiteです。";
    const prefix = variant === "opening-tight" || variant === "required-overflow" ? "" : "序文です。".repeat(130);
    const source = prefix + sentence + "補足説明です。".repeat(700);
    const maxInputTokens = variant === "cross-chunk" ? 1200 : variant === "required-overflow" ? 700 : 1000;
    const actual = await runCase(source, "cedarの保存先を述べた一文だけを原文のまま引用してください。", maxInputTokens,
      sentence, variant === "middle-auxiliary" ? "cedar 補助資料 " + "補足。".repeat(1800) : undefined);
    if (variant === "required-overflow") {
      assert.equal(actual.status, "FAILED"); assert.equal(actual.errorCode, "CONTEXT_LIMIT");
      assert.equal(actual.providerCalls, 0); return;
    }
    assert.equal(actual.status, "COMPLETED", JSON.stringify(actual));
    assert.equal(actual.providerCalls, 1);
    assert.equal(actual.route.requiresFullSource, false);
    assert.equal(actual.rawHistoryContainsSource, false);
    assert(actual.suppliedText.includes(sentence), JSON.stringify(actual.citation));
    assert.equal(actual.suppliedText, source.slice(actual.citation.start, actual.citation.end));
    assert.equal(actual.actualPayloadTokens, actual.estimatedInputTokens);
    assert(actual.estimatedInputTokens <= maxInputTokens);
    assert(actual.envelope.searches.some((search: any) => search.reasons.includes("EXCERPT_TRUNCATED")));
    for (const offset of [actual.citation.start, actual.citation.end]) {
      assert(!(source[offset - 1] === "\r" && source[offset] === "\n"));
      assert(!(/[\uD800-\uDBFF]/.test(source[offset - 1] ?? "") && /[\uDC00-\uDFFF]/.test(source[offset] ?? "")));
    }
    if (variant === "cross-chunk") {
      assert(prefix.length < 768 && prefix.length + sentence.length > 896, "required sentence crosses both the original chunk and its old 128-unit margin");
      assert(actual.citation.start > 0);
    }
  });
