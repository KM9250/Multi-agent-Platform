import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { digest } from "../server/app-data/validation.ts";
import { registerHandwrittenNote } from "../server/memory/importer.ts";
import { registerVault, setVaultPaused } from "../server/memory/vault.ts";
import {
  acquireActiveIndex,
  requestIndexUpdate,
} from "../server/search/index.ts";
import {
  configureSearchProfile,
  stopSearchProfile,
} from "../server/search/profile.ts";
import { httpFixture } from "./http-fixture.ts";

test("F-03/F-04 HTTP reports only visible lag, then completes Archive and local Memory searches", async (t) => {
  const f = await httpFixture(t);
  const { app, actor, policy, repository } = f;
  await f.login();
  const room = repository.createRoom(actor, { title: "searched room" });
  const other = repository.createRoom(actor, { title: "unrelated room" });
  policy.grant(actor.actorId, actor.workspaceId, "MANAGE_VAULT");
  const vault = mkdtempSync(join(tmpdir(), "map-freshness-vault-"));
  t.after(() => rmSync(vault, { recursive: true, force: true }));
  registerVault(app, vault, { trustNew: true });
  setVaultPaused(app, false);

  const owner = (roomId: string) => {
    const persona = repository.createPersona(actor, roomId, {
      name: "Synthetic owner",
      model: "synthetic",
    });
    for (const op of ["READ_MEMORY", "REVIEW_MEMORY", "PUBLISH_MEMORY"])
      policy.grant(actor.actorId, actor.workspaceId, op, {
        roomId,
        personaId: persona.id,
        visibility: "persona_private",
      });
    return persona.id;
  };
  const personaId = owner(room.id);
  const otherPersona = owner(other.id);
  const note = async (
    roomId: string,
    persona: string,
    noteId: string,
    body: string,
  ) => {
    const relativePath = noteId + ".md";
    const markdown = `---\nmap_id: ${noteId}\n---\n${body}`;
    writeFileSync(join(vault, relativePath), markdown);
    await registerHandwrittenNote(app, policy, actor, {
      roomId,
      personaId: persona,
      scope: "persona_private",
      noteId,
      relativePath,
      expectedDigest: digest(markdown),
      requestId: randomUUID(),
      trusted: true,
    });
  };
  const otherNote = "noise-note";
  await note(other.id, otherPersona, otherNote, "unrelated");
  const sync = () =>
    requestIndexUpdate(app, policy, actor, room.id, { force: true });
  await sync();
  // The host clock is fixed; only detected lag can trigger an early refresh in this test.
  const initial = acquireActiveIndex(app, policy, actor, room.id);
  assert.equal(initial.state, "ACTIVE");
  t.mock.timers.enable({ apis: ["Date"], now: initial.syncedAt });
  const post = async (
    target: string,
    query: string,
    retrievalMode = "auto",
  ) => {
    const { data, response } = await f.request(
      `/rooms/${room.id}/search`,
      "POST",
      {
        target,
        query,
        retrievalMode,
        requestId: randomUUID(),
      },
    );
    assert.equal(response.status, 200, JSON.stringify(data));
    return data;
  };
  const archiveNoise = () =>
    app.transaction(() => {
      for (let i = 0; i < 80; i++)
        repository.appendMessage(actor, other.id, {
          role: "user",
          content: "unrelated",
        });
    });
  // Generate committed metadata changes through the Memory trigger on a real note in the other room.
  const memoryNoise = () =>
    app.transaction(() => {
      const flip = app.db.prepare(
        "UPDATE memory_documents SET trusted=1-trusted WHERE note_id=?",
      );
      for (let i = 0; i < 80; i++) flip.run(otherNote);
    });
  for (const target of ["archive", "memory"] as const) {
    const noise = target === "archive" ? archiveNoise : memoryNoise;
    const query = target === "archive" ? "燈台" : "羅針盤";
    const pinned = acquireActiveIndex(app, policy, actor, room.id);
    assert.equal(pinned.state, "ACTIVE");
    noise();
    const unrelated = await post(target, query);
    assert.equal(unrelated.status, "ready", JSON.stringify(unrelated));
    assert.deepEqual(unrelated.reasons, []);
    assert.deepEqual(unrelated.results, []);
    assert.equal(unrelated.coverage.updating, false);
    if (target === "archive")
      repository.appendMessage(actor, room.id, {
        role: "user",
        content: query,
      });
    else await note(room.id, personaId, "visible-note", query);
    noise();
    const pending = await post(target, query);
    assert.equal(pending.status, "partial", JSON.stringify(pending));
    assert.deepEqual(pending.reasons, ["INDEX_LAGGING"]);
    assert.deepEqual(pending.results, []);
    assert.equal(pending.coverage.syncedAt, pinned.syncedAt);
    assert.deepEqual(pending.methods, ["lexical"]);
    assert.equal(pending.external.calls, 0);
    // A worker can finish while HTTP verifies the original; freshness refers to its pinned checkpoint.
    await sync();
    const complete = await post(target, query);
    assert.equal(complete.status, "ready", JSON.stringify(complete));
    assert.deepEqual(complete.reasons, []);
    assert.deepEqual(complete.methods, ["lexical"]);
    assert.equal(complete.results[0].snippet, query);
    assert.equal(complete.coverage.updating, false);
  }

  // This query has no lexical match, and an explicit hybrid request also lacks a query profile.
  await note(room.id, personaId, "another-note", "観測");
  const combined = await post("memory", "完全無一致", "hybrid");
  assert.equal(combined.status, "partial");
  assert.deepEqual(
    new Set(combined.reasons),
    new Set(["INDEX_LAGGING", "profile_unconfigured_or_stopped"]),
  );
  assert.equal(combined.results.length, 0);
  assert.equal(combined.external.calls, 0);
  await sync();
  configureSearchProfile(app, actor, room.id, {
    personaId,
    scopes: ["persona_private"],
    purposes: ["DOCUMENT_EMBEDDING"],
    maxCalls: 1,
    maxTokens: 8192,
    maxCostMicros: 10000,
    priceMicrosPerThousandTokens: 100,
  });
  const noQuery = await post("memory", "羅針盤");
  assert.equal(noQuery.status, "ready");
  assert.deepEqual(noQuery.reasons, []);
  assert.deepEqual(noQuery.methods, ["lexical"]);
  const explicit = await post("memory", "完全無一致", "hybrid");
  assert.equal(explicit.status, "degraded");
  assert.deepEqual(explicit.reasons, ["query_disabled"]);
  stopSearchProfile(app, actor, room.id);
  const stopped = await post("memory", "完全無一致");
  assert.equal(stopped.status, "ready");
  assert.deepEqual(stopped.results, []);
  assert.deepEqual(stopped.reasons, []);
  assert.deepEqual(stopped.methods, ["lexical"]);
  assert.equal(stopped.external.calls, 0);
  assert.equal(
    app.db.prepare("SELECT COUNT(*) AS n FROM search_operations").get()!.n,
    0,
  );
});
