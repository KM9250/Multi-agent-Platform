import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdtempSync,
  rmSync,
  statSync,
  unlinkSync,
  symlinkSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AppDatabase } from "../server/app-data/db.ts";
import { ConversationRepository } from "../server/app-data/repository.ts";
import {
  AuthorizationPolicy,
  PUBLIC_USER_OPERATIONS,
} from "../server/auth/authorization.ts";
import {
  acquireActiveIndex,
  requestIndexUpdate,
  manageIndex,
  shutdownIndexWorkers,
  indexWorkerStatus,
  isIndexUpdatePending,
} from "../server/search/index.ts";
import {
  indexDirectory,
  openRegistry,
  type IndexJob,
} from "../server/search/index-registry.ts";
import { configureSearchProfile } from "../server/search/profile.ts";
import { updateGeneration } from "../server/search/index-worker.ts";
import { SearchSources } from "../server/search/sources.ts";
import { runCli } from "../server/cli.ts";
import { acquireHostLock } from "../server/operations/locks.ts";
import { SQLiteSearchBackend } from "../server/search/backend.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "map-search-index-"));
  const app = new AppDatabase({ root }),
    actor = { workspaceId: "w", actorId: "a" };
  app.db.exec(
    "INSERT INTO workspaces VALUES('w',1);INSERT INTO principals(actor_id,workspace_id,active) VALUES('a','w',1)",
  );
  const policy = new AuthorizationPolicy(app);
  for (const operation of PUBLIC_USER_OPERATIONS)
    policy.grant("a", "w", operation);
  const repo = new ConversationRepository(app, policy),
    roomId = repo.createRoom(actor, { title: "R" }).id;
  const binding = { ...actor, roomId },
    dir = indexDirectory(root, binding, true);
  const active = () => acquireActiveIndex(app, policy, actor, roomId);
  const update = (options = {}) =>
    requestIndexUpdate(app, policy, actor, roomId, { force: true, ...options });
  const append = (content: string) =>
    repo.appendMessage(actor, roomId, { content, role: "user" });
  function groups(path: string) {
    const db = new SQLiteSearchBackend(path);
    try {
      return db.db
        .prepare(
          "SELECT group_id,ref,current FROM chunks ORDER BY group_id,version",
        )
        .all();
    } finally {
      db.close();
    }
  }
  function prepareJob(rebuild: boolean): IndexJob {
    const job = {
      root,
      appPath: app.path,
      binding,
      jobId: randomUUID(),
      rebuild,
      external: false,
    };
    const reg = openRegistry(dir, true)!;
    reg
      .prepare(
        "INSERT INTO jobs(id,requester,state,created) VALUES(?,?,'QUEUED',?)",
      )
      .run(job.jobId, JSON.stringify(binding), Date.now());
    reg.close();
    return job;
  }
  return {
    app,
    actor,
    policy,
    roomId,
    repo,
    root,
    binding,
    dir,
    active,
    update,
    append,
    groups,
    prepareJob,
    async close() {
      await shutdownIndexWorkers(app);
      app.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("C-01/C-03 actual process loss before/after archive page, validation and pointer commit", async () => {
  const f = fixture();
  try {
    const original = f.append("保存した原文"),
      initial = await f.update({ rebuild: true });
    for (const stage of [
      "PAGE_READ",
      "PAGE_COMMITTED",
      "VALIDATING",
      "READY",
      "ACTIVE",
    ]) {
      const message = f.append(stage);
      const rebuilding = !stage.startsWith("PAGE_");
      const child = spawnSync(
        process.execPath,
        [
          "--experimental-transform-types",
          "--loader",
          "./test/ts-loader.mjs",
          fileURLToPath(
            new URL("./search-index-crash-child.ts", import.meta.url),
          ),
          JSON.stringify(f.prepareJob(rebuilding)),
          stage,
        ],
        { encoding: "utf8", timeout: 30_000 },
      );
      assert.equal(child.status, 87, child.stderr);
      const pinned = f.active();
      assert.equal(pinned.state, "ACTIVE");
      if (pinned.state !== "ACTIVE") throw Error();
      if (stage !== "ACTIVE") assert.equal(pinned.generationId, initial);
      const applied = f
        .groups(pinned.path)
        .filter((row) => row.group_id === message.id).length;
      assert.equal(
        applied,
        stage === "ACTIVE" || stage === "PAGE_COMMITTED" ? 1 : 0,
      );
      await f.update();
      const refreshed = f.active();
      assert(refreshed.state === "ACTIVE");
      assert.equal(
        f.groups(refreshed.path).filter((row) => row.group_id === message.id)
          .length,
        1,
      );
      assert.equal(
        f.repo.getMessage(f.actor, f.roomId, original.id).id,
        original.id,
      );
    }
  } finally {
    await f.close();
  }
});

test("C-02/C-04/C-05 baseline handoff catches racing correction/deletion, rollback refreshes, source-only rebuild preserves citation", async () => {
  const f = fixture();
  try {
    const corrected = f.append("訂正前"),
      removed = f.append("廃止した"),
      retained = f.append("記録");
    let pages = 0;
    const first = await updateGeneration(
      f.app,
      f.prepareJob(true),
      new AbortController().signal,
      (stage) => {
        if (stage === "PAGE_READ" && ++pages === 2) {
          f.repo.correctMessage(f.actor, f.roomId, corrected.id, {
            expectedRevision: 1,
            content: "訂正後",
          });
          f.repo.deleteMessage(f.actor, f.roomId, removed.id, {
            expectedRevision: 1,
          });
        }
      },
    );
    const initial = f.active();
    assert(initial.state === "ACTIVE");
    const before = f.groups(initial.path);
    assert.equal(
      before.some((row) => row.group_id === removed.id),
      false,
    );
    assert.deepEqual(
      before
        .filter((row) => row.group_id === corrected.id)
        .map((row) => row.current),
      [0, 1],
    );
    const ref = before.find((row) => row.group_id === retained.id)!.ref;
    assert.notEqual(await f.update({ rebuild: true }), first);
    f.repo.deleteMessage(f.actor, f.roomId, corrected.id, {
      expectedRevision: 2,
    });
    assert.equal(await f.update({ rollback: first }), first);
    assert.deepEqual(
      f.groups(initial.path).map((row) => row.group_id),
      [retained.id],
    );
    const info = manageIndex(f.app, f.binding, "status");
    assert.equal(
      info.generations?.filter((g) => g.state === "ACTIVE").length,
      1,
    );
    manageIndex(f.app, f.binding, "delete");
    assert.equal(f.active().state, "UNBUILT");
    await f.update();
    const rebuilt = f.active();
    assert(rebuilt.state === "ACTIVE");
    assert.equal(f.groups(rebuilt.path)[0].ref, ref);
  } finally {
    await f.close();
  }
});

test("C-04/C-08/P-02 fencing on ACL epoch, stopping the worker, missing generation and interrupted build", async () => {
  const f = fixture();
  try {
    f.append("公開");
    const initial = await f.update({ rebuild: true });
    const old = f.active();
    assert(old.state === "ACTIVE");
    assert.equal(statSync(old.path).mode & 0o077, 0);
    f.policy.grant("a", "w", "READ_ROOM", { roomId: f.roomId });
    assert.equal(f.active().state, "RESYNC_REQUIRED");
    assert.notEqual(await f.update(), initial);
    await assert.rejects(f.update({ rollback: initial }));
    const active = f.active();
    assert(active.state === "ACTIVE");
    const ok = f.active();
    assert(ok.state === "ACTIVE");
    unlinkSync(ok.path);
    assert.equal(f.active().state, "UNBUILT");
    const abort = new AbortController();
    const build = f.update({ rebuild: true, signal: abort.signal });
    abort.abort();
    await assert.rejects(build);
    assert(indexWorkerStatus().cancelled > 0);
    assert.equal(indexWorkerStatus().running, 0);
    await f.update({ rebuild: true });
    manageIndex(f.app, f.binding, "stop");
    assert.equal(f.active().state, "STOPPED");
    await assert.rejects(f.update());
    manageIndex(f.app, f.binding, "resume");
    assert.equal(f.active().state, "ACTIVE");
    f.app.db.exec("UPDATE app_operational_state SET maintenance=1");
    await assert.rejects(f.update());
    f.app.db.exec("UPDATE app_operational_state SET maintenance=0");
    const fresh = f.active();
    assert(fresh.state === "ACTIVE");
    const protectedFile = join(f.root, "protected");
    writeFileSync(protectedFile, "keep", { mode: 0o600 });
    unlinkSync(fresh.path);
    symlinkSync(protectedFile, fresh.path);
    assert.equal(f.active().state, "FAILED");
    assert.throws(() => manageIndex(f.app, f.binding, "delete"));
    assert.equal(readFileSync(protectedFile, "utf8"), "keep");
  } finally {
    await f.close();
  }
});

test("C-08 SQLite busy builds expose the previous generation with a failure reason, FULL rolls back the page", async () => {
  const f = fixture();
  try {
    f.append("基準文書");
    await f.update();
    const active = f.active();
    assert(active.state === "ACTIVE");
    const backend = new SQLiteSearchBackend(active.path);
    try {
      const original = backend.getCursor("archive")!;
      const text = Array.from({ length: 3500 }, (_, i) =>
        String.fromCodePoint(0x3400 + i),
      ).join("");
      const next = f.append(text);
      backend.db.exec("BEGIN IMMEDIATE");
      try {
        await assert.rejects(f.update());
        const failed = f.active();
        assert(failed.state === "ACTIVE");
        assert(failed.reason);
      } finally {
        backend.db.exec("ROLLBACK");
      }
      assert.equal(backend.getCursor("archive"), original);
      const sources = new SearchSources(f.app, f.policy, f.actor, f.roomId);
      const page = sources.archivePage(original);
      const pages = Number(
        backend.db.prepare("PRAGMA page_count").get()!.page_count,
      );
      backend.db.exec(`PRAGMA max_page_count=${pages}`);
      assert.throws(
        () =>
          backend.applyPage({
            upserts: page.upserts,
            deletes: page.deletes.map((id) => ({ target: "archive", id })),
            cursor: { stream: "archive", value: page.cursor },
            expectedCursor: original,
          }),
        /database or disk is full/,
      );
      assert.equal(backend.getCursor("archive"), original);
      assert.equal(backend.coverage().archive, 1);
      assert.equal(f.repo.getMessage(f.actor, f.roomId, next.id).content, text);
    } finally {
      backend.close();
    }
    await f.update();
    const latest = f.active();
    assert(latest.state === "ACTIVE");
    assert.equal(
      new Set(f.groups(latest.path).map((row) => row.group_id)).size,
      2,
    );
  } finally {
    await f.close();
  }
});

test("Host CLI persists index/profile controls and honors the exclusive host lock", async () => {
  const f = fixture();
  try {
    const persona = f.repo.createPersona(f.actor, f.roomId, {
      name: "owner",
      model: "synthetic",
    });
    f.append("運用");
    const flags = [
      "--root",
      f.root,
      "--actor",
      f.actor.actorId,
      "--room",
      f.roomId,
      "--workspace",
      f.actor.workspaceId,
    ];
    const run = (command: string, ...extra: string[]) =>
      runCli([command, ...flags, ...extra]) as Promise<any>;
    const release = acquireHostLock(f.root);
    try {
      await assert.rejects(run("search-rebuild"), /HOST_IN_USE_OR_STALE_LOCK/);
    } finally {
      release();
    }
    assert.equal((await run("search-status")).state, "UNBUILT");
    const path = join(f.root, "test-profile.json");
    writeFileSync(
      path,
      JSON.stringify({
        personaId: persona.id,
        scopes: ["room_shared"],
        purposes: ["QUERY_EMBEDDING"],
        maxCalls: 1,
        maxCostMicros: 10000,
        maxTokens: 8192,
        priceMicrosPerThousandTokens: 200,
      }),
      { mode: 0o600 },
    );
    assert.equal(
      (await run("search-profile-set", "--config", path)).version,
      1,
    );
    assert.equal((await run("search-sync")).state, "ACTIVE");
    const info = await run("search-status");
    assert.equal(info.generations[0].manifest.epoch.length, 64);
    assert.equal(info.generations[0].manifest.profileVersion, 1);
    assert.deepEqual(info.budget, { calls: 0, costMicros: 0, tokens: 0 });
    assert.equal((await run("search-profile-stop")).paused, true);
    assert.equal((await run("search-stop")).paused, true);
    assert.equal((await run("search-resume")).paused, false);
    assert.equal((await run("search-delete")).deleted, true);
    assert.equal((await run("search-status")).state, "UNBUILT");
    assert.equal(
      f.app.db.prepare("SELECT COUNT(*) AS n FROM search_profiles").get()!.n,
      1,
    );
  } finally {
    await f.close();
  }
});

test("F-02 policy rotation fences activation and rollback while a compatible ordinary refresh preserves the active generation", async () => {
  const f = fixture();
  try {
    const persona = f.repo.createPersona(f.actor, f.roomId, {
      name: "owner",
      model: "synthetic",
    });
    const cfg = {
      personaId: persona.id,
      scopes: ["room_shared"],
      purposes: ["QUERY_EMBEDDING"],
      maxCalls: 1,
      maxCostMicros: 10000,
      maxTokens: 8192,
      priceMicrosPerThousandTokens: 200,
    };
    configureSearchProfile(f.app, f.actor, f.roomId, cfg);
    const first = await f.update();
    const before = f.active();
    assert(before.state === "ACTIVE");
    await assert.rejects(
      updateGeneration(
        f.app,
        f.prepareJob(true),
        new AbortController().signal,
        (stage) => {
          if (stage === "READY")
            configureSearchProfile(f.app, f.actor, f.roomId, {
              ...cfg,
              maxCalls: 2,
            });
        },
      ),
      /SEARCH_PROFILE_CHANGED/,
    );
    const preserved = f.active();
    assert(preserved.state === "ACTIVE");
    assert.equal(preserved.generationId, first);
    assert.equal(preserved.manifest.profileVersion, 1);
    assert.equal(preserved.reason, "SEARCH_PROFILE_CHANGED");
    const otherRoom = f.repo.createRoom(f.actor, { title: "Other" });
    await requestIndexUpdate(f.app, f.policy, f.actor, otherRoom.id);
    const other = acquireActiveIndex(f.app, f.policy, f.actor, otherRoom.id);
    assert(other.state === "ACTIVE");
    // A failed job from the old policy must not force a fresh generation on ordinary retry.
    const refreshing = f.update();
    assert(!isIndexUpdatePending(other));
    assert(isIndexUpdatePending(preserved));
    assert.equal(await refreshing, first);
    assert(!isIndexUpdatePending(preserved));
    const refreshed = f.active();
    assert(refreshed.state === "ACTIVE");
    assert.equal(refreshed.manifest.profileVersion, 2);
    assert.equal(
      refreshed.manifest.indexConfigDigest,
      before.manifest.indexConfigDigest,
    );
    assert.notEqual(
      refreshed.manifest.configDigest,
      before.manifest.configDigest,
    );
    const second = await f.update({ rebuild: true });
    configureSearchProfile(f.app, f.actor, f.roomId, { ...cfg, maxCalls: 3 });
    await assert.rejects(
      f.update({ rollback: first }),
      /SEARCH_ROLLBACK_INCOMPATIBLE/,
    );
    assert.equal(await f.update(), second);
    configureSearchProfile(f.app, f.actor, f.roomId, {
      ...cfg,
      scopes: ["persona_private"],
    });
    assert.notEqual(await f.update(), second);
  } finally {
    await f.close();
  }
});

test("F-02 legacy manifest checksums are verified before upgrading their index compatibility metadata", async () => {
  const f = fixture();
  try {
    const first = await f.update();
    const old = f.active();
    assert(old.state === "ACTIVE");
    const reg = openRegistry(f.dir, true)!;
    try {
      const put = reg.prepare("UPDATE generations SET manifest=? WHERE id=?");
      const { indexConfigDigest, ...legacy } = old.manifest;
      put.run(JSON.stringify(legacy), first);
      assert.equal(await f.update(), first);
      // A legacy manifest whose persisted representation differs from its checksum fails closed.
      put.run(JSON.stringify({ ...legacy, chunkLength: 64 }), first);
      const replacement = await f.update();
      assert.notEqual(replacement, first);
      const current = f.active();
      assert(current.state === "ACTIVE");
      put.run(
        JSON.stringify({ ...current.manifest, generationId: first }),
        replacement,
      );
      assert.notEqual(await f.update(), replacement);
    } finally {
      reg.close();
    }
  } finally {
    await f.close();
  }
});
