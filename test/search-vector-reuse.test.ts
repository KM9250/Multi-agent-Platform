import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { digest } from "../server/app-data/validation.ts";
import { registerHandwrittenNote } from "../server/memory/importer.ts";
import { registerVault, setVaultPaused } from "../server/memory/vault.ts";
import { SQLiteSearchBackend } from "../server/search/backend.ts";
import {
  acquireActiveIndex,
  requestIndexUpdate,
} from "../server/search/index.ts";
import { openRegistry } from "../server/search/index-registry.ts";
import {
  budgetStatus,
  configureSearchProfile,
} from "../server/search/profile.ts";
import { httpFixture } from "./http-fixture.ts";

test("F-02 old document receipts survive CLI restart and automatic sync while HTTP charges only the current query budget", async (t) => {
  const f = await httpFixture(t);
  const { app, actor, policy } = f;
  const room = f.repository.createRoom(actor, { title: "Query-only fixture" });
  const persona = f.repository.createPersona(actor, room.id, {
    name: "Owner",
    model: "synthetic",
  });
  policy.grant(actor.actorId, actor.workspaceId, "MANAGE_VAULT");
  const temp = mkdtempSync(join(tmpdir(), "map-vector-reuse-"));
  const vault = mkdtempSync(join(tmpdir(), "map-vector-vault-"));
  t.after(() => {
    rmSync(temp, { recursive: true, force: true });
    rmSync(vault, { recursive: true, force: true });
  });
  registerVault(app, vault, { trustNew: true });
  setVaultPaused(app, false);
  const sharedId = "published-shared",
    sharedBody = "月曜の定例会";
  for (const [noteId, body, visibility] of [
    [sharedId, sharedBody, "room_shared"],
    ["outside-document-plan", "個人の作業記録", "persona_private"],
  ] as const) {
    for (const op of [
      "READ_MEMORY",
      "REVIEW_MEMORY",
      "PUBLISH_MEMORY",
      "CHANGE_MEMORY_SCOPE",
    ])
      policy.grant(actor.actorId, actor.workspaceId, op, {
        roomId: room.id,
        personaId: persona.id,
        visibility,
      });
    const relativePath = noteId + ".md";
    const markdown = `---\nmap_id: ${noteId}\n---\n${body}`;
    writeFileSync(join(vault, relativePath), markdown);
    await registerHandwrittenNote(app, policy, actor, {
      roomId: room.id,
      personaId: persona.id,
      scope: visibility,
      noteId,
      relativePath,
      expectedDigest: digest(markdown),
      requestId: randomUUID(),
      trusted: true,
    });
  }
  const config = {
    personaId: persona.id,
    scopes: ["room_shared"],
    purposes: ["DOCUMENT_EMBEDDING", "QUERY_EMBEDDING"],
    maxCalls: 2,
    maxTokens: 32768,
    maxCostMicros: 20000,
    priceMicrosPerThousandTokens: 1000,
  };
  const configure = (changes: Partial<typeof config>) =>
    configureSearchProfile(app, actor, room.id, { ...config, ...changes });
  const budget = (version: number) =>
    budgetStatus(app, actor, room.id, version);
  const callsFile = join(temp, "mock-requests.jsonl");
  function syncCli() {
    const cli = spawnSync(
      process.execPath,
      [
        "--experimental-transform-types",
        "--loader",
        "./test/ts-loader.mjs",
        "--import",
        fileURLToPath(
          new URL("./search-cli-recovery-fetch.mjs", import.meta.url),
        ),
        "server/cli.ts",
        "search-sync",
        "--root",
        app.root,
        "--workspace",
        actor.workspaceId,
        "--actor",
        actor.actorId,
        "--room",
        room.id,
      ],
      {
        encoding: "utf8",
        timeout: 30000,
        cwd: fileURLToPath(new URL("../", import.meta.url)),
        env: {
          NODE_NO_WARNINGS: "1",
          GEMINI_API_KEY: "synthetic-only",
          MAP_TEST_SEARCH_APP_PATH: app.path,
          MAP_TEST_SEARCH_CALLS: callsFile,
        },
      },
    );
    assert.equal(cli.status, 0, cli.stderr || String(cli.error));
    assert.equal(JSON.parse(cli.stdout).state, "ACTIVE");
  }
  function active() {
    const a = acquireActiveIndex(app, policy, actor, room.id);
    assert.equal(a.state, "ACTIVE");
    return a;
  }
  function vectors() {
    const backend = new SQLiteSearchBackend(active().path, { readOnly: true });
    try {
      return backend.db
        .prepare(
          `SELECT v.chunk_id,v.operation_id,v.space_id,v.vector,c.ref,c.start,c.end FROM search_vectors v
        JOIN chunks c ON c.id=v.chunk_id ORDER BY v.chunk_id`,
        )
        .all();
    } finally {
      backend.close();
    }
  }

  const initial = configure({});
  syncCli();
  const prior = vectors();
  assert.equal(prior.length, 1);
  assert.equal(JSON.parse(String(prior[0].ref)).noteId, sharedId);
  const docReceipt = () =>
    app.db
      .prepare(
        "SELECT * FROM search_operations WHERE purpose='DOCUMENT_EMBEDDING' ORDER BY rowid",
      )
      .all();
  const before = docReceipt();
  assert.equal(before.length, 1);
  assert.equal(before[0].operation_id, prior[0].operation_id);
  assert.deepEqual(budget(initial.version), {
    calls: 1,
    tokens: 3,
    costMicros: 3,
  });

  // A pre-fix active catalogue has the full configuration checksum but no
  // separate structural digest. A deployed index must retain the original vector on upgrade.
  const reg = openRegistry(dirname(active().path), true)!;
  t.after(() => reg.close());
  const legacy = { ...active().manifest };
  delete legacy.indexConfigDigest;
  reg
    .prepare("UPDATE generations SET manifest=? WHERE state='ACTIVE'")
    .run(JSON.stringify(legacy));

  const queryOnly = {
    purposes: ["QUERY_EMBEDDING"],
    maxCalls: 1,
    priceMicrosPerThousandTokens: 500,
  };
  const second = configure(queryOnly);
  syncCli(); // new host process, external document permission removed
  assert.deepEqual(vectors(), prior);
  assert.equal(active().manifest.dense.state, "ready");
  assert.deepEqual(budget(second.version), {
    calls: 0,
    tokens: 0,
    costMicros: 0,
  });

  await f.login();
  const realFetch = globalThis.fetch;
  const oldKey = process.env.GEMINI_API_KEY;
  const queries: string[] = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith(f.origin + "/")) return realFetch(url, init);
    assert.equal(
      String(url),
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent",
    );
    const text = JSON.parse(String(init.body)).content.parts[0].text;
    assert.match(text, /^task: search result \| query:/);
    queries.push(text);
    return Response.json({
      embedding: {
        values: Array.from({ length: 768 }, (_, i) => Number(i === 0)),
      },
      usageMetadata: { promptTokenCount: 6 },
    });
  };
  process.env.GEMINI_API_KEY = "synthetic-only";
  t.after(() => {
    globalThis.fetch = realFetch;
    if (oldKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = oldKey;
  });
  const search = async () => {
    const result = await f.request("/rooms/" + room.id + "/search", "POST", {
      query: "synonym",
      requestId: randomUUID(),
      target: "memory",
      retrievalMode: "hybrid",
    });
    assert.equal(result.response.status, 200, JSON.stringify(result.data));
    return result.data;
  };
  const hybrid = async () => {
    const result = await search();
    assert.deepEqual(
      result.methods,
      ["lexical", "dense"],
      JSON.stringify(result),
    );
    assert.equal(result.external.calls, 1);
    assert.deepEqual(
      result.results.map((h) => [h.citation.noteId, h.snippet]),
      [[sharedId, sharedBody]],
    );
  };
  await hybrid();
  assert.deepEqual(budget(second.version), {
    calls: 1,
    tokens: 6,
    costMicros: 3,
  });
  const blocked = await search();
  assert.deepEqual(blocked.methods, ["lexical"]);
  assert.ok(blocked.reasons.includes("budget_exhausted"));
  assert.equal(blocked.external.calls, 0);

  const third = configure({ ...queryOnly, maxCalls: 3 });
  // Make the next search request trigger the real background sync irrespective of wall clock.
  reg.exec("UPDATE generations SET synced=0 WHERE state='ACTIVE'");
  const lastJob = () =>
    reg.prepare("SELECT id FROM jobs ORDER BY rowid DESC LIMIT 1").get()?.id;
  const beforeAutomaticSync = lastJob();
  const refreshed = await f.request("/rooms/" + room.id + "/search", "POST", {
    query: "synonym",
    requestId: randomUUID(),
    target: "memory",
    retrievalMode: "lexical",
  });
  assert.equal(refreshed.response.status, 200);
  assert.notEqual(
    lastJob(),
    beforeAutomaticSync,
    "HTTP search scheduled a background sync",
  );
  await requestIndexUpdate(app, policy, actor, room.id);
  assert.equal(active().manifest.profileVersion, third.version);
  assert.equal(active().manifest.dense.state, "ready");
  assert.deepEqual(vectors(), prior);
  await hybrid();
  assert.deepEqual(budget(third.version), {
    calls: 1,
    tokens: 6,
    costMicros: 3,
  });

  // Simulate a Vault edit before the watcher can update the derived index. Length alone cannot attest to the old text.
  const sharedPath = join(vault, sharedId + ".md");
  const previousText = readFileSync(sharedPath, "utf8");
  writeFileSync(sharedPath, previousText.replace(sharedBody, "火曜の定例会"));
  const edited = await search();
  assert.deepEqual(edited.methods, ["lexical"]);
  assert.deepEqual(edited.results, []);
  assert.equal(edited.external.calls, 0);
  assert.equal(budget(third.version).calls, 1);

  // The private note is readable but never had an authorized document operation.
  const broad = configure({
    ...queryOnly,
    scopes: ["room_shared", "persona_private"],
  });
  syncCli();
  const incomplete = await search();
  assert.deepEqual(incomplete.methods, ["lexical"]);
  assert.equal(incomplete.external.calls, 0);
  assert.ok(
    incomplete.reasons.includes("incomplete_dense_coverage"),
    JSON.stringify(incomplete),
  );
  assert.deepEqual(budget(broad.version), {
    calls: 0,
    tokens: 0,
    costMicros: 0,
  });
  assert.deepEqual(budget(initial.version), {
    calls: 1,
    tokens: 3,
    costMicros: 3,
  });
  assert.deepEqual(docReceipt(), before);
  assert.equal(queries.length, 2);
  assert.equal(readFileSync(callsFile, "utf8").trim().split("\n").length, 1);
});
