import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AppDatabase } from "../server/app-data/db.ts";
import * as lineage from "../server/memory/lineage.ts";
import { registerHandwrittenNote } from "../server/memory/importer.ts";
import { readNote } from "../server/memory/notes.ts";
import { lineageFixture } from "./memory-lineage-fixture.ts";

type Fixture = ReturnType<typeof lineageFixture>;
const callsPerSlice = 4;

function work(app: AppDatabase, id: string) {
  const row = app.db
    .prepare(
      "SELECT calls_done, refs_done FROM memory_lineage_work WHERE candidate_id=?",
    )
    .get(id);
  assert.ok(row);
  return { calls: Number(row.calls_done), refs: Number(row.refs_done) };
}

function assertSlice(
  before: ReturnType<typeof work>,
  after: ReturnType<typeof work>,
  maxRefs: number,
) {
  assert.ok(
    after.calls >= before.calls && after.calls - before.calls <= callsPerSlice,
    "one slice must bound verified unique manifests",
  );
  assert.ok(
    after.refs >= before.refs &&
      after.refs - before.refs <= callsPerSlice * maxRefs,
    "one slice must bound references",
  );
}

function settle(
  app: AppDatabase,
  id: string,
  maxSteps: number,
  maxRefs: number,
) {
  const state = app.db.prepare(
    "SELECT state FROM memory_candidates WHERE candidate_id=?",
  );
  const metrics = { steps: 0, maxCallsPerSlice: 0, maxRefsPerSlice: 0 };
  while (state.get(id)?.state === "LINEAGE_PENDING") {
    const before = work(app, id);
    assert.ok(
      ++metrics.steps <= maxSteps,
      "persisted lineage must reach a terminal state",
    );
    assert.equal(lineage.advanceLineage(app), true);
    const after = work(app, id);
    assertSlice(before, after, maxRefs);
    metrics.maxCallsPerSlice = Math.max(
      metrics.maxCallsPerSlice,
      after.calls - before.calls,
    );
    metrics.maxRefsPerSlice = Math.max(
      metrics.maxRefsPerSlice,
      after.refs - before.refs,
    );
  }
  return metrics;
}

// Reconstruct reachability from actual generation receipts and manifest references independently of MEM-1.
function ancestors(app: AppDatabase, rootOutput: string) {
  const rows = app.db
    .prepare(
      `SELECT t.message_id,c.manifest_json FROM app_generation_receipts t
    JOIN app_provider_calls c USING(workspace_id,room_id,run_id,call_id) WHERE t.status='COMPLETED'`,
    )
    .all();
  type Manifest = {
    messages: { id: string; segments: unknown[] }[];
    attachments: unknown[];
  };
  const manifests = new Map(
    rows.map((r) => [
      String(r.message_id),
      JSON.parse(String(r.manifest_json)) as Manifest,
    ]),
  );
  const seen = new Set<string>(),
    pending = [rootOutput];
  let refs = 0,
    maxRefs = 0;
  while (pending.length) {
    const id = pending.pop()!;
    const m = manifests.get(id);
    if (!m || seen.has(id)) continue;
    seen.add(id);
    const count =
      m.attachments.length +
      m.messages.reduce((n, msg) => n + 1 + msg.segments.length, 0);
    refs += count;
    maxRefs = Math.max(maxRefs, count);
    for (const msg of m.messages) pending.push(msg.id);
  }
  return { calls: seen.size, refs, maxRefs };
}

async function registerControl(f: Fixture) {
  const text =
    "---\nmap_id: independent_control\n---\nIndependent handwritten note.";
  writeFileSync(join(f.vault, "control.md"), text, { mode: 0o600 });
  f.policy.grant(f.actor.actorId, f.actor.workspaceId, "MANAGE_VAULT");
  await registerHandwrittenNote(f.app, f.policy, f.actor, {
    roomId: f.room.id,
    personaId: f.persona.id,
    scope: "persona_private",
    noteId: "independent_control",
    relativePath: "control.md",
    expectedDigest: createHash("sha256").update(text).digest("hex"),
    requestId: randomUUID(),
    trusted: false,
  });
}

for (const scenario of [
  {
    name: "default 50-message history with first-message pinning",
    turns: 180,
    useDefaultPersona: true,
  },
  {
    name: "two-message history with over 256 producer calls",
    turns: 260,
    useDefaultPersona: false,
  },
]) {
  test("PR39 F-06 first live /memory after " + scenario.name, async (t) => {
    const f = lineageFixture({ useDefaultPersona: scenario.useDefaultPersona });
    t.after(f.close);
    await registerControl(f);
    const config = f.repository.getPersona(f.actor, f.room.id, f.persona.id);
    assert.equal(config.historyWindow, scenario.useDefaultPersona ? 50 : 2);
    assert.equal(config.pinFirstMessage, scenario.useDefaultPersona);
    let firstInput = "",
      distantInput = "";
    for (let i = 1; i <= scenario.turns; i++) {
      const run = await f.turn(i === 2 ? "予定は月曜" : "記録 " + i);
      if (i <= 2) {
        const input = f.generation.get(f.actor, f.room.id, run).inputMessageId;
        if (i === 1) firstInput = input;
        else distantInput = input;
      }
    }
    assert.equal(
      f.app.db.prepare("SELECT COUNT(*) n FROM memory_candidates").get()!.n,
      0,
    );
    const requestId = randomUUID();
    const item = await f.memory(requestId);
    const candidateId = item.candidate.id;
    const reached = ancestors(f.app, item.outputId);
    assert.equal(
      reached.calls,
      scenario.turns + 1,
      "all ordinary generations really lie on this memory's source graph",
    );
    assert.equal(item.manifestInputs.length, config.historyWindow);
    assert.ok(
      !item.manifestInputs.includes(distantInput) &&
        distantInput !== firstInput,
    );
    if (scenario.useDefaultPersona) {
      assert.ok(item.manifestInputs.includes(firstInput));
      assert.ok(reached.refs > 16384);
    }
    assert.equal(
      item.candidate.state,
      "LINEAGE_PENDING",
      "healthy large ancestry must remain resumable",
    );
    assert.equal(item.candidate.body, "");
    assert.deepEqual(item.candidate.sourceRefs, []);
    assert.throws(() => f.publish(candidateId));
    assert.equal(
      f.app.db.prepare("SELECT COUNT(*) n FROM memory_reviews").get()!.n,
      0,
    );
    assert.equal(
      f.app.db.prepare("SELECT COUNT(*) n FROM memory_jobs").get()!.n,
      0,
    );
    assert.throws(() => readNote(f.app, f.policy, f.actor, item.noteId));
    assertSlice(
      { calls: 0, refs: 0 },
      work(f.app, candidateId),
      reached.maxRefs,
    );

    const beforeCrash = work(f.app, candidateId);
    const replayWhilePending = await f.memory(requestId);
    assert.equal(replayWhilePending.candidate.id, candidateId);
    assert.equal(replayWhilePending.runId, item.runId);
    assert.deepEqual(
      work(f.app, candidateId),
      beforeCrash,
      "re-querying the turn does not run or restart the verifier",
    );
    const child = spawnSync(
      process.execPath,
      [
        "--experimental-transform-types",
        "--loader",
        new URL("./ts-loader.mjs", import.meta.url).href,
        fileURLToPath(
          new URL("./memory-lineage-step-child.ts", import.meta.url),
        ),
        f.root,
      ],
      { encoding: "utf8", timeout: 30000 },
    );
    assert.equal(child.signal, "SIGKILL", child.stderr);
    const reopened = new AppDatabase({ root: f.root });
    let metrics: ReturnType<typeof settle>;
    try {
      const recovered = work(reopened, candidateId);
      assert.ok(recovered.calls > beforeCrash.calls);
      assertSlice(beforeCrash, recovered, reached.maxRefs);
      metrics = settle(
        reopened,
        candidateId,
        reached.calls + 2,
        reached.maxRefs,
      );
    } finally {
      reopened.close();
    }
    assert.ok(metrics.steps > 1);
    assert.equal(
      work(f.app, candidateId).calls,
      reached.calls,
      "each producer's manifest verified once",
    );
    assert.equal(
      f.candidates.get(f.actor, f.room.id, candidateId).state,
      "PENDING_REVIEW",
    );
    f.publish(candidateId);
    assert.equal(
      readNote(f.app, f.policy, f.actor, item.noteId).body,
      "予定は月曜",
    );
    const replay = f.generation.accept(f.actor, f.room.id, {
      content: "/memory",
      requestId,
      expectedRoomRevision: f.room.revision,
      recipient: { type: "all" },
    });
    assert.equal(replay.runId, item.runId);
    await f.generation.execute(replay.runId);
    assert.equal(f.provider.calls.length, reached.calls);
    for (const [table, count] of [
      ["app_provider_calls", reached.calls],
      ["app_generation_receipts", reached.calls],
      ["memory_candidates", 1],
      ["memory_reviews", 1],
      ["memory_jobs", 1],
      ["memory_receipts", 1],
    ] as const) {
      assert.equal(
        f.app.db.prepare("SELECT count(*) n FROM " + table).get()!.n,
        count,
        table,
      );
    }
    f.correct(distantInput);
    assert.equal(
      f.candidates.get(f.actor, f.room.id, candidateId).state,
      "NEEDS_REVIEW",
    );
    assert.throws(
      () => readNote(f.app, f.policy, f.actor, item.noteId),
      /MEMORY_UNAVAILABLE/,
    );
    assert.equal(
      readNote(f.app, f.policy, f.actor, "independent_control").body,
      "Independent handwritten note.",
    );
    t.diagnostic(
      JSON.stringify({
        ordinaryTurns: scenario.turns,
        providerCalls: f.provider.calls.length,
        directMessages: item.manifestInputs.length,
        uniqueManifests: reached.calls,
        rawRefs: reached.refs,
        remainingStepsAfterCrash: metrics.steps,
        maxCallsPerSlice: metrics.maxCallsPerSlice,
        maxRefsPerSlice: metrics.maxRefsPerSlice,
      }),
    );
  });
}

for (const mutation of [
  "correct",
  "delete",
  "revoke and regrant attachment access",
] as const) {
  test(
    "PR39 F-06 " +
      mutation +
      " before the pending verifier reaches an old source",
    async (t) => {
      const f = lineageFixture();
      t.after(f.close);
      await registerControl(f);
      const attachmentIds: string[] = [];
      if (mutation === "revoke and regrant attachment access") {
        const file = await f.attachmentStore.upload(f.actor, f.room.id, {
          name: "source.txt",
          mimeType: "text/plain",
          data: Buffer.from("予定は月曜"),
        });
        attachmentIds.push(file.id);
      }
      const source = f.repository.appendMessage(f.actor, f.room.id, {
        role: "user",
        content: "予定は月曜",
        attachmentIds,
      }).id;
      for (let i = 0; i < 20; i++) await f.turn("記録 " + i);
      const item = await f.memory(),
        id = item.candidate.id;
      const reached = ancestors(f.app, item.outputId);
      assert.equal(reached.calls, 21);
      assert.equal(item.candidate.state, "LINEAGE_PENDING");
      assert.ok(!item.manifestInputs.includes(source));
      assert.equal(lineage.advanceLineage(f.app), true);
      assert.equal(
        f.candidates.get(f.actor, f.room.id, id).state,
        "LINEAGE_PENDING",
      );
      assert.equal(
        f.app.db
          .prepare(
            "SELECT 1 FROM memory_dependencies WHERE candidate_id=? AND resource_id=?",
          )
          .get(id, source),
        undefined,
      );
      if (mutation === "correct") f.correct(source);
      else if (mutation === "delete")
        f.repository.deleteMessage(f.actor, f.room.id, source, {
          expectedRevision: 1,
        });
      else {
        f.policy.revoke(
          f.actor.actorId,
          f.actor.workspaceId,
          "READ_ATTACHMENT",
        );
        f.policy.grant(f.actor.actorId, f.actor.workspaceId, "READ_ATTACHMENT");
      }
      assert.throws(() => f.publish(id));
      settle(f.app, id, reached.calls + 2, reached.maxRefs);
      // A trigger can withhold the candidate before the worker records the terminal job status.
      for (let i = 0; lineage.advanceLineage(f.app); i++)
        assert.ok(i < reached.calls + 2);
      assert.equal(
        f.app.db
          .prepare(
            "SELECT status FROM memory_lineage_work WHERE candidate_id=?",
          )
          .get(id)!.status,
        "INVALID",
      );
      const blocked = f.candidates.get(f.actor, f.room.id, id);
      assert.equal(blocked.state, "NEEDS_REVIEW");
      assert.equal(blocked.body, "");
      assert.throws(() => f.publish(id));
      assert.equal(
        f.app.db.prepare("SELECT COUNT(*) n FROM memory_reviews").get()!.n,
        0,
      );
      assert.equal(
        f.app.db.prepare("SELECT COUNT(*) n FROM memory_jobs").get()!.n,
        0,
      );
      assert.equal(
        f.app.db.prepare("SELECT COUNT(*) n FROM memory_receipts").get()!.n,
        0,
      );
      assert.equal(f.provider.calls.length, 21);
      assert.equal(
        readNote(f.app, f.policy, f.actor, "independent_control").body,
        "Independent handwritten note.",
      );
    },
  );
}

test("PR39 F-06 correction of an already verified parent cannot be lost between slices", async (t) => {
  const f = lineageFixture();
  t.after(f.close);
  let lastRun = "";
  for (let i = 0; i < 20; i++) lastRun = await f.turn("記録 " + i);
  const parentInput = f.generation.get(
    f.actor,
    f.room.id,
    lastRun,
  ).inputMessageId;
  const item = await f.memory();
  assert.equal(item.candidate.state, "LINEAGE_PENDING");
  assert.ok(!item.manifestInputs.includes(parentInput));
  assert.ok(
    f.app.db
      .prepare(
        "SELECT 1 FROM memory_dependencies WHERE candidate_id=? AND resource_id=?",
      )
      .get(item.candidate.id, parentInput),
  );
  f.correct(parentInput);
  for (let i = 0; lineage.advanceLineage(f.app); i++) assert.ok(i < 23);
  assert.equal(
    f.candidates.get(f.actor, f.room.id, item.candidate.id).state,
    "NEEDS_REVIEW",
  );
  assert.throws(() => f.publish(item.candidate.id));
  assert.equal(
    f.app.db.prepare("SELECT COUNT(*) n FROM memory_jobs").get()!.n,
    0,
  );
  assert.equal(f.provider.calls.length, 21);
});
