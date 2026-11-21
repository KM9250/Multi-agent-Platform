// Executed inside the archived b982414 release with that release's coordinator,
// authorization, publication worker, external editor importer and SQLite schema.
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { appFixture } from "./app-data-fixture.ts";
import { PUBLIC_USER_OPERATIONS } from "../server/auth/authorization.ts";
import { MemoryCandidates } from "../server/memory/candidates.ts";
import { scanVault, MEMORY_SETTLE_MS } from "../server/memory/importer.ts";
import { readNote, retractNote } from "../server/memory/notes.ts";
import { publishNext } from "../server/memory/worker.ts";
import { registerVault, setVaultPaused } from "../server/memory/vault.ts";

const f = appFixture();
const vault = join(process.argv[2], "legacy-vault");
registerVault(f.app, vault, { trustNew: true });
setVaultPaused(f.app, false);
f.app.db
  .prepare("INSERT INTO auth_accounts VALUES(?,?,?,1,1)")
  .run(f.actor.actorId, "legacy-host", "synthetic");
const candidates = new MemoryCandidates(f.app, f.policy);
let request = 0;
function configure(actor, room, persona) {
  const scope = {
    roomId: room.id,
    personaId: persona.id,
    visibility: "persona_private",
  };
  for (const operation of [
    "READ_MEMORY",
    "PROPOSE_MEMORY",
    "REVIEW_MEMORY",
    "PUBLISH_MEMORY",
    "RETRACT_MEMORY",
  ])
    f.policy.grant(actor.actorId, actor.workspaceId, operation, scope);
  f.policy.grant(actor.actorId, actor.workspaceId, "READ_PRIVATE_SEGMENT", {
    ...scope,
    visibility: "self_only",
  });
  const config = f.repository.updateRoom(actor, room.id, {
    expectedRevision: 1,
    internalStateSettings: { enabled: true },
  });
  return {
    actor,
    room: room.id,
    persona: persona.id,
    roomRevision: config.revision,
  };
}
async function turn(ctx, content) {
  const run = f.generation.accept(ctx.actor, ctx.room, {
    requestId: "legacy-" + ++request,
    expectedRoomRevision: ctx.roomRevision,
    content,
    recipient: { type: "all" },
  });
  await f.generation.execute(run.runId);
  assert.equal(
    f.generation.get(ctx.actor, ctx.room, run.runId).status,
    "COMPLETED",
  );
  return run.runId;
}
async function memory(ctx, approve = true) {
  const runId = await turn(ctx, "/memory");
  const row = f.app.db
    .prepare(
      `SELECT c.candidate_id FROM memory_candidates c JOIN app_provider_calls p USING(call_id) WHERE p.run_id=?`,
    )
    .get(runId);
  const candidate = candidates.get(ctx.actor, ctx.room, row.candidate_id);
  assert.equal(candidate.state, "PENDING_REVIEW");
  const result = {
    candidate: candidate.id,
    note: candidate.binding.targetNoteId,
  };
  if (!approve) return result;
  candidates.review(ctx.actor, ctx.room, {
    decision: "approve",
    requestId: "review-" + request,
    items: [candidate.binding],
  });
  assert.equal(publishNext(f.app, f.policy), true);
  const published = readNote(f.app, f.policy, ctx.actor, result.note);
  return {
    ...result,
    body: published.body,
    digest: published.digest,
    version: published.version,
  };
}
const main = configure(f.actor, f.room, f.persona);
const settings = f.repository.getPersona(f.actor, main.room, main.persona);
assert.equal(settings.historyWindow, 50);
assert.equal(settings.pinFirstMessage, true);
for (let i = 1; i <= 180; i++)
  await turn(main, i === 2 ? "予定は月曜" : "合成記録 " + i);
const distant = f.app.db
  .prepare(
    "SELECT message_id FROM messages WHERE role='user' AND room_id=? ORDER BY seq LIMIT 1 OFFSET 1",
  )
  .get(main.room).message_id;
const clean = await memory(main);
const edited = await memory(main);
const filename = (id) =>
  join(
    vault,
    String(
      f.app.db
        .prepare("SELECT relative_path FROM memory_documents WHERE note_id=?")
        .get(id).relative_path,
    ),
  );
const editedBody = "本文に追記した合成記録。";
writeFileSync(
  filename(edited.note),
  readFileSync(filename(edited.note), "utf8") + "\n" + editedBody,
);
await scanVault(f.app);
await new Promise((resolve) => setTimeout(resolve, MEMORY_SETTLE_MS + 50));
await scanVault(f.app);
const current = readNote(f.app, f.policy, main.actor, edited.note);
assert.equal(current.version, 2);
edited.body = current.body;
edited.digest = current.digest;
edited.version = current.version;

const pending = await memory(main, false);
const drift = await memory(main);
const withdrawn = await memory(main);
retractNote(f.app, f.policy, main.actor, withdrawn.note, {
  requestId: "withdraw",
  expectedVersion: withdrawn.version,
  expectedDigest: withdrawn.digest,
});
const correctedInput = f.repository.appendMessage(main.actor, main.room, {
  role: "user",
  content: "来週の予定",
});
const corrected = await memory(main);
f.repository.correctMessage(main.actor, main.room, correctedInput.id, {
  expectedRevision: 1,
  content: "訂正済みの予定",
});

// Use a different generating principal so a genuine revoke+regrant cannot
// affect the control room's continued authority.
const actor = {
  actorId: "other-legacy-actor",
  workspaceId: f.actor.workspaceId,
};
f.app.db
  .prepare("INSERT INTO principals VALUES(?,?,1)")
  .run(actor.actorId, actor.workspaceId);
for (const op of PUBLIC_USER_OPERATIONS)
  f.policy.grant(actor.actorId, actor.workspaceId, op);
const otherRoom = f.repository.createRoom(actor, {
  title: "Synthetic revoked room",
});
const otherPersona = f.repository.createPersona(actor, otherRoom.id, {
  name: "Other",
  model: "synthetic",
});
const other = configure(actor, otherRoom, otherPersona);
const revoked = await memory(other);
f.policy.revoke(actor.actorId, actor.workspaceId, "PUBLISH_MEMORY");
f.policy.grant(actor.actorId, actor.workspaceId, "PUBLISH_MEMORY", {
  roomId: other.room,
  personaId: other.persona,
  visibility: "persona_private",
});
const driftFile = filename(drift.note),
  humanBytes = readFileSync(driftFile, "utf8") + "\nUnobserved outside edit.";
writeFileSync(driftFile, humanBytes);

const rows = (sql) => f.app.db.prepare(sql).all();
const immutable = {
  reviews: rows("SELECT * FROM memory_reviews ORDER BY review_id"),
  receipts: rows("SELECT * FROM memory_receipts ORDER BY operation_id"),
  versions: rows("SELECT * FROM memory_versions ORDER BY note_id,version"),
  jobs: rows("SELECT * FROM memory_jobs ORDER BY operation_id"),
  calls: rows("SELECT call_id FROM app_provider_calls ORDER BY call_id").map(
    (r) => r.call_id,
  ),
  generationReceipts: rows(
    "SELECT call_id FROM app_generation_receipts ORDER BY call_id",
  ).map((r) => r.call_id),
};
assert.equal(
  readNote(f.app, f.policy, main.actor, clean.note).body,
  clean.body,
);
assert.equal(
  readNote(f.app, f.policy, main.actor, edited.note).body,
  edited.body,
);
console.log(
  JSON.stringify({
    root: f.root,
    vault,
    main,
    other,
    clean,
    edited,
    pending,
    drift,
    withdrawn,
    corrected,
    revoked,
    distant,
    driftFile,
    humanBytes,
    immutable,
  }),
);
f.app.close();
