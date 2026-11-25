import assert from "node:assert/strict";
import test from "node:test";
import type { SearchCitation } from "../shared/search-sources.ts";
import {
  acquireActiveIndex,
  requestIndexUpdate,
  shutdownIndexWorkers,
} from "../server/search/index.ts";
import { SearchSources } from "../server/search/sources.ts";
import { searchRoom } from "../server/search/service.ts";
import { searchInput } from "../server/search/input.ts";
import { lineageFixture } from "./memory-lineage-fixture.ts";

test("F-03 persona deletion invalidates only partitions linked to that room-visible persona", async (t) => {
  const f = lineageFixture({ useDefaultPersona: true });
  const { app, policy, repository, room, persona, actor } = f;
  t.after(async () => {
    await shutdownIndexWorkers(app);
    f.close();
  });
  const otherRoom = repository.createRoom(actor, {
    title: "A different operator's room",
  });
  const unrelated = repository.createPersona(actor, otherRoom.id, {
    name: "Unrelated",
    model: "synthetic",
  });
  // A Persona can be referenced in more than one room. The delete event records only the initiating room.
  app.db
    .prepare("INSERT INTO room_personas VALUES(?,?,?,1,1)")
    .run(actor.workspaceId, otherRoom.id, persona.id);
  const reader = { workspaceId: actor.workspaceId, actorId: "limited-reader" };
  app.db
    .prepare("INSERT INTO principals VALUES(?,?,1)")
    .run(reader.actorId, reader.workspaceId);
  for (const op of ["READ_ROOM", "READ_CONVERSATION"])
    policy.grant(reader.actorId, reader.workspaceId, op, { roomId: room.id });
  policy.grant(reader.actorId, reader.workspaceId, "READ_MEMORY", {
    roomId: room.id,
    personaId: persona.id,
    visibility: "persona_private",
  });
  assert.equal(
    policy.can(reader, "READ_ROOM", { roomId: otherRoom.id }),
    false,
  );

  const note = await f.memory();
  f.publish(note.candidate.id);
  const message = repository.appendMessage(actor, room.id, {
    role: "model",
    personaId: persona.id,
    content: "索引試験",
  });
  const sync = () =>
    requestIndexUpdate(app, policy, reader, room.id, { force: true });
  await sync();
  function active() {
    const a = acquireActiveIndex(app, policy, reader, room.id);
    assert.equal(a.state, "ACTIVE");
    return a;
  }
  const sources = new SearchSources(app, policy, reader, room.id);
  const saved = active();
  const cursor = saved.manifest.positions.archive;
  const read = async (target: "memory" | "archive", query: string) =>
    searchRoom(
      app,
      policy,
      reader,
      room.id,
      searchInput({
        target,
        query,
        requestId: crypto.randomUUID(),
        retrievalMode: "lexical",
      }),
      { purpose: "human", scope: target, roomId: room.id },
    );
  const memory = (await read("memory", "独立した記録")).results[0].citation;
  const archive = (await read("archive", "索引試験")).results[0].citation;
  assert.ok(memory.target === "memory" && memory.noteId === note.noteId);
  assert.ok(archive.target === "archive" && archive.messageId === message.id);
  const roomAcl = policy.revision(reader);

  repository.deletePersona(actor, otherRoom.id, unrelated.id, {
    expectedRevision: 1,
  });
  assert.equal(policy.revision(reader), roomAcl);
  assert.equal(sources.hasUnindexedChanges("archive", cursor), false);
  assert.deepEqual(sources.archivePage(cursor).deletes, []);
  await sync();
  assert.equal(active().generationId, saved.generationId);
  const afterNoise = await read("archive", "索引試験");
  assert.equal(afterNoise.status, "ready");
  assert.deepEqual(afterNoise.reasons, []);

  const previous = active();
  repository.deletePersona(actor, otherRoom.id, persona.id, {
    expectedRevision: 1,
  });
  assert.equal(policy.revision(reader), roomAcl);
  assert.equal(
    sources.hasUnindexedChanges("archive", previous.manifest.positions.archive),
    true,
  );
  assert.throws(
    () => sources.archivePage(previous.manifest.positions.archive),
    /SEARCH_RESYNC_REQUIRED/,
  );
  for (const citation of [archive, memory] as SearchCitation[]) {
    assert.equal(sources.eligible(citation, true), false);
    assert.throws(() =>
      sources.resolve(citation, {
        includeHistory: citation.target === "archive",
      }),
    );
  }
  await assert.rejects(sync(), /RESYNC_REQUIRED/);
  assert.equal(
    acquireActiveIndex(app, policy, reader, room.id).state,
    "RESYNC_REQUIRED",
  );
  await sync();
  assert.notEqual(active().generationId, saved.generationId);
  for (const [target, query] of [
    ["archive", "索引試験"],
    ["memory", "独立した記録"],
  ] as const) {
    const refreshed = await read(target, query);
    assert.equal(refreshed.status, "ready");
    assert.deepEqual(refreshed.results, []);
  }
});
