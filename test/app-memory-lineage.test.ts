import test from "node:test";
import assert from "node:assert/strict";
import { lineageFixture } from "./memory-lineage-fixture.ts";
import { readNote } from "../server/memory/notes.ts";

test("PR39 F-01 two memory exports in a two-message window both follow the original correction", async (t) => {
  const f = lineageFixture();
  t.after(f.close);
  const independent = await f.memory();
  f.publish(independent.candidate.id);
  const original = f.original();
  const first = await f.memory();
  f.publish(first.candidate.id);
  const second = await f.memory();
  f.publish(second.candidate.id);
  assert.equal(first.manifestInputs.length, 2);
  assert.ok(first.manifestInputs.includes(original));
  assert.equal(second.manifestInputs.length, 2);
  assert.ok(second.manifestInputs.includes(first.outputId));
  assert.ok(!second.manifestInputs.includes(original));
  assert.equal(second.candidate.sourceRefs.length, 1);
  assert.ok(
    second.candidate.sourceRefs[0].startsWith(
      "message:" + second.outputId + "@1/",
    ),
  );
  assert.equal(
    readNote(f.app, f.policy, f.actor, second.noteId).body,
    "予定は月曜",
  );
  f.correct(original);
  for (const entry of [first, second]) {
    assert.equal(
      f.candidates.get(f.actor, f.room.id, entry.candidate.id).state,
      "NEEDS_REVIEW",
    );
    assert.throws(
      () => readNote(f.app, f.policy, f.actor, entry.noteId),
      /MEMORY_UNAVAILABLE/,
    );
    assert.equal(
      readNote(f.app, f.policy, f.actor, entry.noteId, 1).body,
      "予定は月曜",
    );
  }
  assert.equal(
    f.repository.getMessage(f.actor, f.room.id, original).content,
    "予定は火曜",
  );
  assert.equal(
    f.repository.getMessage(f.actor, f.room.id, original, 1).content,
    "予定は月曜",
  );
  assert.equal(
    readNote(f.app, f.policy, f.actor, independent.noteId).body,
    "独立した記録",
  );
});

test("PR39 F-01 a corrected ancestor outside the direct window prevents publication of a new derivative", async (t) => {
  const f = lineageFixture();
  t.after(f.close);
  const original = f.original(),
    first = await f.memory();
  f.correct(original);
  const next = await f.memory();
  assert.ok(next.manifestInputs.includes(first.outputId));
  assert.ok(!next.manifestInputs.includes(original));
  assert.equal(
    f.candidates.get(f.actor, f.room.id, next.candidate.id).state,
    "NEEDS_REVIEW",
  );
  assert.throws(() => f.publish(next.candidate.id));
  assert.equal(
    f.app.db.prepare("SELECT COUNT(*) n FROM memory_jobs").get()?.n,
    0,
  );
});

test("PR39 F-01 ancestry crosses an ordinary generated answer with no memory candidate", async (t) => {
  const f = lineageFixture();
  t.after(f.close);
  const input = f.original(),
    runId = await f.turn("要約");
  // A two-message answer window included the original and user instruction. Its output is merely an input to /memory.
  const receipt = f.app.db
    .prepare("SELECT message_id FROM app_generation_receipts WHERE run_id=?")
    .get(runId)!;
  const next = await f.memory();
  assert.ok(next.manifestInputs.includes(String(receipt.message_id)));
  assert.ok(!next.manifestInputs.includes(input));
  f.publish(next.candidate.id);
  f.correct(input);
  assert.equal(
    f.candidates.get(f.actor, f.room.id, next.candidate.id).state,
    "NEEDS_REVIEW",
  );
  assert.throws(
    () => readNote(f.app, f.policy, f.actor, next.noteId),
    /MEMORY_UNAVAILABLE/,
  );
});

test("PR39 F-01 a message attachment also configured as persona context retains both ancestor authorizations", async (t) => {
  const f = lineageFixture();
  t.after(f.close);
  const attachment = await f.attachmentStore.upload(f.actor, f.room.id, {
    name: "calendar.txt",
    mimeType: "text/plain",
    data: Buffer.from("予定は月曜"),
  });
  const config = f.repository.updatePersona(f.actor, f.room.id, f.persona.id, {
    expectedRevision: 2,
    contextAttachmentIds: [attachment.id],
  });
  f.repository.appendMessage(f.actor, f.room.id, {
    role: "user",
    content: "予定",
    attachmentIds: [attachment.id],
  });
  const ancestor = await f.memory();
  f.repository.updatePersona(f.actor, f.room.id, f.persona.id, {
    expectedRevision: config.revision,
    contextAttachmentIds: [],
  });
  const next = await f.memory();
  assert.ok(next.manifestInputs.includes(ancestor.outputId));
  f.publish(next.candidate.id);
  assert.equal(
    readNote(f.app, f.policy, f.actor, next.noteId).body,
    "予定は月曜",
  );
  f.policy.revoke(f.actor.actorId, f.actor.workspaceId, "READ_ATTACHMENT");
  assert.equal(
    f.candidates.get(f.actor, f.room.id, next.candidate.id).state,
    "NEEDS_REVIEW",
  );
  assert.throws(
    () => readNote(f.app, f.policy, f.actor, next.noteId),
    /MEMORY_UNAVAILABLE/,
  );
});
