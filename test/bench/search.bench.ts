/** Isolated derived-store benchmark. Synthetic Actor filters only; see search-coexist for live checks. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { cpus, platform, release, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  SQLiteSearchBackend,
  type CandidateFilter,
} from "../../server/search/backend.ts";
import type { ArchiveRef, SearchSource } from "../../shared/search-sources.ts";

const messages = Number(process.env.MAP_SEARCH_BENCH_MESSAGES ?? 100000);
const trials = Number(process.env.MAP_SEARCH_BENCH_TRIALS ?? 30);
if (
  !Number.isInteger(messages) ||
  messages < 10 ||
  messages > 1000000 ||
  !Number.isInteger(trials) ||
  trials < 1 ||
  trials > 1000
)
  throw Error("Invalid corpus or trials");
const quality = JSON.parse(
  readFileSync(
    new URL("../fixtures/search-quality.json", import.meta.url),
    "utf8",
  ),
);
const dir = mkdtempSync(join(tmpdir(), "map-search-bench-"));
const path = join(dir, "bench.sqlite");
const terms = [
  "猫",
  "索引",
  "文書",
  "発表",
  "対話",
  "基準",
  "予定",
  "製品",
  "航空",
  "地図",
  "調査",
  "契約",
  "申請",
  "確認",
  "施設",
  "改善",
];
const examples: Record<number, string> = {
  7: "月面基地の予備電源を点検した",
  8: "白猫の避難所を登録した",
  9: "PR39レビューの確認が完了",
};
const date = Date.UTC(2026, 10, 1);
const day = 86_400_000;
const filter: CandidateFilter = {
  target: "archive",
  allowsScope: (_target, _persona, scope) => scope === "public",
  eligible: () => true,
};
const corpus = {
  historical: 0,
  private: 0,
  public: 0,
  utf16Units: 0,
  segments: 0,
};
function source(i: number, version = 2): SearchSource {
  const text =
    version === 1
      ? "旧記録 調整前"
      : (examples[i] ??
        `会話記録${i}番。${terms[i % 16]}について${terms[(i >> 4) % 16]}の手順を比較した。`);
  const ref: ArchiveRef = {
    target: "archive",
    workspaceId: quality.workspaceId,
    roomId: quality.roomId,
    messageId: "msg-" + i,
    segmentId: `segment-${i}-${version}`,
    revisionId: `revision-${i}-${version}`,
    version,
    segmentDigest: createHash("sha256").update(text).digest("hex"),
  };
  return {
    ...ref,
    text,
    ref,
    sourceId: ref.segmentId,
    groupId: ref.messageId,
    personaId: i % 10 === 0 ? "persona" : null,
    speakerId: null,
    role: "user",
    visibility: i % 10 === 0 ? "self_only" : "public",
    channel: i % 10 === 0 ? "private_state" : "public_message",
    recordedAt: date + (i % 28) * day,
    current: version === 2,
  };
}
function distribution(samples: number[]) {
  const sorted = samples.sort((a, b) => a - b);
  const q = (p: number) =>
    Number(sorted[Math.ceil(samples.length * p) - 1].toFixed(2));
  return { samples: samples.length, p50Ms: q(0.5), p95Ms: q(0.95) };
}

const backend = new SQLiteSearchBackend(path, { create: true });
try {
  const build = performance.now();
  for (let start = 1; start <= messages; start += 250) {
    const upserts: SearchSource[] = [];
    for (let i = start; i <= Math.min(messages, start + 249); i++) {
      if (i % 20 === 0) {
        upserts.push(source(i, 1));
        corpus.historical++;
      }
      upserts.push(source(i));
    }
    for (const d of upserts) {
      corpus[d.visibility === "public" ? "public" : "private"]++;
      corpus.utf16Units += d.text.length;
      corpus.segments++;
    }
    backend.applyPage({
      deletes: [],
      upserts,
      cursor: { stream: "archive", value: String(start) },
    });
  }
  const buildMs = Math.round(performance.now() - build);
  const validation = performance.now();
  backend.validate();
  const validationMs = Math.round(performance.now() - validation);
  const delta = performance.now();
  backend.applyPage({
    deletes: [{ target: "archive", id: "msg-" + messages }],
    upserts: [source(messages)],
    cursor: { stream: "archive", value: "delta" },
  });
  const deltaMs = Number((performance.now() - delta).toFixed(2));
  const qualityScores = quality.cases.map(
    (q: { query: string; relevant: ArchiveRef[] }) => {
      const actual = backend
        .query({ ...filter, query: q.query, limit: 10 })
        .hits.map((h) => h.citation as ArchiveRef);
      const hits = q.relevant.filter((ref) =>
        actual.some(
          (a) =>
            a.target === ref.target &&
            a.workspaceId === ref.workspaceId &&
            a.roomId === ref.roomId &&
            a.segmentId === ref.segmentId &&
            a.messageId === ref.messageId &&
            a.revisionId === ref.revisionId &&
            a.version === ref.version &&
            a.segmentDigest === ref.segmentDigest,
        ),
      ).length;
      return { query: q.query, recallAt10: hits / q.relevant.length };
    },
  );
  assert.ok(
    qualityScores.every((row) => row.recallAt10 === 1),
    "Corrupt lexical fixture results",
  );
  const measurements = {};
  for (const [workload, query, range] of [
    ["allDatesMixed", "猫 手順", {}],
    ["strict", "猫", { from: date + 10 * day, until: date + 11 * day }],
    ["approx", "猫 手順", { from: date + 3 * day, until: date + 18 * day }],
    ["exactId", "msg-7", {}],
  ] as const) {
    const samples = [];
    for (let n = 0; n < trials; n++) {
      const start = performance.now();
      backend.query({ ...filter, query, ...range, limit: 10 });
      samples.push(performance.now() - start);
    }
    measurements[workload] = distribution(samples);
  }
  const sqliteVersion = backend.db
    .prepare("SELECT sqlite_version() AS version")
    .get()?.version;
  console.log(
    JSON.stringify(
      {
        benchmark: "isolated-derived-sqlite",
        environment: {
          platform: platform(),
          kernel: release(),
          cpu: cpus()[0]?.model,
          logicalCpus: cpus().length,
          totalRAMBytes: totalmem(),
          node: process.version,
          sqliteVersion,
        },
        messages,
        corpus: {
          ...corpus,
          meanUtf16Units: corpus.utf16Units / corpus.segments,
        },
        trials,
        buildMs,
        validationMs,
        deltaMs,
        derivedDBBytes: statSync(path).size,
        maxRSSBytes: process.resourceUsage().maxRSS * 1024,
        lexical: measurements,
        syntheticLexicalQuality: qualityScores,
        externalCalls: 0,
        usage: "no external operations",
        originFileReads: "outside isolated benchmark",
        workerWaitAndSave: "measured separately by search-coexist",
      },
      null,
      2,
    ),
  );
} finally {
  backend.close();
  rmSync(dir, { recursive: true, force: true });
}
