import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { noteLoadFixture } from "./memory-note-load-fixture.ts";
import { withVerifiedNoteAncestors, hasVerifiedNoteAncestors } from "../server/memory/source-validation.ts";
import { readNote } from "../server/memory/notes.ts";

test("MEM-3A fresh ancestor capability is synchronous, scoped and discarded after each boundary", async (t) => {
  const f = await noteLoadFixture(65); t.after(f.close);
  assert.equal(hasVerifiedNoteAncestors(f.app, f.rootCandidate), false);
  const body = await withVerifiedNoteAncestors(f.app, [f.rootNote], () => {
    assert.equal(hasVerifiedNoteAncestors(f.app, f.rootCandidate), true);
    return readNote(f.app, f.policy, f.actor, f.rootNote).body;
  });
  assert.equal(body, "予定は月曜"); assert.equal(hasVerifiedNoteAncestors(f.app, f.rootCandidate), false);
  await assert.rejects(withVerifiedNoteAncestors(f.app, [f.rootNote], () => Promise.resolve()), /ASYNC_SOURCE_CALLBACK/);
  assert.equal(hasVerifiedNoteAncestors(f.app, f.rootCandidate), false);
  writeFileSync(f.firstPath, readFileSync(f.firstPath, "utf8").replace("load body", "LOAD body"));
  await assert.rejects(withVerifiedNoteAncestors(f.app, [f.rootNote], () => {}), { code: "SOURCE_CHANGED", status: 409 });
});

test("MEM-3A edit during a yielded earlier ancestor page is caught even when file length stays equal", async (t) => {
  const f = await noteLoadFixture(65); t.after(f.close);
  setImmediate(() => writeFileSync(f.firstPath, readFileSync(f.firstPath, "utf8").replace("load body", "LOAD body")));
  let called = false;
  await assert.rejects(withVerifiedNoteAncestors(f.app, [f.rootNote], () => { called = true; }), /SOURCE_CHANGED/);
  assert.equal(called, false); assert.equal(hasVerifiedNoteAncestors(f.app, f.rootCandidate), false);
});

test("MEM-3A ancestor registration authority still gates the synchronous writer after byte validation", async (t) => {
  const f = await noteLoadFixture(65); t.after(f.close);
  await assert.rejects(withVerifiedNoteAncestors(f.app, [f.rootNote], () => {
    f.policy.revoke(f.actor.actorId, f.actor.workspaceId, "MANAGE_VAULT");
    return readNote(f.app, f.policy, f.actor, f.rootNote);
  }), /MEMORY_UNAVAILABLE|SOURCE_CHANGED/);
  assert.equal(hasVerifiedNoteAncestors(f.app, f.rootCandidate), false);
});
