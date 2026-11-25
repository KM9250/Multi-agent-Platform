import assert from "node:assert/strict";
import { closeSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { appFixture } from "./app-data-fixture.ts";
import { SQLiteSearchBackend } from "../server/search/backend.ts";
import { lexicalQuery } from "../server/search/query-process.ts";
import type { LexicalJob } from "../server/search/query-worker.ts";
import { SearchSources } from "../server/search/sources.ts";

function workerFixture(t: { after(fn: () => void): void }) {
  const f = appFixture();
  t.after(f.dispose);
  const sources = new SearchSources(f.app, f.policy, f.actor, f.room.id);
  const cursor = sources.archivePage().cursor;
  const indexPath = join(f.root, "worker-index.sqlite");
  new SQLiteSearchBackend(indexPath, { create: true }).close();
  const job: LexicalJob = {
    root: f.app.root,
    appPath: f.app.path,
    indexPath,
    actor: f.actor,
    idleTimeoutMs: f.policy.idleTimeoutMs,
    roomId: f.room.id,
    query: "猫",
    target: "archive",
    includeHistory: false,
    cursor,
  };
  const query = (changes: Partial<LexicalJob> = {}) =>
    lexicalQuery({ ...job, ...changes }, AbortSignal.timeout(15_000));
  return { ...f, sources, query };
}

test("F-03 lexical subprocess differentiates invalid checkpoints, denied reads and confirmed lag", async (t) => {
  const f = workerFixture(t);
  const memory = f.sources.memoryPage().cursor;
  assert.equal((await f.query()).lagging, false);
  f.repository.appendMessage(f.actor, f.room.id, {
    role: "user",
    content: "猫",
  });
  const lag = await f.query();
  assert.equal(lag.lagging, true);
  assert.deepEqual(lag.hits, []);
  for (const target of ["archive", "memory"] as const)
    await assert.rejects(f.query({ target, cursor: "damaged" }), {
      code: "SEARCH_CURSOR_INVALID",
      status: 409,
    });
  assert.equal(
    (await f.query({ target: "memory", cursor: memory })).lagging,
    false,
  );

  f.policy.revoke(f.actor.actorId, f.actor.workspaceId, "READ_CONVERSATION");
  await assert.rejects(f.query({ cursor: "damaged" }), {
    code: "FORBIDDEN",
    status: 403,
  });
  const inactive = { workspaceId: f.actor.workspaceId, actorId: "inactive" };
  f.app.db
    .prepare("INSERT INTO principals VALUES(?,?,0)")
    .run(inactive.actorId, inactive.workspaceId);
  await assert.rejects(f.query({ actor: inactive }), {
    code: "UNAUTHENTICATED",
    status: 401,
  });
  await assert.rejects(f.query({ roomId: "removed-room", target: "memory" }), {
    code: "NOT_FOUND",
    status: 404,
  });
});

test("F-03 an unreadable freshness index crosses IPC as unavailable, and a missing derived index stays an index error", async (t) => {
  const f = workerFixture(t);
  await assert.rejects(f.query({ indexPath: join(f.root, "missing.sqlite") }), {
    code: "INDEX_UNAVAILABLE",
    status: 503,
  });
  f.repository.appendMessage(f.actor, f.room.id, {
    role: "user",
    content: "猫",
  });
  const pageSize = Number(
    f.app.db.prepare("PRAGMA page_size").get()!.page_size,
  );
  const page = Number(
    f.app.db
      .prepare(
        "SELECT rootpage FROM sqlite_schema WHERE name='search_message_changes'",
      )
      .get()!.rootpage,
  );
  f.app.close();
  // Damage only this disposable fixture's freshness index. Schema identification and session
  // authorization still succeed, so the failure is raised by the worker's metadata query.
  assert.ok(page > 1);
  const file = openSync(f.app.path, "r+");
  try {
    writeSync(file, Buffer.from([0]), 0, 1, (page - 1) * pageSize);
  } finally {
    closeSync(file);
  }
  await assert.rejects(f.query(), {
    code: "SEARCH_FRESHNESS_UNAVAILABLE",
    status: 503,
  });
});
