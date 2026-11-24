import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ArchiveRef, SearchSource } from "../shared/search-sources.ts";
import {
  SQLiteSearchBackend,
  type LexicalFilter,
  type SearchBackend,
} from "../server/search/backend.ts";
import { ReferenceSearchBackend } from "../server/search/backend-reference.ts";
import { chunkRanges, CHUNK_LENGTH } from "../server/search/chunk.ts";
import { analyzeQuery } from "../server/search/lexical.ts";

function source(
  n: number,
  text: string,
  overrides: Partial<SearchSource> = {},
): SearchSource {
  const ref: ArchiveRef = {
    target: "archive",
    workspaceId: "w",
    roomId: "r",
    messageId: "msg-" + n,
    revisionId: "rev-" + n,
    segmentId: "seg-" + n,
    version: 1,
    segmentDigest: "hash-" + n,
  };
  return {
    ...ref,
    sourceId: ref.segmentId,
    groupId: ref.messageId,
    ref,
    current: true,
    personaId: null,
    speakerId: null,
    role: "user",
    visibility: "public",
    channel: "public_message",
    recordedAt: n,
    text,
    ...overrides,
  };
}
const archive: LexicalFilter = {
  target: "archive",
  query: "",
  allowsScope: () => true,
  eligible: () => true,
};
for (const [name, create] of Object.entries({
  sqlite: () => new SQLiteSearchBackend(":memory:", { create: true }),
  reference: () => new ReferenceSearchBackend(),
})) {
  test(
    name +
      " searches Japanese short forms, IDs, punctuation, mixed and full-width terms, late passages",
    () => {
      const db: SearchBackend = create();
      try {
        const doc = source(
          1,
          "別".repeat(3213) +
            "\r\n終端の猫、設計ＤＢとＰＲ３９。/memory 🙂 e\u0301",
        );
        const other = source(2, "開発会議で検索した");
        db.applyPage({ deletes: [], upserts: [doc, other] });
        for (const query of [
          "猫",
          "設計",
          "DB",
          "PR39",
          "/memory",
          "🙂",
          "設計DB",
          "設計、「ＤＢ」",
          "é",
        ]) {
          const hits = db.query({ ...archive, query }).hits;
          assert.equal(hits.length, 1, query);
          const cite = hits[0].citation;
          assert.equal(cite.target, "archive");
          assert.equal((cite as ArchiveRef).segmentId, "seg-1");
          assert.ok(cite.start > 0);
          assert.match(doc.text.slice(cite.start, cite.end), /終端の猫/);
        }
        assert.equal(
          (
            db.query({ ...archive, query: "msg-2" }).hits[0]
              .citation as ArchiveRef
          ).segmentId,
          "seg-2",
        );
        assert.ok(
          db
            .query({ ...archive, query: "過去の開発会議を探したい" })
            .hits.some((h) => (h.citation as ArchiveRef).segmentId === "seg-2"),
        );
        assert.doesNotThrow(() =>
          db.query({ ...archive, query: '" OR x* NEAR( : )' }),
        );
        assert.deepEqual(
          db.query({ ...archive, query: "no-match-xyz" }).hits,
          [],
        );
        assert.throws(() => db.query({ ...archive, query: "猫".repeat(513) }));
      } finally {
        db.close();
      }
    },
  );

  test(
    name + " prefilters scopes, ref access, history, date and persona before K",
    () => {
      const db: SearchBackend = create();
      try {
        const weak = Array.from({ length: 115 }, (_, i) =>
          source(i + 1, "設計", { recordedAt: 11 }),
        );
        db.applyPage({
          deletes: [],
          upserts: [
            ...weak,
            source(401, "設計 猫", { recordedAt: 5, personaId: "A" }),
            source(402, "設計 猫", { recordedAt: 11, visibility: "private" }),
            source(403, "設計 猫", { recordedAt: 11, current: false }),
            source(404, "設計 猫", { recordedAt: 11 }),
            source(405, "設計 猫", { recordedAt: 4 }),
          ],
        });
        const filter = {
          ...archive,
          query: "設計 猫",
          limit: 1,
          from: 5,
          until: 19,
          allowsScope: (_target, _persona, visibility) =>
            visibility === "public",
          eligible: (ref: ArchiveRef) => ref.segmentId !== "seg-404",
        };
        const approx = db.query(filter);
        assert.equal(approx.limited, true);
        assert.equal(
          (approx.hits[0].citation as ArchiveRef).segmentId,
          "seg-401",
        );
        assert.ok(
          db
            .query({ ...filter, from: 11, until: 12 })
            .hits.every((h) => h.recordedAt === 11),
        );
        assert.equal(
          db.query({ ...filter, personaId: "unknown" }).hits.length,
          0,
        );
        assert.equal(
          db.query({ ...filter, query: "seg-403", includeHistory: true })
            .hits[0].current,
          false,
        );
      } finally {
        db.close();
      }
    },
  );

  test(
    name +
      " atomic page replay, tombstone, cursor compare-and-swap and backend-neutral citations",
    () => {
      const db: SearchBackend = create();
      try {
        const doc = source(9, "引用テスト");
        const first = {
          upserts: [doc],
          deletes: [],
          expectedCursor: null,
          cursor: { stream: "archive", value: "first" },
        };
        db.applyPage(first);
        db.applyPage(first);
        assert.deepEqual(db.coverage(), { archive: 1, memory: 0 });
        assert.equal(db.getCursor("archive"), "first");
        assert.deepEqual(
          db.query({ ...archive, query: "引用" }).hits[0].citation,
          { ...doc.ref, start: 0, end: doc.text.length },
        );
        const remove = {
          upserts: [],
          deletes: [{ target: "archive" as const, id: doc.groupId }],
          cursor: { stream: "archive", value: "next" },
        };
        assert.throws(() => db.applyPage({ ...remove, expectedCursor: null }));
        assert.equal(db.getCursor("archive"), "first");
        assert.equal(db.coverage().archive, 1);
        db.applyPage({ ...remove, expectedCursor: "first" });
        db.validate();
        assert.equal(db.coverage().archive, 0);
        assert.equal(db.query({ ...archive, query: "引用" }).hits.length, 0);
      } finally {
        db.close();
      }
    },
  );
}

test("Unicode analyzer and chunk boundaries use their respective coordinate systems", () => {
  assert.ok(analyzeQuery("🙂🙂").short.includes("🙂🙂"));
  const text =
    "あ".repeat(CHUNK_LENGTH - 1) +
    "🙂" +
    "e\u0301\r\n".repeat(400) +
    "\r\n\r\n# 見出し\r\n本文";
  let covered = 0;
  for (const range of chunkRanges(text, true)) {
    assert.ok(range.start <= covered);
    assert.ok(range.end - range.start <= CHUNK_LENGTH);
    assert.ok(
      !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(
        text.slice(range.start, range.end),
      ),
    );
    covered = range.end;
  }
  assert.equal(covered, text.length);
});

test("SQLite page fault rolls back document writes and cursor together across reopen", () => {
  const root = mkdtempSync(join(tmpdir(), "map-search-atomic-"));
  const path = join(root, "generation.sqlite");
  let db = new SQLiteSearchBackend(path, { create: true });
  try {
    db.applyPage({
      deletes: [],
      upserts: [source(1, "既存資料")],
      cursor: { stream: "archive", value: "a" },
    });
    db.db.exec(
      "CREATE TEMP TRIGGER diskfault BEFORE INSERT ON short_terms BEGIN SELECT RAISE(ABORT,'injected failure'); END",
    );
    assert.throws(
      () =>
        db.applyPage({
          deletes: [{ target: "archive", id: "msg-1" }],
          upserts: [source(2, "新規資料")],
          cursor: { stream: "archive", value: "b" },
        }),
      /injected failure/,
    );
    db.close();
    db = new SQLiteSearchBackend(path);
    assert.equal(db.getCursor("archive"), "a");
    assert.equal(db.query({ ...archive, query: "既存" }).hits.length, 1);
    assert.equal(db.query({ ...archive, query: "新規" }).hits.length, 0);
    db.validate();
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a copied generation file cannot be opened as a different active generation", () => {
  const root = mkdtempSync(join(tmpdir(), "map-search-generation-"));
  try {
    const from = join(root, "first.sqlite");
    const to = join(root, "second.sqlite");
    const original = new SQLiteSearchBackend(from, { create: true });
    assert.equal(original.generationId, "first");
    original.close();
    copyFileSync(from, to);
    assert.throws(
      () => new SQLiteSearchBackend(to, { readOnly: true }),
      /SEARCH_INDEX_FORMAT/,
    );
    assert.throws(
      () =>
        new SQLiteSearchBackend(join(root, "missing.sqlite"), {
          readOnly: true,
        }),
      /ENOENT/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
