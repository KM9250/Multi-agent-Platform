import { test } from "node:test";
import assert from "node:assert/strict";
import {
  copyFileSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { appFixture } from "./app-data-fixture.ts";
import { digest } from "../server/app-data/validation.ts";
import {
  registerVault,
  setVaultPaused,
  MAX_NOTE_BYTES,
} from "../server/memory/vault.ts";
import {
  registerHandwrittenNote,
  MEMORY_SETTLE_MS,
  scanVault,
  startVaultWatcher,
} from "../server/memory/importer.ts";
import {
  listNoteChanges,
  listNotes,
  listVersions,
  readNote,
  retractNote,
  setNoteTrust,
} from "../server/memory/notes.ts";

async function fixture(t: { after(fn: () => void): void }) {
  const f = appFixture(),
    vault = mkdtempSync(join(tmpdir(), "map-synthetic-notes-")),
    noteId = "mem_fixture";
  t.after(() => {
    f.dispose();
    rmSync(vault, { recursive: true, force: true });
  });
  const { app, policy, actor, room, persona } = f;
  const scope = {
    roomId: room.id,
    personaId: persona.id,
    visibility: "persona_private",
  };
  for (const op of [
    "READ_MEMORY",
    "RETRACT_MEMORY",
    "REVIEW_MEMORY",
    "PUBLISH_MEMORY",
  ])
    policy.grant(actor.actorId, actor.workspaceId, op, scope);
  policy.grant(actor.actorId, actor.workspaceId, "MANAGE_VAULT");
  registerVault(app, vault, { trustNew: true });
  setVaultPaused(app, false);
  const relativePath = "original.md",
    markdown =
      '---\nmap_id: "mem_fixture"\nkind: "episodic"\nscope_hint: "persona_private"\n---\noriginal body';
  const path = join(vault, relativePath);
  writeFileSync(path, markdown);
  const binding = {
    roomId: room.id,
    personaId: persona.id,
    scope: "persona_private",
    noteId,
    relativePath,
    expectedDigest: digest(markdown),
    requestId: "register-note",
    trusted: true,
  };
  await registerHandwrittenNote(app, policy, actor, binding);
  const read = (v?: number) => readNote(app, policy, actor, noteId, v);
  const state = () => listNotes(app, policy, actor, room.id)[0].state;
  return { ...f, markdown, vault, noteId, path, scope, read, state, binding };
}

test("live digest blocks stale content without an event, accepts a stable edit after two observations, and keeps independent history", async (t) => {
  const { app, policy, actor, room, read, state, path, markdown, noteId } =
    await fixture(t);
  assert.equal(read().body, "original body");
  const baseline = listNoteChanges(app, policy, actor, room.id);
  assert.deepEqual(baseline.items.map(item => item.action), ["BASELINE"]);
  writeFileSync(path, markdown.replace("original body", "half"));
  assert.throws(() => read(), { code: "MEMORY_UNAVAILABLE" });
  assert.equal(state(), "DIRTY");
  assert.equal((await scanVault(app)).status, "COMPLETE");
  writeFileSync(
    path,
    markdown.replace(
      "original body",
      "complete [[a.md]] ![remote](https://example.invalid/m.png)",
    ),
  );
  await delay(MEMORY_SETTLE_MS + 10);
  await scanVault(app);
  assert.throws(() => read(), { code: "MEMORY_UNAVAILABLE" });
  await delay(MEMORY_SETTLE_MS + 10);
  await scanVault(app);
  assert.match(read().body, /^complete/);
  assert.equal(read().version, 2);
  assert.equal(read(1).body, "original body");
  assert.deepEqual(
    listVersions(app, policy, actor, noteId).map((x) => x.version),
    [2, 1],
  );
  assert.deepEqual(
    listNoteChanges(app, policy, actor, room.id, baseline.cursor).items.map((c) => c.action),
    ["DIRTY", "BODY_CHANGED"],
  );
});
test("rename, duplicate identity, deletion, unknown files and restore of a matching file", async (t) => {
  const { app, read, state, path, markdown, vault } = await fixture(t),
    moved = join(vault, "shared", "renamed.md");
  mkdirSync(join(vault, "shared"));
  renameSync(path, moved);
  writeFileSync(
    join(vault, "unregistered.md"),
    markdown.replace("mem_fixture", "some_other_id"),
  );
  assert.throws(() => read(), { code: "MEMORY_UNAVAILABLE" });
  await scanVault(app);
  assert.equal(read().scope, "persona_private");
  assert.equal(read().relativePath, "shared/renamed.md");
  copyFileSync(moved, path);
  await scanVault(app);
  assert.equal(state(), "CONFLICT");
  assert.throws(() => read(), { code: "MEMORY_UNAVAILABLE" });
  unlinkSync(path);
  await scanVault(app);
  assert.equal(read().version, 1);
  unlinkSync(moved);
  await scanVault(app);
  assert.equal(state(), "DELETED");
  assert.equal(read(1).body, "original body");
  writeFileSync(moved, markdown);
  await scanVault(app);
  assert.equal(read().version, 1);
});
test("untrusted edits, metadata changes, mistaken IDs, invalid UTF-8, large files and links stay unavailable", async (t) => {
  const { app, policy, actor, noteId, read, state, markdown, path, vault } =
    await fixture(t);
  setNoteTrust(app, policy, actor, noteId, false);
  writeFileSync(path, markdown + " append");
  await scanVault(app);
  assert.equal(state(), "CONFLICT");
  setNoteTrust(app, policy, actor, noteId, true);
  for (const content of [
    markdown.replace("persona_private", "room_shared"),
    markdown.replace("mem_fixture", "mem_forged"),
    markdown.replace('"episodic"', "!!js/function hi"),
    markdown.replace("original body", ""),
    Buffer.concat([Buffer.from(markdown), Buffer.from([0xff])]),
    Buffer.alloc(MAX_NOTE_BYTES + 1),
  ]) {
    writeFileSync(path, content);
    await scanVault(app);
    assert.equal(state(), "CONFLICT");
    assert.throws(() => read());
  }
  const external = join(app.root, "elsewhere.md");
  writeFileSync(external, markdown);
  unlinkSync(path);
  symlinkSync(external, path);
  await scanVault(app);
  assert.equal(state(), "CONFLICT");
  unlinkSync(path);
  linkSync(external, path);
  await scanVault(app);
  assert.equal(state(), "CONFLICT");
  unlinkSync(path);
  mkdirSync(join(vault, "sub"));
  writeFileSync(path, markdown);
  await scanVault(app);
  assert.equal(read().body, "original body");
  assert.equal(readFileSync(external, "utf8"), markdown);
});
test("unauthorized summaries, history, cursor and retraction stay hidden; retraction replay is bound and terminal", async (t) => {
  const { app, policy, actor, room, scope, noteId, read, state } =
    await fixture(t);
  const other = { workspaceId: actor.workspaceId, actorId: "other" };
  app.db
    .prepare("INSERT INTO principals VALUES(?,?,1)")
    .run(other.actorId, actor.workspaceId);
  policy.grant(other.actorId, actor.workspaceId, "READ_ROOM", {
    roomId: room.id,
  });
  policy.grant(other.actorId, actor.workspaceId, "READ_MEMORY", {
    ...scope,
    personaId: "other-persona",
  });
  assert.deepEqual(listNotes(app, policy, other, room.id), []);
  assert.deepEqual(listNoteChanges(app, policy, other, room.id).items, []);
  assert.throws(() => listVersions(app, policy, other, noteId), {
    code: "NOT_FOUND",
  });
  assert.throws(() => readNote(app, policy, other, noteId), {
    code: "NOT_FOUND",
  });
  const binding = {
    expectedVersion: 1,
    expectedDigest: read().digest,
    requestId: "unique",
  };
  const first = retractNote(app, policy, actor, noteId, binding);
  assert.deepEqual(retractNote(app, policy, actor, noteId, binding), first);
  assert.throws(
    () =>
      retractNote(app, policy, actor, noteId, {
        ...binding,
        expectedVersion: 2,
      }),
    { code: "REQUEST_CONFLICT" },
  );
  await scanVault(app);
  assert.equal(state(), "RETRACTED");
  assert.throws(() => read(), { code: "MEMORY_UNAVAILABLE" });
});
test("watcher detects a stable save and ignores paused edits until explicit rescan", async (t) => {
  const { app, read, path, markdown } = await fixture(t);
  const stop = startVaultWatcher(app);
  try {
    writeFileSync(path, markdown + " by editor");
    const end = Date.now() + 5000;
    let found = false;
    while (Date.now() < end) {
      await delay(50);
      try {
        if (read().version === 2) {
          found = true;
          break;
        }
      } catch {}
    }
    assert.ok(found, "watcher finishes stable import");
    setVaultPaused(app, true);
    writeFileSync(path, markdown + " paused");
    assert.equal((await scanVault(app)).status, "PAUSED");
    assert.throws(() => read(), { code: "MEMORY_UNAVAILABLE" });
  } finally {
    await stop();
  }
});

test("scan yields between batches, stops at the documented inventory cap and recovers on a complete pass", async (t) => {
  const { app, read, vault } = await fixture(t);
  const noise = join(vault, "scratch");
  mkdirSync(noise);
  for (let n = 0; n < 4096; n++) writeFileSync(join(noise, "empty-" + n), "");
  let progressed = false;
  setImmediate(() => {
    progressed = true;
  });
  const limited = await scanVault(app);
  assert.ok(progressed, "other event-loop work runs before scan completion");
  assert.equal(limited.status, "LIMIT_REACHED");
  assert.throws(() => read(), { code: "MEMORY_UNAVAILABLE" });
  assert.equal(read(1).body, "original body");
  rmSync(noise, { recursive: true });
  assert.equal((await scanVault(app)).status, "COMPLETE");
  assert.equal(read().body, "original body");
});

test("an observed edit recovers after process restart and publishes one stable version", async (t) => {
  const { app, root, actor, markdown, path, noteId } = await fixture(t);
  writeFileSync(path, markdown + " after restart");
  await scanVault(app);
  app.close();
  const { AppDatabase } = await import("../server/app-data/db.ts");
  const { AuthorizationPolicy } =
    await import("../server/auth/authorization.ts");
  const reopened = new AppDatabase({ root }),
    policy = new AuthorizationPolicy(reopened);
  try {
    assert.throws(() => readNote(reopened, policy, actor, noteId), {
      code: "MEMORY_UNAVAILABLE",
    });
    await delay(MEMORY_SETTLE_MS + 10);
    await Promise.all([scanVault(reopened), scanVault(reopened)]);
    const current = readNote(reopened, policy, actor, noteId);
    assert.equal(current.body, "original body after restart");
    assert.equal(current.version, 2);
    assert.equal(listVersions(reopened, policy, actor, noteId).length, 2);
  } finally {
    reopened.close();
  }
});

test("Host handwritten registration binds the original bytes, registrar and fixed scope; unregistered, forged and duplicate files stay private", async (t) => {
  const { app, policy, actor, read, binding, vault } = await fixture(t);
  const source = read().sourceRefs[0] as Record<string, unknown>;
  assert.deepEqual(
    { ...source, registeredAt: 0 },
    {
      type: "handwritten",
      noteId: binding.noteId,
      version: 1,
      relativePath: binding.relativePath,
      digest: binding.expectedDigest,
      registrar: actor.actorId,
      registeredAt: 0,
    },
  );
  assert.ok(typeof source.registeredAt === "number" && source.registeredAt > 0);
  assert.equal(
    (await registerHandwrittenNote(app, policy, actor, binding)).version,
    1,
  );
  await assert.rejects(
    registerHandwrittenNote(app, policy, actor, { ...binding, trusted: false }),
    { code: "REQUEST_CONFLICT" },
  );
  const noteId = "mem_hand_new",
    path = join(vault, "new.md");
  const clean = "---\nmap_id: mem_hand_new\n---\nplain note";
  const input = {
    ...binding,
    noteId,
    relativePath: "new.md",
    requestId: "register-new",
    expectedDigest: digest(clean),
  };
  writeFileSync(path, clean);
  assert.throws(() => readNote(app, policy, actor, noteId), {
    code: "NOT_FOUND",
  });
  copyFileSync(path, join(vault, "duplicate.md"));
  await assert.rejects(registerHandwrittenNote(app, policy, actor, input), {
    code: "REGISTRATION_CONFLICT",
  });
  unlinkSync(join(vault, "duplicate.md"));
  const forged = clean.replace(
    "map_id: mem_hand_new",
    'map_id: mem_hand_new\nsource_refs: ["message:fake@rev1"]',
  );
  writeFileSync(path, forged);
  await assert.rejects(
    registerHandwrittenNote(app, policy, actor, {
      ...input,
      expectedDigest: digest(forged),
    }),
    { code: "REGISTRATION_CONFLICT" },
  );
  writeFileSync(path, clean + " concurrently changed");
  await assert.rejects(registerHandwrittenNote(app, policy, actor, input), {
    code: "REGISTRATION_CONFLICT",
  });
  assert.equal(readFileSync(path, "utf8"), clean + " concurrently changed");
  policy.revoke(actor.actorId, actor.workspaceId, "REVIEW_MEMORY");
  await assert.rejects(registerHandwrittenNote(app, policy, actor, input), {
    code: "FORBIDDEN",
  });
  policy.grant(actor.actorId, actor.workspaceId, "REVIEW_MEMORY", {
    roomId: binding.roomId,
    personaId: binding.personaId,
    visibility: binding.scope,
  });
  assert.throws(() => read(), { code: "MEMORY_UNAVAILABLE" });
  assert.equal(read(1).historical, true);
  assert.throws(() => readNote(app, policy, actor, noteId), {
    code: "NOT_FOUND",
  });
});

test("handwritten publication to a shared scope checks the explicit scope-change grant", async (t) => {
  const { app, policy, actor, binding, vault } = await fixture(t);
  const scope = {
    roomId: binding.roomId,
    personaId: binding.personaId,
    visibility: "room_shared",
  };
  for (const op of ["READ_MEMORY", "REVIEW_MEMORY", "PUBLISH_MEMORY"])
    policy.grant(actor.actorId, actor.workspaceId, op, scope);
  const noteId = "mem_shared";
  const bytes = "---\nmap_id: mem_shared\n---\nShared text";
  writeFileSync(join(vault, "shared.md"), bytes);
  const input = {
    ...binding,
    scope: "room_shared",
    noteId,
    relativePath: "shared.md",
    expectedDigest: digest(bytes),
    requestId: "register-shared",
  };
  await assert.rejects(registerHandwrittenNote(app, policy, actor, input), {
    code: "FORBIDDEN",
  });
  policy.grant(actor.actorId, actor.workspaceId, "CHANGE_MEMORY_SCOPE", scope);
  await registerHandwrittenNote(app, policy, actor, input);
  assert.equal(readNote(app, policy, actor, noteId).scope, "room_shared");
});

test("a cold inventory spans byte slices and ignores terminal rows retained solely for history", async (t) => {
  const { app, actor, room, persona, vault, read, markdown } = await fixture(t);
  // These rows exercise the inventory query only. No reader can treat terminal rows as current.
  app.transaction(() => {
    const insert = app.db
      .prepare(`INSERT INTO memory_documents(note_id,workspace_id,room_id,owner_persona_id,scope,state,
      relative_path,version,digest,body_digest,trusted) VALUES(?,?,?,?,'persona_private','RETRACTED',?,1,'old','old',0)`);
    for (let n = 0; n < 4100; n++)
      insert.run(
        "old-" + n,
        actor.workspaceId,
        room.id,
        persona.id,
        "old-" + n + ".md",
      );
  });
  for (const n of [1, 2, 3])
    writeFileSync(
      join(vault, "new-" + n + ".md"),
      "---\nmap_id: unknown_" + n + "\n---\n" + "x".repeat(64),
    );
  // The final duplicate must be detected even when its file falls beyond the first byte slice.
  writeFileSync(join(vault, "dup.md"), markdown);
  assert.equal((await scanVault(app, 32)).status, "COMPLETE");
  assert.throws(() => read(), { code: "MEMORY_UNAVAILABLE" });
  unlinkSync(join(vault, "dup.md"));
  assert.equal((await scanVault(app, 32)).status, "COMPLETE");
  assert.equal(read().version, 1);
});

test("F-02 retraction at the watcher gap preserves an unimported external edit and its publication", async (t) => {
  const { app, policy, actor, read, state, path, markdown, noteId } =
    await fixture(t);
  const shown = read();
  const request = {
    requestId: "withdraw-shown",
    expectedVersion: shown.version,
    expectedDigest: shown.digest,
  };
  const edited = markdown.replace(
    "original body",
    "A human saved after confirmation opened",
  );
  writeFileSync(path, edited);
  let response: string;
  try {
    response = retractNote(app, policy, actor, noteId, request).state;
  } catch (error) {
    response = (error as { code: string }).code;
  }
  const receipts = () =>
    app.db
      .prepare(
        "SELECT count(*) AS n FROM memory_retract_requests WHERE note_id=?",
      )
      .get(noteId)!.n;
  assert.deepEqual(
    {
      response,
      state: state(),
      receipts: receipts(),
      file: readFileSync(path, "utf8"),
    },
    {
      response: "REVISION_CONFLICT",
      state: "DIRTY",
      receipts: 0,
      file: edited,
    },
  );

  assert.throws(() => retractNote(app, policy, actor, noteId, request), {
    code: "REVISION_CONFLICT",
  });
  assert.throws(
    () =>
      retractNote(app, policy, actor, noteId, {
        ...request,
        expectedState: "PUBLISHED",
      }),
    { code: "REVISION_CONFLICT" },
  );
  const explicit = { ...request, expectedState: "DIRTY" };
  const result = retractNote(app, policy, actor, noteId, explicit);
  unlinkSync(path);
  assert.deepEqual(retractNote(app, policy, actor, noteId, explicit), result);
  assert.equal(receipts(), 1);
  assert.throws(
    () =>
      retractNote(app, policy, actor, noteId, {
        ...explicit,
        expectedState: "DELETED",
      }),
    { code: "REQUEST_CONFLICT" },
  );
});

test("F-02 deleted files and identity conflicts require acknowledgement of the recorded state", async (t) => {
  for (const outcome of ["DELETED", "CONFLICT"]) {
    const { app, policy, actor, read, state, path, markdown, noteId } =
      await fixture(t);
    const shown = read(),
      request = {
        requestId: "withdraw",
        expectedVersion: shown.version,
        expectedDigest: shown.digest,
        expectedState: shown.state,
      };
    if (outcome === "DELETED") unlinkSync(path);
    else writeFileSync(path, markdown.replace("mem_fixture", "different_note"));
    assert.throws(() => retractNote(app, policy, actor, noteId, request), {
      code: "REVISION_CONFLICT",
    });
    assert.equal(state(), outcome);
    assert.equal(
      retractNote(app, policy, actor, noteId, {
        ...request,
        expectedState: outcome,
      }).state,
      "RETRACTED",
    );
  }
});

test("F-02 identical successful published retraction remains replayable after a later external save", async (t) => {
  const { app, policy, actor, read, path, markdown, noteId } = await fixture(t);
  const shown = read(),
    request = {
      requestId: "withdraw",
      expectedVersion: shown.version,
      expectedDigest: shown.digest,
      expectedState: "PUBLISHED",
    };
  const result = retractNote(app, policy, actor, noteId, request);
  writeFileSync(path, markdown + " later external edit");
  assert.deepEqual(retractNote(app, policy, actor, noteId, request), result);
  assert.equal(
    app.db.prepare("SELECT count(*) AS n FROM memory_retract_requests").get()!
      .n,
    1,
  );
  assert.throws(
    () =>
      retractNote(app, policy, actor, noteId, {
        ...request,
        expectedState: "DIRTY",
      }),
    { code: "REQUEST_CONFLICT" },
  );
  assert.equal(readFileSync(path, "utf8"), markdown + " later external edit");
});

test("F-02 a successful receipt created before state-bound requests replays with current authorization", async (t) => {
  const { app, policy, actor, read, path, noteId } = await fixture(t);
  const shown = read(),
    request = {
      requestId: "older-request",
      expectedVersion: shown.version,
      expectedDigest: shown.digest,
    };
  // Receipt and document shape written by the earlier MEM-1 build, which had no state-binding entry.
  app.transaction(() => {
    app.db
      .prepare("INSERT INTO memory_retract_requests VALUES(?,?,?,?,?,?)")
      .run(
        actor.workspaceId,
        actor.actorId,
        request.requestId,
        noteId,
        shown.version,
        shown.digest,
      );
    app.db
      .prepare("UPDATE memory_documents SET state='RETRACTED' WHERE note_id=?")
      .run(noteId);
  });
  unlinkSync(path);
  assert.deepEqual(retractNote(app, policy, actor, noteId, request), {
    noteId,
    version: 1,
    state: "RETRACTED",
  });
  assert.throws(
    () =>
      retractNote(app, policy, actor, noteId, {
        ...request,
        expectedState: "DELETED",
      }),
    { code: "REQUEST_CONFLICT" },
  );
  policy.revoke(actor.actorId, actor.workspaceId, "RETRACT_MEMORY");
  assert.throws(() => retractNote(app, policy, actor, noteId, request), {
    code: "FORBIDDEN",
  });
  assert.equal(
    app.db.prepare("SELECT count(*) AS n FROM memory_retract_requests").get()!
      .n,
    1,
  );
});
