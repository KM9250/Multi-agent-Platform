import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { lineageFixture } from "./memory-lineage-fixture.ts";
import { appFixture } from "./app-data-fixture.ts";
import { SQLiteSearchBackend } from "../server/search/backend.ts";
import {
  buildDenseIndex,
  fuseRanks,
  searchDense,
} from "../server/search/dense.ts";
import {
  DisabledReranker,
  GoogleEmbeddingProvider,
  spaceId,
  unitVector,
  validateRanking,
  type EmbeddingProvider,
} from "../server/search/embedding.ts";
import {
  budgetStatus,
  configureSearchProfile,
  dispatchEmbedding,
  getSearchProfile,
  recoverSearchDispatches,
  stopSearchProfile,
} from "../server/search/profile.ts";
import { SearchSources } from "../server/search/sources.ts";

const values = Array.from({ length: 768 }, (_, i) => (i === 0 ? 3 : 0));
const config = (personaId: string) => ({
  personaId,
  scopes: ["persona_private"],
  purposes: ["DOCUMENT_EMBEDDING", "QUERY_EMBEDDING"],
  maxCalls: 100,
  maxTokens: 32_768,
  maxCostMicros: 10_000,
  priceMicrosPerThousandTokens: 100,
});
const signal = new AbortController().signal;

test("Google REST encodes independent document/query requests with 768 dimensions and reports missing usage", async () => {
  const requests: RequestInit[] = [];
  const http: typeof fetch = async (url, init) => {
    assert.equal(
      String(url),
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent",
    );
    requests.push(init!);
    return Response.json({
      embedding: { values },
      ...(requests.length === 1
        ? { usageMetadata: { promptTokenCount: 4 } }
        : {}),
    });
  };
  const provider = new GoogleEmbeddingProvider("dummy-test-key", http);
  for (const [purpose, text] of [
    ["DOCUMENT_EMBEDDING", "資料A"],
    ["DOCUMENT_EMBEDDING", "資料B"],
    ["QUERY_EMBEDDING", "設計"],
  ] as const) {
    const result = await provider.embed({ purpose, text, signal });
    assert.equal(result.vector[0], 1);
    assert.equal(
      result.usage.completeness,
      requests.length === 1 ? "COMPLETE" : "UNKNOWN",
    );
  }
  assert.deepEqual(
    requests.map((r) => JSON.parse(String(r.body))),
    [
      "title: none | text: 資料A",
      "title: none | text: 資料B",
      "task: search result | query: 設計",
    ].map((text) => ({
      content: { parts: [{ text }] },
      outputDimensionality: 768,
    })),
  );
  for (const request of requests) assert.equal(request.redirect, "error");
  for (const bad of [
    [1],
    values.map(() => 0),
    values.map(() => NaN),
    values.map(() => Infinity),
  ])
    assert.throws(() => unitVector(bad), /invalid_vector/);
  const bad = new GoogleEmbeddingProvider("dummy", async () =>
    Response.json({ embeddings: [{ values }, { values }] }),
  );
  await assert.rejects(
    bad.embed({ purpose: "DOCUMENT_EMBEDDING", text: "資料", signal }),
    /invalid_vector_count/,
  );
});

test("RRF and disabled reranking validate bounded, stable ranks", async () => {
  assert.deepEqual(
    fuseRanks(
      [
        ["b", "a", "a", "c"],
        ["c", "a"],
      ],
      (x) => x,
    ),
    ["c", "a", "b"],
  );
  const reranker = new DisabledReranker();
  assert.deepEqual(
    await reranker.rank(
      "x",
      [
        { id: "a", text: "抜粋A" },
        { id: "b", text: "抜粋B" },
      ],
      signal,
    ),
    {
      ids: ["a", "b"],
      used: false,
    },
  );
  for (const output of [["other", "b"], ["a"], ["a", "a"]])
    assert.throws(() => validateRanking(["a", "b"], output, 2));
  await assert.rejects(
    reranker.rank("x", Array(101).fill({ id: "a", text: "抜粋" }), signal),
  );
});

test("C-06 process exit before send/after intent/inside provider leaves durable charges and prevents replay", async (t) => {
  const f = appFixture();
  t.after(() => f.dispose());
  const { app, policy, actor, room, persona } = f;
  policy.grant(actor.actorId, actor.workspaceId, "READ_MEMORY", {
    roomId: room.id,
    personaId: persona.id,
    visibility: "persona_private",
  });
  const profile = configureSearchProfile(
    app,
    actor,
    room.id,
    config(persona.id),
  );
  let calls = 0;
  const provider: EmbeddingProvider = {
    spaceId,
    async embed() {
      calls++;
      throw Error("unexpected");
    },
  };
  for (const phase of [
    "search-reserve",
    "search-intent",
    "crash-during-send",
  ]) {
    const child = spawnSync(
      process.execPath,
      [
        ...process.execArgv.filter((a) => a !== "--test"),
        fileURLToPath(
          new URL("./search-dense-crash-child.ts", import.meta.url),
        ),
        app.root,
        room.id,
        actor.workspaceId,
        actor.actorId,
        phase,
      ],
      { encoding: "utf8" },
    );
    assert.equal(
      child.status,
      phase === "crash-during-send" ? 28 : 27,
      child.stderr,
    );
    recoverSearchDispatches(app);
    await assert.rejects(
      dispatchEmbedding(app, policy, provider, {
        actor,
        roomId: room.id,
        profile,
        scopes: profile.scopes,
        purpose: "QUERY_EMBEDDING",
        operationKey: phase,
        signal,
        readText: () => "fixture",
      }),
      /operation_already_recorded/,
    );
  }
  assert.equal(calls, 0);
  assert.deepEqual(
    app.db
      .prepare("SELECT state FROM search_operations ORDER BY rowid")
      .all()
      .map((r) => r.state),
    ["REJECTED", "OUTCOME_UNKNOWN", "OUTCOME_UNKNOWN"],
  );
  const budget = budgetStatus(app, actor, room.id, profile.version);
  assert.equal(budget.tokens, 2 * 8192);
  assert.ok(budget.costMicros > 0);
});

test("published Memory flows through document dispatch, independent query receipt, worker cosine and reauthorization", async (t) => {
  const f = lineageFixture();
  t.after(() => f.close());
  f.original();
  const note = await f.memory();
  f.publish(note.candidate.binding.candidateId);
  const { app, policy, actor, room, persona } = f;
  const sources = new SearchSources(app, policy, actor, room.id);
  const path = join(f.root, "dense-test.sqlite");
  const db = new SQLiteSearchBackend(path, { create: true });
  t.after(() => db.close());
  const page = sources.memoryPage();
  assert.equal(page.upserts.length, 1);
  db.applyPage({ upserts: page.upserts, deletes: [] });
  const log: { purpose: string; text: string }[] = [];
  const provider: EmbeddingProvider = {
    spaceId,
    async embed(req) {
      log.push({ purpose: req.purpose, text: req.text });
      return {
        vector: Float32Array.from(values),
        usage: { unit: "input_token", quantity: 3, completeness: "COMPLETE" },
      };
    },
  };
  const build = () =>
    buildDenseIndex(app, policy, actor, room.id, path, signal, provider);
  const query = (id: string) =>
    searchDense(app, policy, actor, room.id, path, "語義", id, { provider });
  assert.equal((await build()).state, "profile_unconfigured");
  assert.equal((await query("first")).external.calls, 0);
  configureSearchProfile(app, actor, room.id, config(persona.id));
  assert.equal(
    (await query("before-build")).state,
    "incomplete_dense_coverage",
  );
  assert.deepEqual(log, []);
  const built = await build();
  assert.equal(built.state, "ready");
  assert.ok(built.indexed >= 1);
  await build();
  assert.equal(log.length, built.indexed);
  const result = await query("hit");
  assert.equal(result.state, "ready");
  assert.deepEqual(result.external, { calls: 1, usage: "COMPLETE" });
  assert.equal(result.candidates.length, built.indexed);
  assert.ok(
    result.candidates.every(
      (c) =>
        c.citation.target === "memory" && c.citation.noteId === note.noteId,
    ),
  );
  assert.equal((await query("hit")).external.calls, 0);
  const before = log.length;
  configureSearchProfile(app, actor, room.id, {
    ...config(persona.id),
    maxCalls: 1,
  });
  assert.equal((await query("new-budget")).state, "ready");
  assert.deepEqual(
    log.slice(before).map((call) => call.purpose),
    ["QUERY_EMBEDDING"],
  );
  assert.equal((await build()).state, "ready");
  assert.equal((await query("budget")).state, "budget_exhausted");
  assert.equal(log.length, before + 1);
  policy.revoke(actor.actorId, actor.workspaceId, "SEND_TO_PROVIDER");
  assert.equal((await query("revoked")).external.calls, 0);
  stopSearchProfile(app, actor, room.id);
  assert.equal((await query("stopped")).external.calls, 0);
  assert.equal(getSearchProfile(app, actor, room.id), null);
});

test("profile stopped during dispatch retains receipt and rejects vector adoption", async (t) => {
  const f = appFixture();
  t.after(() => f.dispose());
  const { app, policy, actor, room, persona } = f;
  policy.grant(actor.actorId, actor.workspaceId, "READ_MEMORY", {
    roomId: room.id,
    personaId: persona.id,
    visibility: "persona_private",
  });
  const profile = configureSearchProfile(
    app,
    actor,
    room.id,
    config(persona.id),
  );
  const provider: EmbeddingProvider = {
    spaceId,
    async embed() {
      stopSearchProfile(app, actor, room.id);
      return {
        vector: Float32Array.from(values),
        usage: { unit: "input_token", completeness: "UNKNOWN" },
      };
    },
  };
  await assert.rejects(
    dispatchEmbedding(app, policy, provider, {
      actor,
      roomId: room.id,
      profile,
      purpose: "QUERY_EMBEDDING",
      operationKey: "race",
      signal,
      scopes: profile.scopes,
      readText: () => "検索",
    }),
    /profile_changed_or_disabled/,
  );
  assert.deepEqual(
    {
      ...app.db
        .prepare("SELECT state,estimated_cost_micros FROM search_operations")
        .get(),
    },
    { state: "SUCCEEDED", estimated_cost_micros: null },
  );
  assert.equal(budgetStatus(app, actor, room.id, profile.version).tokens, 8192);
});

test("P-01 count and byte bounds independently skip the whole eligible corpus before query send", async (t) => {
  const f = lineageFixture();
  t.after(() => f.close());
  f.original();
  const note = await f.memory();
  f.publish(note.candidate.id);
  const { app, policy, actor, room, persona } = f;
  configureSearchProfile(app, actor, room.id, config(persona.id));
  const path = join(f.root, "limit.sqlite");
  const index = new SQLiteSearchBackend(path, { create: true });
  t.after(() => index.close());
  const sources = new SearchSources(app, policy, actor, room.id);
  index.applyPage({ upserts: sources.memoryPage().upserts, deletes: [] });
  const r = index.db.prepare("SELECT * FROM chunks LIMIT 1").get()!;
  index.db
    .prepare("INSERT INTO search_vectors VALUES(?,?,?,zeroblob(?))")
    .run(r.id, spaceId, "synthetic", 24 * 1024 * 1024 + 1);
  let calls = 0;
  const provider: EmbeddingProvider = {
    spaceId,
    async embed() {
      calls++;
      throw Error("unexpected");
    },
  };
  const query = () =>
    searchDense(app, policy, actor, room.id, path, "猫", "synthetic-limit", {
      provider,
    });
  assert.equal((await query()).state, "dense_limit");
  index.db.exec("DELETE FROM search_vectors");
  // Same authorized ref isolates the count boundary from corpus length and ranking effects.
  index.db
    .prepare(
      `WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<10000)
    INSERT INTO chunks(id,source_id,group_id,target,version,current,recorded_at,persona_id,visibility,channel,ref,start,end,metadata,text)
    SELECT 'extra-'||i,source_id,group_id,target,version,current,recorded_at,persona_id,visibility,channel,ref,start,end,metadata,text
    FROM n JOIN chunks ON chunks.pk=?`,
    )
    .run(r.pk);
  assert.equal((await query()).state, "dense_limit");
  assert.equal(calls, 0);
});

test("P-02 cancellation waits for the compute child to exit", async (t) => {
  const { runSearchProcess } =
    await import("../server/search/query-process.ts");
  const { existsSync, mkdtempSync, readFileSync, rmSync } =
    await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { setTimeout: delay } = await import("node:timers/promises");
  const directory = mkdtempSync(join(tmpdir(), "map-search-cancel-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const marker = join(directory, "ready");
  const controller = new AbortController();
  const task = runSearchProcess(
    new URL("./search-cancel-child.ts", import.meta.url),
    { marker },
    controller.signal,
  );
  t.after(() => controller.abort());
  const started = performance.now();
  while (!existsSync(marker) && performance.now() - started < 15_000)
    await delay(25);
  assert.ok(existsSync(marker), "worker began computing");
  const pid = Number(readFileSync(marker, "utf8"));
  controller.abort();
  await assert.rejects(task, { name: "AbortError" });
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("HTTP Memory search verifies hybrid hits and reports failed planned Dense calls with lexical fallback", async (t) => {
  const { httpFixture } = await import("./http-fixture.ts");
  const { registerVault, setVaultPaused } =
    await import("../server/memory/vault.ts");
  const { registerHandwrittenNote } =
    await import("../server/memory/importer.ts");
  const { acquireActiveIndex, requestIndexUpdate } =
    await import("../server/search/index.ts");
  const { digest } = await import("../server/app-data/validation.ts");
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { randomUUID } = await import("node:crypto");
  const f = await httpFixture(t);
  const { app, policy, actor } = f;
  const room = f.repository.createRoom(actor, { title: "Hybrid fixture" });
  const persona = f.repository.createPersona(actor, room.id, {
    name: "Synthetic persona",
    model: "synthetic",
  });
  const scope = {
    roomId: room.id,
    personaId: persona.id,
    visibility: "persona_private",
  };
  for (const op of ["READ_MEMORY", "REVIEW_MEMORY", "PUBLISH_MEMORY"])
    policy.grant(actor.actorId, actor.workspaceId, op, scope);
  policy.grant(actor.actorId, actor.workspaceId, "MANAGE_VAULT");
  const vault = mkdtempSync(join(tmpdir(), "map-search-hybrid-"));
  t.after(() => rmSync(vault, { recursive: true, force: true }));
  registerVault(app, vault, { trustNew: true });
  setVaultPaused(app, false);
  const noteId = "mem_search_hybrid",
    relativePath = "meeting.md";
  const body = "定例会は月曜",
    markdown = `---\nmap_id: ${noteId}\n---\n${body}`;
  writeFileSync(join(vault, relativePath), markdown);
  await registerHandwrittenNote(app, policy, actor, {
    roomId: room.id,
    personaId: persona.id,
    scope: "persona_private",
    noteId,
    relativePath,
    expectedDigest: digest(markdown),
    requestId: randomUUID(),
    trusted: true,
  });
  configureSearchProfile(app, actor, room.id, config(persona.id));
  await requestIndexUpdate(app, policy, actor, room.id, { force: true });
  const pinned = acquireActiveIndex(app, policy, actor, room.id);
  assert.equal(pinned.state, "ACTIVE");
  const requests: string[] = [];
  let providerDown = false;
  const network: typeof fetch = async (url, options) => {
    if (String(url).startsWith(f.origin + "/"))
      return originalFetch(url, options);
    assert.equal(
      String(url),
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent",
    );
    requests.push(JSON.parse(String(options.body)).content.parts[0].text);
    if (providerDown) return new Response(null, { status: 503 });
    return Response.json({
      embedding: { values },
      usageMetadata: { promptTokenCount: 5 },
    });
  };
  const originalFetch = globalThis.fetch;
  const saved = process.env.GEMINI_API_KEY;
  globalThis.fetch = network;
  process.env.GEMINI_API_KEY = "synthetic-only";
  try {
    const built = await buildDenseIndex(
      app,
      policy,
      actor,
      room.id,
      pinned.path,
    );
    assert.equal(built.state, "ready");
    await f.login();
    const result = await f.request(`/rooms/${room.id}/search`, "POST", {
      requestId: randomUUID(),
      target: "memory",
      retrievalMode: "hybrid",
      query: "ミーティングの曜日",
    });
    assert.equal(result.response.status, 200, JSON.stringify(result.data));
    assert.deepEqual(result.data.methods, ["lexical", "dense"]);
    assert.equal(result.data.external.calls, 1);
    assert.equal(result.data.results[0].citation.noteId, noteId);
    assert.equal(result.data.results[0].snippet, body);
    assert.deepEqual(requests, [
      `title: none | text: ${body}`,
      "task: search result | query: ミーティングの曜日",
    ]);

    providerDown = true;
    const post = async (retrievalMode: "lexical" | "auto") => {
      const reply = await f.request(`/rooms/${room.id}/search`, "POST", {
        requestId: randomUUID(),
        target: "memory",
        query: body,
        retrievalMode,
      });
      assert.equal(reply.response.status, 200);
      return reply.data;
    };
    const local = await post("lexical");
    assert.equal(local.status, "ready");
    assert.equal(local.external.calls, 0);
    assert.deepEqual(local.methods, ["lexical"]);
    assert.equal(requests.length, 2);

    const fallback = await post("auto");
    assert.equal(fallback.status, "degraded");
    assert.deepEqual(fallback.reasons, ["outcome_unknown"]);
    assert.equal(fallback.coverage.denseState, "outcome_unknown");
    assert.deepEqual(fallback.methods, ["lexical"]);
    assert.deepEqual(fallback.external, {
      status: "dispatched",
      calls: 1,
      usage: "UNKNOWN",
    });
    assert.equal(fallback.results[0].citation.noteId, noteId);
    assert.equal(requests.length, 3);
    const charge = app.db
      .prepare(
        "SELECT state,reserved_tokens FROM search_operations ORDER BY rowid DESC LIMIT 1",
      )
      .get()!;
    assert.equal(charge.state, "OUTCOME_UNKNOWN");
    assert.ok(Number(charge.reserved_tokens) > 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (saved === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = saved;
  }
});

test("R-05 source, ACL or profile changes at committed intent prevent transport and release a known unsent reservation", async (t) => {
  const { AppDatabase } = await import("../server/app-data/db.ts");
  const { AuthorizationPolicy } =
    await import("../server/auth/authorization.ts");
  const f = appFixture();
  t.after(() => f.dispose());
  const { actor, room, persona } = f;
  const scope = {
    roomId: room.id,
    personaId: persona.id,
    visibility: "persona_private",
  };
  f.policy.grant(actor.actorId, actor.workspaceId, "READ_MEMORY", scope);
  let phase = "",
    text = "original";
  const app = new AppDatabase({
    root: f.root,
    hooks: {
      afterCommit(name) {
        if (name !== "search-intent") return;
        if (phase === "scope")
          f.policy.revoke(actor.actorId, actor.workspaceId, "SEND_TO_PROVIDER");
        if (phase === "source") text = "changed after intent";
        if (phase === "profile") stopSearchProfile(f.app, actor, room.id);
      },
    },
  });
  t.after(() => app.close());
  const policy = new AuthorizationPolicy(app);
  let calls = 0;
  const provider: EmbeddingProvider = {
    spaceId,
    async embed() {
      calls++;
      throw Error("must not dispatch");
    },
  };
  for (phase of ["source", "profile", "scope"]) {
    const profile = configureSearchProfile(
      f.app,
      actor,
      room.id,
      config(persona.id),
    );
    text = "original";
    await assert.rejects(
      dispatchEmbedding(app, policy, provider, {
        actor,
        roomId: room.id,
        profile,
        purpose: "DOCUMENT_EMBEDDING",
        operationKey: phase,
        signal,
        scopes: profile.scopes,
        readText: () => text,
      }),
    );
    assert.equal(calls, 0);
    assert.deepEqual(budgetStatus(app, actor, room.id, profile.version), {
      calls: 0,
      tokens: 0,
      costMicros: 0,
    });
    assert.deepEqual(
      {
        ...app.db
          .prepare(
            "SELECT state,dispatched_at,estimated_cost_micros FROM search_operations WHERE profile_version=?",
          )
          .get(profile.version),
      },
      { state: "REJECTED", dispatched_at: null, estimated_cost_micros: 0 },
    );
  }
});

test("F-02 reuses only generation-bound successes for the same authorized chunk and space", async (t) => {
  const { hash } = await import("../server/search/embedding.ts");
  const f = lineageFixture();
  t.after(() => f.close());
  f.original();
  const note = await f.memory();
  f.publish(note.candidate.id);
  const { app, policy, actor, room, persona } = f;
  const path = join(f.root, "verified.sqlite"),
    index = new SQLiteSearchBackend(path, { create: true });
  t.after(() => index.close());
  index.applyPage({
    deletes: [],
    upserts: new SearchSources(app, policy, actor, room.id).memoryPage()
      .upserts,
  });
  const initial = configureSearchProfile(
    app,
    actor,
    room.id,
    config(persona.id),
  );
  let calls = 0;
  const provider: EmbeddingProvider = {
    spaceId,
    async embed() {
      calls++;
      return {
        vector: Float32Array.from(values),
        usage: { unit: "input_token", completeness: "COMPLETE", quantity: 3 },
      };
    },
  };
  const inspect = (p = path) =>
    buildDenseIndex(app, policy, actor, room.id, p, signal, provider);
  assert.equal((await inspect()).state, "ready");
  const queryOnly = configureSearchProfile(app, actor, room.id, {
    ...config(persona.id),
    purposes: ["QUERY_EMBEDDING"],
  });
  const oldBudget = budgetStatus(app, actor, room.id, initial.version);
  const sealed = app.db
    .prepare(
      "SELECT * FROM search_operations WHERE purpose='DOCUMENT_EMBEDDING'",
    )
    .get()!;
  const successfulVector = index.db
    .prepare("SELECT * FROM search_vectors")
    .get()!;
  const requireMissing = async (label: string) => {
    const coverage = await inspect();
    assert.equal(coverage.state, "incomplete_dense_coverage", label);
    assert.equal(coverage.indexed, 0, label);
    assert.equal(calls, 1, label);
  };

  // Representative persisted MEM-2 operation. Reuse never rewrites the old receipt, charge, or vector.
  assert.equal((await inspect()).state, "ready");
  assert.equal(initial.version + 1, queryOnly.version);
  for (const [column, bad] of [
    ["payload_digest", hash("different content")],
    [
      "source_ref",
      JSON.stringify({ ...JSON.parse(String(sealed.source_ref)), start: 999 }),
    ],
    ["state", "OUTCOME_UNKNOWN"],
    ["purpose", "QUERY_EMBEDDING"],
  ] as const) {
    const write = app.db.prepare(
      `UPDATE search_operations SET ${column}=? WHERE operation_id=?`,
    );
    write.run(bad, sealed.operation_id);
    await requireMissing(column);
    write.run(sealed[column], sealed.operation_id);
  }
  const historical = app.db
    .prepare("SELECT * FROM search_profiles WHERE version=?")
    .get(initial.version)!;
  const alterConfig = app.db.prepare(
    "UPDATE search_profiles SET config_json=?,config_digest=? WHERE version=?",
  );
  for (const change of [
    { purposes: ["QUERY_EMBEDDING"] },
    { scopes: ["room_shared"] },
    { personaId: "unrelated" },
  ]) {
    const configJson = JSON.stringify({
      ...JSON.parse(String(historical.config_json)),
      ...change,
    });
    alterConfig.run(configJson, hash(configJson), initial.version);
    await requireMissing(JSON.stringify(change));
  }
  alterConfig.run(
    historical.config_json,
    historical.config_digest,
    initial.version,
  );
  const setSpace = app.db.prepare(
    "UPDATE search_profiles SET space_id=? WHERE version=?",
  );
  setSpace.run("incompatible-space", initial.version);
  await requireMissing("old space");
  setSpace.run(historical.space_id, initial.version);
  const blob = Buffer.alloc(768 * 4);
  blob.writeFloatLE(NaN, 0);
  const setVector = index.db.prepare(
    "UPDATE search_vectors SET vector=? WHERE chunk_id=?",
  );
  setVector.run(blob, successfulVector.chunk_id);
  await requireMissing("invalid vector");
  const search = await searchDense(
    app,
    policy,
    actor,
    room.id,
    path,
    "語義",
    "invalid-floats",
    { provider },
  );
  assert.equal(search.state, "incomplete_dense_coverage");
  assert.equal(search.external.calls, 0);
  setVector.run(successfulVector.vector, successfulVector.chunk_id);
  const otherGeneration = join(f.root, "different-generation.sqlite");
  // Transplant just the valid old receipt/vector into a correctly formed second generation.
  const second = new SQLiteSearchBackend(otherGeneration, { create: true });
  try {
    second.applyPage({
      deletes: [],
      upserts: new SearchSources(app, policy, actor, room.id).memoryPage()
        .upserts,
    });
    second.db
      .prepare("INSERT INTO search_vectors VALUES(?,?,?,?)")
      .run(
        successfulVector.chunk_id,
        successfulVector.space_id,
        successfulVector.operation_id,
        successfulVector.vector,
      );
  } finally {
    second.close();
  }
  assert.equal(
    (await inspect(otherGeneration)).state,
    "incomplete_dense_coverage",
  );
  assert.equal((await inspect()).state, "ready");
  assert.equal(calls, 1);
  assert.deepEqual(
    budgetStatus(app, actor, room.id, initial.version),
    oldBudget,
  );
  assert.deepEqual(budgetStatus(app, actor, room.id, queryOnly.version), {
    calls: 0,
    costMicros: 0,
    tokens: 0,
  });
  assert.deepEqual(
    app.db.prepare("SELECT * FROM search_operations").get(),
    sealed,
  );
  assert.deepEqual(
    index.db.prepare("SELECT * FROM search_vectors").get(),
    successfulVector,
  );
});
