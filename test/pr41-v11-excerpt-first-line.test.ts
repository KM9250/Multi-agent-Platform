import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { appFixture } from "./app-data-fixture.ts";
import { GenerationCoordinator } from "../server/generation/coordinator.ts";
import { stable } from "../server/generation/types.ts";
import { requestIndexUpdate, shutdownIndexWorkers } from "../server/search/index.ts";

const firstLine = "cedarの保存先はSQLiteです。バックアップは毎日保存します。";
const query = "cedar資料の最初の行だけを原文のまま引用してください。";
const longText = firstLine + "\r\n" + "補足説明です。".repeat(700);

async function runCase(sourceText: string, maxInputTokens: number, request = query) {
  const f = appFixture();
  const generation = new GenerationCoordinator(f.app, f.repository, f.policy, {
    provider: f.provider, defaultModel: "synthetic", limits: { maxInputTokens },
  });
  try {
    f.repository.updatePersona(f.actor, f.room.id, f.persona.id,
      { expectedRevision: 1, historyWindow: 1, pinFirstMessage: false });
    const source = f.repository.appendMessage(f.actor, f.room.id, { role: "user", content: sourceText });
    const run = generation.accept(f.actor, f.room.id, {
      requestId: randomUUID(), expectedRoomRevision: f.room.revision,
      content: request, recipient: { type: "all" }, context: { mode: "archive" },
    });
    await requestIndexUpdate(f.app, f.policy, f.actor, f.room.id, { force: true });
    await generation.execute(run.runId);
    const result = generation.get(f.actor, f.room.id, run.runId);
    const row = f.app.db.prepare("SELECT manifest_json FROM app_provider_calls WHERE run_id=? AND purpose='answer'").get(run.runId);
    const manifest = row ? JSON.parse(String(row.manifest_json)) : null;
    const call = f.provider.calls.at(-1);
    const envelope = call?.contents.flatMap(c => c.parts).flatMap(p => "text" in p ? [p.text] : [])
      .map(text => { try { return JSON.parse(text!); } catch { return null; } })
      .find(value => value?.type === "MAP_RETRIEVED_CONTEXT");
    const reference = manifest?.retrieval.sources.find((s: any) => s.citation.messageId === source.id);
    const suppliedText = envelope?.references.find((r: any) => r.alias === reference?.alias)?.text;
    let lineWitnessTokens: number | undefined;
    if (call && envelope && reference) {
      const contents = structuredClone(call.contents);
      for (const entry of contents) for (const part of entry.parts) {
        if (!("text" in part) || !part.text) continue;
        let value: any; try { value = JSON.parse(part.text); } catch { continue; }
        if (value?.type !== "MAP_RETRIEVED_CONTEXT") continue;
        value.references.find((r: any) => r.alias === reference.alias).text = firstLine + "\r\n";
        part.text = stable(value);
      }
      lineWitnessTokens = Math.ceil(Buffer.byteLength(call.systemInstruction + stable(contents), "utf8") / 3);
    }
    return { status: result.status, errorCode: result.errorCode, maxInputTokens,
      sourceId: source.id, sourceUtf16Length: sourceText.length, query: request, firstLine,
      route: manifest?.retrieval.route, citation: reference?.citation, suppliedText,
      fullFirstLinePresent: suppliedText?.includes(firstLine) ?? false,
      sourceOutsideNormalHistory: !manifest?.messages.some((m: any) => m.id === source.id),
      providerCalls: f.provider.calls.length, estimatedInputTokens: manifest?.estimatedInputTokens,
      actualPayloadTokens: call ? Math.ceil(Buffer.byteLength(call.systemInstruction + stable(call.contents), "utf8") / 3) : undefined,
      lineWitnessTokens, witnessNote: "Same actual request envelope and metadata; reference text alone replaced by the complete first line plus CRLF. Not sent.",
      originalSourceText: sourceText, actualProviderRequest: call,
      envelope, manifest };
  } finally {
    await generation.shutdown(); await f.generation.shutdown(); await shutdownIndexWorkers(f.app); f.dispose();
  }
}

test("PR41 v1.1 re-audit: an explicitly requested first line retains all its sentences", async () => {
  const short = await runCase(firstLine + "\r\n", 1000);
  const roomy = await runCase(longText, 16384);
  const tight = await runCase(longText, 1000);
  const dir = process.env.PR41_V11_EVIDENCE_DIR ?? "/tmp/pr41-v11-reaudit-evidence";
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/f02-first-line-probe.json`, JSON.stringify({
    auditedHead: "1869fb7d0feb82662a7704e0d97e98002cc74022", realProviderCalls: 0,
    firstLine, firstLineUtf16Length: firstLine.length, short, roomy, tight,
  }, null, 2));
  console.log(JSON.stringify({ short: { status: short.status, tokens: short.actualPayloadTokens, full: short.fullFirstLinePresent },
    roomy: { status: roomy.status, tokens: roomy.actualPayloadTokens, full: roomy.fullFirstLinePresent },
    tight: { status: tight.status, citation: tight.citation, tokens: tight.actualPayloadTokens,
      full: tight.fullFirstLinePresent, suppliedText: tight.suppliedText, lineWitnessTokens: tight.lineWitnessTokens } }));
  assert.equal(short.status, "COMPLETED"); assert(short.fullFirstLinePresent);
  assert.equal(roomy.status, "COMPLETED"); assert(roomy.fullFirstLinePresent);
  assert.equal(tight.status, "COMPLETED"); assert.equal(tight.providerCalls, 1);
  assert.equal(tight.route.requiresFullSource, false); assert(tight.sourceOutsideNormalHistory);
  assert.equal(tight.suppliedText, longText.slice(tight.citation.start, tight.citation.end));
  assert.equal(tight.actualPayloadTokens, tight.estimatedInputTokens);
  assert(tight.actualPayloadTokens! <= tight.maxInputTokens);
  assert.equal(tight.citation.messageId, tight.sourceId);
  for (const offset of [tight.citation.start, tight.citation.end])
    assert(!(longText[offset - 1] === "\r" && longText[offset] === "\n"));
  assert(tight.lineWitnessTokens! <= tight.maxInputTokens);
  assert(tight.fullFirstLinePresent, "The requested line has two sentences; both fit, but the second sentence is lost while shrinking.");
});

test("F-02-A English first line preserves both sentences with LF at a tight input cap", async () => {
  const sourceText = firstLine + "\n" + "補足説明です。".repeat(700);
  const actual = await runCase(sourceText, 1000, "Quote only the first line of the cedar source verbatim.");
  assert.equal(actual.status, "COMPLETED", actual.errorCode);
  assert.equal(actual.providerCalls, 1);
  assert(actual.sourceOutsideNormalHistory);
  assert.equal(actual.route.requiresFullSource, false);
  assert(actual.fullFirstLinePresent);
  assert.equal(actual.citation.messageId, actual.sourceId);
  assert.equal(actual.suppliedText, sourceText.slice(actual.citation.start, actual.citation.end));
  assert.equal(actual.actualPayloadTokens, actual.estimatedInputTokens);
  assert(actual.actualPayloadTokens! <= actual.maxInputTokens);
});
