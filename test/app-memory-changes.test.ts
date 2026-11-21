import assert from "node:assert/strict";
import test from "node:test";
import { appFixture } from "./app-data-fixture.ts";
import { listNoteChanges } from "../server/memory/notes.ts";

test("baseline and delta pages share gapless, finite cutoffs during concurrent publication", (t) => {
  const f = appFixture();
  t.after(() => f.dispose());
  const { app, policy, actor, room, persona } = f;
  const scope = {
    roomId: room.id,
    personaId: persona.id,
    visibility: "persona_private",
  };
  policy.grant(actor.actorId, actor.workspaceId, "READ_MEMORY", scope);
  const other = { workspaceId: actor.workspaceId, actorId: "another-reader" };
  app.db
    .prepare("INSERT INTO principals VALUES (?,?,1)")
    .run(other.actorId, other.workspaceId);
  policy.grant(other.actorId, other.workspaceId, "READ_ROOM", {
    roomId: room.id,
  });
  policy.grant(other.actorId, other.workspaceId, "READ_MEMORY", scope);

  // Ledger-only fixture: normal document triggers append each event. No file/body read is involved.
  function publish(number: number) {
    const noteId = "mem_feed_" + number;
    const hash = number.toString(16).padStart(64, "0");
    app.db
      .prepare(
        `INSERT INTO memory_documents(note_id,workspace_id,room_id,owner_persona_id,scope,state,
      relative_path,version,digest,body_digest,trusted) VALUES(?,?,?,?,?,'PUBLISHED',?,1,?,?,0)`,
      )
      .run(
        noteId,
        actor.workspaceId,
        room.id,
        persona.id,
        scope.visibility,
        noteId + ".md",
        hash,
        hash,
      );
    app.db
      .prepare("INSERT INTO memory_versions VALUES(?,1,?,?,?,1)")
      .run(noteId, hash, hash, noteId + ".md");
  }
  const page = (after?: string) =>
    listNoteChanges(app, policy, actor, room.id, after);
  const empty = page();
  assert.deepEqual(empty.items, []);
  assert.equal(empty.mode, "baseline");
  assert.equal(empty.hasMore, false);
  assert.equal(page(empty.cursor).mode, "delta");
  assert.throws(
    () => listNoteChanges(app, policy, other, room.id, empty.cursor),
    { code: "MEMORY_RESYNC_REQUIRED" },
  );

  app.transaction(() => {
    for (let n = 0; n < 451; n++) publish(n);
  });
  const first = page();
  assert.equal(first.mode, "baseline");
  assert.equal(first.items.length, 200);
  assert.equal(first.hasMore, true);
  const deltaFromEmpty = page(empty.cursor);
  assert.equal(deltaFromEmpty.items.length, 200);
  assert.equal(deltaFromEmpty.mode, "delta");
  // Change a row whose baseline page is still pending, and add a brand-new note.
  app.transaction(() => {
    app.db
      .prepare(
        "UPDATE memory_documents SET state='DIRTY' WHERE note_id='mem_feed_300'",
      )
      .run();
    publish(451);
  });
  const second = page(first.cursor),
    third = page(second.cursor);
  assert.deepEqual(
    [second.mode, second.hasMore, third.mode, third.hasMore],
    ["baseline", true, "baseline", false],
  );
  const baseline = [...first.items, ...second.items, ...third.items];
  assert.equal(baseline.length, 451);
  assert.equal(new Set(baseline.map((x) => x.noteId)).size, 451);
  assert.ok(
    baseline.every((x) => x.action === "BASELINE" && x.state === "PUBLISHED"),
  );
  assert.equal(
    baseline.find((x) => x.noteId === "mem_feed_300")?.digest,
    (300).toString(16).padStart(64, "0"),
  );

  const latest = page(third.cursor);
  assert.equal(latest.mode, "delta");
  assert.deepEqual(
    latest.items.map((x) => [x.noteId, x.action]),
    [
      ["mem_feed_300", "DIRTY"],
      ["mem_feed_451", "PUBLISHED"],
    ],
  );
  assert.equal(latest.hasMore, false);
  assert.deepEqual(page(latest.cursor).items, []);
  const delta2 = page(deltaFromEmpty.cursor),
    delta3 = page(delta2.cursor);
  const deltas = [...deltaFromEmpty.items, ...delta2.items, ...delta3.items];
  assert.deepEqual(
    deltas.map((x) => x.noteId).sort(),
    baseline.map((x) => x.noteId).sort(),
  );
  assert.equal(new Set(deltas.map((x) => x.changeId)).size, 451);
  assert.deepEqual(page(delta3.cursor).items, latest.items);
  assert.deepEqual(page(first.cursor).items, second.items);
  // Deleting a permitted persona changes visibility even without an ACL grant mutation.
  f.repository.deletePersona(actor, room.id, persona.id, {
    expectedRevision: persona.revision,
  });
  assert.throws(() => page(first.cursor), { code: "MEMORY_RESYNC_REQUIRED" });
  assert.throws(() => page(latest.cursor), { code: "MEMORY_RESYNC_REQUIRED" });
  assert.deepEqual(page().items, []);
});
