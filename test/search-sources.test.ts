import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { appFixture } from "./app-data-fixture.ts";
import { lineageFixture } from "./memory-lineage-fixture.ts";
import { SearchSources } from "../server/search/sources.ts";
import type { SourcePage, SearchSource } from "../shared/search-sources.ts";

function applyPage(index: Map<string, SearchSource>, page: SourcePage) {
  const deletes = new Set(page.deletes);
  for (const [id, source] of index)
    if (deletes.has(source.groupId)) index.delete(id);
  for (const source of page.upserts) index.set(source.sourceId, source);
}

test("MEM-2 S-09/S-11 R-01/R-02/R-05 history and neighbors reauthorize individual segments", (t) => {
  const f = appFixture();
  t.after(f.dispose);
  const { app, repository: repo, actor, policy, room, persona } = f;
  const sources = new SearchSources(app, policy, actor, room.id);
  const segment = {
    channel: "private_state" as const,
    visibility: "self_only" as const,
    content: "秘匿",
  };
  repo.appendMessage(actor, room.id, {
    role: "model",
    personaId: persona.id,
    segments: [segment],
  });
  const msg = repo.appendMessage(actor, room.id, {
    role: "model",
    personaId: persona.id,
    occurredAt: 8,
    segments: [
      {
        channel: "public_message",
        visibility: "public",
        content: "正😀\r\ne\u0301",
      },
      segment,
    ],
  });
  repo.appendMessage(actor, room.id, { role: "user", content: "周辺" });
  const publicPage = sources.archivePage();
  assert.deepEqual(
    publicPage.upserts.map((x) => x.text),
    ["正😀\r\ne\u0301", "周辺"],
  );
  const quote = { ...publicPage.upserts[0].ref, start: 1, end: 7 };
  const opened = sources.resolve(quote, { surrounding: 2 });
  assert.equal(opened.text, "😀\r\ne\u0301");
  assert.equal(opened.recordedAt, 8);
  assert.equal(opened.revisionKind, "original");
  assert.deepEqual(
    opened.surrounding.map((e) => e.text),
    ["周辺"],
  );
  assert.throws(
    () => sources.resolve({ ...quote, start: 2 }),
    /INVALID_CITATION_RANGE/,
  );
  assert.throws(
    () => sources.resolve({ ...quote, roomId: "other" }),
    /NOT_FOUND/,
  );
  assert.throws(
    () => sources.resolve({ ...quote, workspaceId: "other" }),
    /NOT_FOUND/,
  );
  assert.throws(
    () => sources.resolve({ ...quote, end: 30 }),
    /INVALID_CITATION_RANGE/,
  );

  policy.grant(actor.actorId, actor.workspaceId, "READ_PRIVATE_SEGMENT", {
    roomId: room.id,
    personaId: persona.id,
    visibility: "self_only",
  });
  assert.throws(
    () => sources.archivePage(publicPage.cursor),
    /SEARCH_RESYNC_REQUIRED/,
  );
  const privatePage = sources.archivePage();
  const privateQuote = { ...privatePage.upserts[0].ref, start: 0, end: 2 };
  assert.equal(sources.resolve(privateQuote).text, "秘匿");
  assert.deepEqual(
    privatePage.upserts.map((x) => x.text),
    ["秘匿", "正😀\r\ne\u0301", "秘匿", "周辺"],
  );
  repo.appendRevision(actor, room.id, msg.id, {
    expectedRevision: 1,
    reason: "regeneration",
    content: "訂正版",
  });
  assert.equal(sources.eligible(quote, false), false);
  assert.equal(sources.eligible(quote, true), true);
  assert.throws(() => sources.resolve(quote), /SOURCE_CHANGED/);
  assert.deepEqual(
    [
      sources.resolve(quote, { includeHistory: true }).text,
      sources.resolve(quote, { includeHistory: true }).current,
    ],
    [opened.text, false],
  );

  policy.revoke(actor.actorId, actor.workspaceId, "READ_PRIVATE_SEGMENT");
  assert.equal(sources.eligible(privateQuote, true), false);
  assert.throws(
    () => sources.resolve(privateQuote, { includeHistory: true }),
    /NOT_FOUND/,
  );
  repo.deletePersona(actor, room.id, persona.id, { expectedRevision: 1 });
  assert.equal(sources.eligible(quote, true), false);
  assert.throws(
    () => sources.resolve(quote, { includeHistory: true }),
    /NOT_FOUND/,
  );
  assert.deepEqual(
    sources.archivePage().upserts.map((x) => x.text),
    ["周辺"],
  );
  repo.deleteRoom(actor, room.id, { expectedRevision: 1 });
  assert.throws(() => sources.archivePage(), /NOT_FOUND/);
});

test("MEM-2 C-01/C-02 baseline cutoff, >200 revisions, message tombstone and replay", (t) => {
  const f = appFixture();
  t.after(f.dispose);
  const { repository: repo, app, policy, actor, room } = f;
  const sources = new SearchSources(app, policy, actor, room.id);
  const obsolete = repo.appendMessage(actor, room.id, {
    role: "user",
    content: "消す",
  });
  const changed = repo.appendMessage(actor, room.id, {
    role: "user",
    content: "v1",
  });
  app.transaction(() => {
    for (let version = 1; version < 206; version++)
      repo.correctMessage(actor, room.id, changed.id, {
        expectedRevision: version,
        content: "v" + (version + 1),
      });
  });
  const first = sources.archivePage();
  assert.equal(first.hasMore, true);
  const index = new Map<string, SearchSource>();
  applyPage(index, first);
  repo.deleteMessage(actor, room.id, obsolete.id, { expectedRevision: 1 });
  repo.correctMessage(actor, room.id, changed.id, {
    expectedRevision: 206,
    content: "v207",
  });
  const newcomer = repo.appendMessage(actor, room.id, {
    role: "user",
    content: "新規",
  });
  let page = first;
  do {
    page = sources.archivePage(page.cursor);
    assert.equal(page.mode, "baseline");
    applyPage(index, page);
  } while (page.hasMore);
  assert.equal(
    [...index.values()].filter((s) => s.groupId === changed.id).length,
    206,
  );
  assert.equal(
    [...index.values()].some((s) => s.groupId === newcomer.id),
    false,
  );
  const firstDelta = sources.archivePage(page.cursor);
  assert.ok(firstDelta.deletes.includes(obsolete.id));
  assert.deepEqual(sources.archivePage(page.cursor), firstDelta);
  page = firstDelta;
  for (;;) {
    applyPage(index, page);
    if (!page.hasMore) break;
    page = sources.archivePage(page.cursor);
  }
  assert.deepEqual(
    [...index.values()]
      .filter((s) => s.current)
      .map((s) => s.text)
      .sort(),
    ["v207", "新規"],
  );
  assert.equal(index.size, 208);
  assert.deepEqual(sources.archivePage(page.cursor).deletes, []);
});

test("MEM-2 R-03/R-06/R-07 shared Memory uses live published bytes without granting private origin", async (t) => {
  const f = lineageFixture();
  t.after(f.close);
  const { actor, policy, app, room, persona } = f;
  const sharedScope = {
    roomId: room.id,
    personaId: persona.id,
    visibility: "room_shared",
  };
  const privateScope = { ...sharedScope, visibility: "persona_private" };
  policy.grant(actor.actorId, actor.workspaceId, "EDIT_MEMORY", privateScope);
  for (const op of ["PUBLISH_MEMORY", "CHANGE_MEMORY_SCOPE", "READ_MEMORY"])
    policy.grant(actor.actorId, actor.workspaceId, op, sharedScope);
  const { candidate, outputId } = await f.memory();
  const published = f.candidates.edit(actor, room.id, candidate.id, {
    requestId: "share",
    expectedRevision: candidate.revision,
    body: "共通の判断",
    kind: candidate.kind,
    assertionType: candidate.assertionType,
    scope: "room_shared",
  });
  f.publish(published.id);
  const viewer = { workspaceId: actor.workspaceId, actorId: "note-only" };
  app.db
    .prepare("INSERT INTO principals VALUES(?,?,1)")
    .run(viewer.actorId, viewer.workspaceId);
  policy.grant(viewer.actorId, viewer.workspaceId, "READ_MEMORY", sharedScope);
  policy.grant(viewer.actorId, viewer.workspaceId, "READ_ROOM", {
    roomId: room.id,
  });
  policy.grant(viewer.actorId, viewer.workspaceId, "READ_CONVERSATION", {
    roomId: room.id,
  });
  const sources = new SearchSources(app, policy, viewer, room.id);
  const { upserts, cursor } = sources.memoryPage();
  assert.equal(sources.hasUnindexedChanges("memory", cursor), false);
  assert.equal(upserts.length, 1);
  const publishedQuote = { ...upserts[0].ref, start: 0, end: 5 };
  assert.equal(sources.resolve(publishedQuote).text, "共通の判断");
  assert.ok(
    !JSON.stringify(sources.resolve(publishedQuote)).includes(outputId),
  );
  const approver = new SearchSources(app, policy, actor, room.id);
  const origin = approver
    .archivePage()
    .upserts.find((s) => s.groupId === outputId)!;
  assert.equal(origin.visibility, "self_only");
  assert.equal(sources.eligible(origin.ref), false);
  assert.throws(
    () => sources.resolve({ ...origin.ref, start: 0, end: 1 }),
    /NOT_FOUND/,
  );
  const path = String(
    app.db
      .prepare("SELECT relative_path FROM memory_documents WHERE note_id=?")
      .get(upserts[0].sourceId)!.relative_path,
  );
  writeFileSync(join(f.vault, path), "edited outside the app");
  assert.throws(() => sources.resolve(publishedQuote), /MEMORY_UNAVAILABLE/);
  assert.equal(sources.hasUnindexedChanges("memory", cursor), true);
  assert.equal(sources.eligible(publishedQuote), false);
  assert.throws(
    () => sources.resolve(publishedQuote, { includeHistory: true }),
    /NOT_FOUND/,
  );
});

test("MEM-2 candidate snapshot does not cache grant decisions across revocation", (t) => {
  const f = appFixture();
  t.after(f.dispose);
  const { repository: repo, app, actor, room, persona, policy } = f;
  const sources = new SearchSources(app, policy, actor, room.id);
  const grant = {
    roomId: room.id,
    personaId: persona.id,
    visibility: "self_only",
  };
  policy.grant(actor.actorId, actor.workspaceId, "READ_PRIVATE_SEGMENT", grant);
  repo.appendMessage(actor, room.id, {
    role: "model",
    personaId: persona.id,
    segments: [
      { channel: "private_state", visibility: "self_only", content: "候補" },
    ],
  });
  const ref = sources.archivePage().upserts[0].ref;
  const allowed = () =>
    sources.allowsScope("archive", persona.id, "self_only", "private_state") &&
    sources.eligible(ref);
  assert.equal(sources.withCandidateSnapshot("archive", allowed), true);
  policy.revoke(actor.actorId, actor.workspaceId, "READ_PRIVATE_SEGMENT");
  assert.equal(sources.withCandidateSnapshot("archive", allowed), false);
  assert.throws(
    () => sources.resolve({ ...ref, start: 0, end: 1 }),
    /NOT_FOUND/,
  );
});

test("MEM-2 lag probe reports only actor-visible local changes, including a deletion", (t) => {
  const f = appFixture();
  t.after(f.dispose);
  const { repository, room, persona, actor, app, policy } = f;
  const other = repository.createRoom(actor, { title: "Other" });
  const sources = new SearchSources(app, policy, actor, room.id);
  const before = sources.archivePage().cursor;
  app.transaction(() => {
    for (let i = 0; i < 80; i++) {
      repository.appendMessage(actor, other.id, {
        role: "user",
        content: "other room",
      });
      repository.appendMessage(actor, room.id, {
        role: "model",
        personaId: persona.id,
        segments: [
          {
            visibility: "self_only",
            channel: "private_state",
            content: "not visible",
          },
        ],
      });
    }
  });
  assert.equal(sources.hasUnindexedChanges("archive", before), false);
  const added = repository.appendMessage(actor, room.id, {
    role: "user",
    content: "in this room",
  });
  assert.equal(sources.hasUnindexedChanges("archive", before), true);
  const active = sources.archivePage().cursor;
  assert.equal(sources.hasUnindexedChanges("archive", active), false);
  repository.correctMessage(actor, room.id, added.id, {
    expectedRevision: 1,
    content: "fixed",
  });
  const revised = sources.archivePage(active);
  const current = revised.upserts.find((s) => s.current)!;
  assert.equal(
    sources.resolve({ ...current.ref, start: 0, end: 1 }).revisionKind,
    "correction",
  );
  repository.deleteMessage(actor, room.id, added.id, { expectedRevision: 2 });
  assert.equal(sources.hasUnindexedChanges("archive", revised.cursor), true);
});
