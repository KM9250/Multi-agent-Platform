import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { appFixture } from "./app-data-fixture.ts";
import { AppDatabase } from "../server/app-data/db.ts";
import { AuthorizationPolicy } from "../server/auth/authorization.ts";
import { MemoryCandidates } from "../server/memory/candidates.ts";
import { publishNext } from "../server/memory/worker.ts";
import { readNote } from "../server/memory/notes.ts";
import { registerVault, setVaultPaused } from "../server/memory/vault.ts";
import { MEMORY_SETTLE_MS, scanVault } from "../server/memory/importer.ts";
import { SessionService } from "../server/auth/sessions.ts";
import {
  BackupService,
  restoreBackup,
  resumeRestore,
} from "../server/operations/backup.ts";

async function generate(f: ReturnType<typeof appFixture>, approve = true) {
  const scope = {
    roomId: f.room.id,
    personaId: f.persona.id,
    visibility: "persona_private",
  };
  for (const operation of [
    "PROPOSE_MEMORY",
    "READ_MEMORY",
    "EDIT_MEMORY",
    "REVIEW_MEMORY",
    "PUBLISH_MEMORY",
  ]) {
    f.policy.grant(f.actor.actorId, f.actor.workspaceId, operation, scope);
  }
  f.policy.grant(f.actor.actorId, f.actor.workspaceId, "READ_PRIVATE_SEGMENT", {
    ...scope,
    visibility: "self_only",
  });
  const room = f.repository.updateRoom(f.actor, f.room.id, {
    expectedRevision: f.room.revision,
    internalStateSettings: { enabled: true },
  });
  const original = f.repository.appendMessage(f.actor, room.id, {
    role: "user",
    content: "A synthetic statement to reconsider.",
  });
  const run = f.generation.accept(f.actor, room.id, {
    requestId: randomUUID(),
    expectedRoomRevision: room.revision,
    content: " /memory ",
    recipient: { type: "all" },
  });
  await f.generation.execute(run.runId);
  const candidates = new MemoryCandidates(f.app, f.policy);
  const { items } = candidates.list(f.actor, room.id);
  assert.equal(items.length, 1);
  const copy = candidates.edit(f.actor, room.id, items[0].id, {
    requestId: randomUUID(),
    expectedRevision: 1,
    body: "Reviewed text",
    kind: "episodic",
    assertionType: "user_assertion",
    scope: "persona_private",
  });
  if (approve)
    candidates.review(f.actor, room.id, {
      requestId: randomUUID(),
      decision: "approve",
      items: [copy.binding],
    });
  return {
    candidates,
    original,
    candidate: copy,
    note: copy.binding.targetNoteId,
    scope,
  };
}

test("MEM-1 correction invalidates an approved but unpublished job in the source transaction", async (t) => {
  const f = appFixture();
  const vault = mkdtempSync(join(tmpdir(), "map-invalidation-"));
  t.after(() => {
    f.dispose();
    rmSync(vault, { force: true, recursive: true });
  });
  registerVault(f.app, vault);
  const { candidates, original, candidate } = await generate(f);
  f.repository.correctMessage(f.actor, f.room.id, original.id, {
    expectedRevision: 1,
    content: "Corrected source.",
  });
  assert.equal(
    candidates.get(f.actor, f.room.id, candidate.id).state,
    "NEEDS_REVIEW",
  );
  setVaultPaused(f.app, false);
  publishNext(f.app, f.policy);
  assert.equal(
    f.app.db.prepare("SELECT count(*) AS n FROM memory_receipts").get()?.n,
    0,
  );
  assert.equal(f.provider.calls.length, 1);
});

test("MEM-1 edited and renamed publication survives backup, isolated restore, and durable ACL withdrawal", async (t) => {
  const f = appFixture();
  const scratch = mkdtempSync(join(tmpdir(), "map-memory-roundtrip-"));
  const vault = join(scratch, "vault");
  let restored: AppDatabase | undefined;
  t.after(() => {
    restored?.close();
    f.dispose();
    rmSync(scratch, { force: true, recursive: true });
  });
  await new SessionService(f.app).createAccount({
    username: "restore-operator",
    password: "synthetic-initial-password",
    workspaceId: f.actor.workspaceId,
  });
  registerVault(f.app, vault, { trustNew: true });
  const { candidates, candidate, note, scope } = await generate(f);
  setVaultPaused(f.app, false);
  assert.equal(publishNext(f.app, f.policy), true);
  const published = readNote(f.app, f.policy, f.actor, note);
  assert.equal(published.body, "Reviewed text");
  const proposal = candidates.propose(f.actor, f.room.id, note, {
    requestId: randomUUID(),
    expectedVersion: published.version,
    expectedDigest: published.digest,
    body: "Proposed text",
  });
  candidates.review(f.actor, f.room.id, {
    requestId: randomUUID(),
    decision: "approve",
    items: [proposal.binding],
  });
  const editedPath = join(vault, "Edited in Obsidian.md");
  renameSync(join(vault, published.relativePath), editedPath);
  writeFileSync(
    editedPath,
    readFileSync(editedPath, "utf8").replace(/Reviewed text$/, "Human edit"),
  );
  assert.throws(() => readNote(f.app, f.policy, f.actor, note));
  assert.equal((await scanVault(f.app)).status, "COMPLETE");
  await delay(MEMORY_SETTLE_MS + 5);
  assert.equal((await scanVault(f.app)).status, "COMPLETE");
  const edited = readNote(f.app, f.policy, f.actor, note);
  assert.equal(edited.body, "Human edit");
  assert.equal(edited.version, 2);
  assert.equal(
    candidates.get(f.actor, f.room.id, proposal.id).state,
    "NEEDS_REVIEW",
  );
  const backup = join(scratch, "backup"),
    restoredRoot = join(scratch, "restore");
  await new BackupService(f.app).backup(backup);
  await restoreBackup(backup, restoredRoot);
  restored = new AppDatabase({ root: restoredRoot });
  assert.equal(publishNext(restored, new AuthorizationPolicy(restored)), false);
  const restoreActor = String(
    restored.db
      .prepare("SELECT actor_id FROM auth_accounts WHERE username=?")
      .get("restore-operator")!.actor_id,
  );
  await new SessionService(restored).resetPassword(
    restoreActor,
    "synthetic-restored-credential",
  );
  restored.close();
  restored = undefined;
  await resumeRestore(restoredRoot);
  restored = new AppDatabase({ root: restoredRoot });
  const restoredPolicy = new AuthorizationPolicy(restored);
  assert.equal(publishNext(restored, restoredPolicy), false);
  assert.equal(
    readNote(restored, restoredPolicy, f.actor, note).body,
    "Human edit",
  );
  assert.equal(
    readNote(restored, restoredPolicy, f.actor, note, 1).body,
    "Reviewed text",
  );
  const restoredFile = join(
    restoredRoot,
    "restored-vault",
    edited.relativePath,
  );
  assert.equal(
    readFileSync(restoredFile, "utf8"),
    readFileSync(editedPath, "utf8"),
  );
  f.policy.revoke(f.actor.actorId, f.actor.workspaceId, "REVIEW_MEMORY");
  f.policy.grant(f.actor.actorId, f.actor.workspaceId, "REVIEW_MEMORY", scope);
  assert.equal(
    candidates.get(f.actor, f.room.id, candidate.id).state,
    "NEEDS_REVIEW",
  );
  assert.throws(() => readNote(f.app, f.policy, f.actor, note));
  assert.equal(readNote(f.app, f.policy, f.actor, note, 2).body, "Human edit");
  assert.match(readFileSync(editedPath, "utf8"), /Human edit$/);
  assert.equal(f.provider.calls.length, 1);
});

test("MEM-1 batch status exposes a file conflict alongside its successfully published sibling", async (t) => {
  const f = appFixture();
  const vault = mkdtempSync(join(tmpdir(), "map-batch-status-"));
  t.after(() => {
    f.dispose();
    rmSync(vault, { force: true, recursive: true });
  });
  registerVault(f.app, vault);
  const { candidates, candidate } = await generate(f, false);
  const run = f.generation.accept(f.actor, f.room.id, {
    requestId: randomUUID(),
    expectedRoomRevision: 2,
    content: "/memory",
    recipient: { type: "all" },
  });
  await f.generation.execute(run.runId);
  const items = candidates.list(f.actor, f.room.id).items;
  assert.equal(items.length, 2);
  const request = {
    requestId: randomUUID(),
    decision: "approve",
    items: items.map((item) => item.binding),
  };
  candidates.review(f.actor, f.room.id, request);
  const existing = join(vault, candidate.binding.targetNoteId + ".md");
  writeFileSync(existing, "A note already saved by its author.");
  setVaultPaused(f.app, false);
  assert.equal(publishNext(f.app, f.policy), true);
  assert.equal(publishNext(f.app, f.policy), true);
  const replay = candidates.review(f.actor, f.room.id, request);
  assert.deepEqual(replay.items.map((row) => row.state).sort(), [
    "CONFLICT",
    "PUBLISHED",
  ]);
  assert.equal(
    candidates.get(f.actor, f.room.id, candidate.id).state,
    "CONFLICT",
  );
  assert.equal(
    readFileSync(existing, "utf8"),
    "A note already saved by its author.",
  );
  assert.equal(
    f.app.db.prepare("SELECT count(*) AS n FROM memory_receipts").get()?.n,
    1,
  );
  assert.equal(f.provider.calls.length, 2);
});
