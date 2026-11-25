import { APP_SCHEMA } from "../shared/app-contracts/index.ts";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  configureSearchProfile,
  dispatchEmbedding,
  operationId,
  OP_TOKEN_RESERVATION,
} from "../server/search/profile.ts";
import { documentOperationKey } from "../server/search/dense-corpus.ts";
import {
  generationPath,
  indexDirectory,
} from "../server/search/index-registry.ts";
import { lineageFixture } from "./memory-lineage-fixture.ts";

test("F-01 CLI recovers abandoned document dispatch before a new generation and preserves unknown costs in backup", async (t) => {
  const f = lineageFixture();
  t.after(() => f.close());
  f.original();
  const memory = await f.memory();
  f.publish(memory.candidate.id);
  const price = 100;
  const reservation = Math.ceil((OP_TOKEN_RESERVATION * price) / 1000);
  const profile = configureSearchProfile(f.app, f.actor, f.room.id, {
    personaId: f.persona.id,
    scopes: ["persona_private"],
    purposes: ["DOCUMENT_EMBEDDING"],
    maxCalls: 2,
    maxTokens: 2 * OP_TOKEN_RESERVATION,
    maxCostMicros: 2 * reservation,
    priceMicrosPerThousandTokens: price,
  });
  const temp = mkdtempSync(join(tmpdir(), "map-cli-recovery-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const callsFile = join(temp, "calls.jsonl");
  const backup = join(temp, "backup");
  const scope = [
    "--root",
    f.root,
    "--workspace",
    f.actor.workspaceId,
    "--actor",
    f.actor.actorId,
    "--room",
    f.room.id,
  ];
  const program = [
    "--experimental-transform-types",
    "--loader",
    "./test/ts-loader.mjs",
    "--import",
    fileURLToPath(new URL("./search-cli-recovery-fetch.mjs", import.meta.url)),
    "server/cli.ts",
  ];
  const env = {
    NODE_NO_WARNINGS: "1",
    GEMINI_API_KEY: "synthetic-only",
    MAP_TEST_SEARCH_APP_PATH: f.app.path,
    MAP_TEST_SEARCH_CALLS: callsFile,
  };
  const options = {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    encoding: "utf8" as const,
    timeout: 30_000,
    env,
  };
  const cli = (...args: string[]) =>
    spawnSync(process.execPath, [...program, ...args], options);
  const success = (...args: string[]) => {
    const result = cli(...args);
    assert.equal(result.status, 0, result.stderr || String(result.error));
    return JSON.parse(result.stdout);
  };
  type Attempt = { operation_id: string; state: string };
  const calls = (): Attempt[][] =>
    readFileSync(callsFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  const ledger = (db: DatabaseSync) =>
    db
      .prepare(
        `SELECT operation_id,profile_version,purpose,state,source_ref,payload_digest,
    reserved_tokens,reserved_cost_micros,estimated_cost_micros,usage_json,dispatched_at FROM search_operations ORDER BY rowid`,
      )
      .all();
  const child = spawn(process.execPath, [...program, "search-sync", ...scope], {
    cwd: options.cwd,
    env: { ...env, MAP_TEST_SEARCH_HOLD: "1" },
    stdio: "ignore",
  });
  const exit = once(child, "exit");
  try {
    const deadline = AbortSignal.timeout(20_000);
    while (!existsSync(callsFile)) {
      assert.equal(
        child.exitCode,
        null,
        "CLI exited before mocked document dispatch",
      );
      await delay(25, undefined, { signal: deadline });
    }
    const [inflight] = ledger(f.app.db);
    assert.equal(inflight.state, "DISPATCH_INTENT");
    assert.equal(inflight.purpose, "DOCUMENT_EMBEDDING");
    assert.deepEqual(calls(), [
      [{ operation_id: inflight.operation_id, state: "DISPATCH_INTENT" }],
    ]);
    for (const args of [
      ["search-sync", ...scope],
      ["backup", "--root", f.root, "--destination", backup],
    ]) {
      const busy = cli(...args);
      assert.equal(busy.status, 1);
      assert.equal(
        JSON.parse(busy.stderr).error.code,
        "HOST_IN_USE_OR_STALE_LOCK",
      );
    }
    assert.deepEqual(ledger(f.app.db), [inflight]);
    assert.ok(child.kill("SIGKILL"));
    assert.deepEqual(await exit, [null, "SIGKILL"]);
    const lock = join(f.root, ".server.lock");
    assert.equal(JSON.parse(readFileSync(lock, "utf8")).pid, child.pid);
    assert.throws(() => process.kill(child.pid!, 0), { code: "ESRCH" });
    // Follow the host runbook for this test's own confirmed-dead process.
    unlinkSync(lock);

    const retried = success("search-sync", ...scope);
    assert.equal(retried.state, "ACTIVE");
    const after = ledger(f.app.db);
    assert.deepEqual(
      after.map((row) => row.state),
      ["OUTCOME_UNKNOWN", "SUCCEEDED"],
    );
    const [unknown, recorded] = after;
    assert.deepEqual({ ...unknown }, { ...inflight, state: "OUTCOME_UNKNOWN" });
    assert.notEqual(unknown.operation_id, recorded.operation_id);
    assert.deepEqual(calls()[1], [
      { operation_id: unknown.operation_id, state: "OUTCOME_UNKNOWN" },
      { operation_id: recorded.operation_id, state: "DISPATCH_INTENT" },
    ]);
    assert.equal(JSON.parse(String(recorded.usage_json)).quantity, 3);
    const backupManifest = success(
      "backup",
      "--root",
      f.root,
      "--destination",
      backup,
    );
    assert.equal(backupManifest.appSchema, APP_SCHEMA);
    const backupDb = new DatabaseSync(join(backup, "app-data.sqlite"), {
      readOnly: true,
    });
    try {
      assert.deepEqual(ledger(backupDb), after);
    } finally {
      backupDb.close();
    }
    const status = success("search-status", ...scope);
    assert.deepEqual(status.budget, {
      calls: 2,
      tokens: OP_TOKEN_RESERVATION + 3,
      costMicros: reservation + Number(recorded.estimated_cost_micros),
    });
    const old = status.generations.find(
      (g: { id: string }) => g.id !== retried.generationId,
    );
    assert.ok(old);
    const dir = indexDirectory(f.root, { ...f.actor, roomId: f.room.id });
    const oldPath = generationPath(dir, old.id);
    const oldIndex = new DatabaseSync(oldPath, { readOnly: true });
    try {
      const chunk = oldIndex
        .prepare(
          "SELECT id,text FROM chunks WHERE target='memory' AND source_id=?",
        )
        .get(memory.noteId)!;
      const purpose = "DOCUMENT_EMBEDDING";
      const operationKey = documentOperationKey(
        oldPath,
        profile.version,
        String(chunk.id),
      );
      assert.equal(
        operationId(f.actor, f.room.id, purpose, operationKey),
        unknown.operation_id,
      );
      await assert.rejects(
        dispatchEmbedding(
          f.app,
          f.policy,
          {
            spaceId: profile.spaceId,
            async embed() {
              throw Error("replayed the recovered dispatch");
            },
          },
          {
            actor: f.actor,
            roomId: f.room.id,
            profile,
            scopes: profile.scopes,
            purpose,
            operationKey,
            sourceRef: String(unknown.source_ref),
            readText: () => String(chunk.text),
            signal: new AbortController().signal,
          },
        ),
        /operation_already_recorded/,
      );
    } finally {
      oldIndex.close();
    }
    // A repeat on the same generation reuses its vector. A fresh generation needs room in the budget.
    assert.equal(
      success("search-sync", ...scope).generationId,
      retried.generationId,
    );
    const rebuilt = success("search-rebuild", ...scope);
    const report = success("search-status", ...scope);
    const current = report.generations.find(
      (g: { id: string }) => g.id === rebuilt.generationId,
    );
    assert.equal(current.manifest.dense.state, "budget_exhausted");
    assert.equal(calls().length, 2);
    assert.deepEqual(ledger(f.app.db), after);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exit;
    }
  }
});
