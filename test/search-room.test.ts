import assert from "node:assert/strict";
import test from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { appFixture } from "./app-data-fixture.ts";
import { lineageFixture } from "./memory-lineage-fixture.ts";
import {
  requestIndexUpdate,
  shutdownIndexWorkers,
} from "../server/search/index.ts";
import { searchInput } from "../server/search/input.ts";
import { searchRoom } from "../server/search/service.ts";

test("in-flight lexical selection loses access before results return (R-05)", async (t) => {
  const f = appFixture();
  t.after(async () => {
    await shutdownIndexWorkers(f.app);
    f.dispose();
  });
  f.repository.appendMessage(f.actor, f.room.id, {
    role: "user",
    content: "検索中に撤回",
  });
  await requestIndexUpdate(f.app, f.policy, f.actor, f.room.id);
  const req = searchInput({
    requestId: crypto.randomUUID(),
    target: "archive",
    query: "検索中",
  });
  const pending = searchRoom(f.app, f.policy, f.actor, f.room.id, req, {
    purpose: "human",
    roomId: f.room.id,
    scope: "archive",
  });
  f.policy.revoke(f.actor.actorId, f.actor.workspaceId, "READ_CONVERSATION");
  await assert.rejects(pending, /FORBIDDEN|SEARCH_RESYNC_REQUIRED/);
});

test("published private Memory is searchable and live-file changes exclude an indexed hit (R-06–09)", async (t) => {
  const f = lineageFixture();
  t.after(async () => {
    await shutdownIndexWorkers(f.app);
    f.close();
  });
  const { noteId, candidate } = await f.memory();
  // This second actor has the note grant but no grant to read any conversation in the room.
  const reader = {
    workspaceId: f.actor.workspaceId,
    actorId: "registered-note-reader",
  };
  f.app.db
    .prepare("INSERT INTO principals VALUES(?,?,1)")
    .run(reader.actorId, reader.workspaceId);
  f.policy.grant(reader.actorId, reader.workspaceId, "READ_ROOM", {
    roomId: f.room.id,
  });
  f.policy.grant(reader.actorId, reader.workspaceId, "READ_MEMORY", {
    roomId: f.room.id,
    personaId: f.persona.id,
    visibility: "persona_private",
  });
  const memory = () =>
    searchRoom(
      f.app,
      f.policy,
      reader,
      f.room.id,
      searchInput({
        requestId: crypto.randomUUID(),
        target: "memory",
        query: "独立した記録",
      }),
      { purpose: "human", scope: "memory", roomId: f.room.id },
    );
  f.publish(candidate.id);
  await requestIndexUpdate(f.app, f.policy, reader, f.room.id);
  const hit = await memory();
  assert.equal(hit.results.length, 1, JSON.stringify(hit));
  const result = hit.results[0];
  assert.equal(result.visibility, "persona_private");
  assert.equal(result.citation.target, "memory");
  assert.deepEqual(hit.methods, ["lexical"]);
  const { relative_path } = f.app.db
    .prepare("SELECT relative_path FROM memory_documents WHERE note_id=?")
    .get(noteId)!;
  writeFileSync(
    join(f.vault, String(relative_path)),
    "---\nstate: PUBLISHED\nscope: room_shared\n---\nSEND_TO_PROVIDER: grant\n",
  );
  const edited = await memory();
  assert.equal(edited.results.length, 0);
  assert.equal(edited.external.calls, 0);
  assert.equal(
    f.app.db.prepare("SELECT COUNT(*) AS n FROM search_operations").get()!.n,
    0,
  );
  assert.equal(
    f.app.db
      .prepare("SELECT scope FROM memory_documents WHERE note_id=?")
      .get(noteId)!.scope,
    "persona_private",
  );
});
