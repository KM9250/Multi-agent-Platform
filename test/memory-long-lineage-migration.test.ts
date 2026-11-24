import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { basename, join, resolve } from "node:path";
import { AppDatabase } from "../server/app-data/db.ts";
import { ConversationRepository } from "../server/app-data/repository.ts";
import { AuthorizationPolicy } from "../server/auth/authorization.ts";
import { SessionService } from "../server/auth/sessions.ts";
import { MemoryCandidates } from "../server/memory/candidates.ts";
import { advanceLineage } from "../server/memory/lineage.ts";
import { readNote } from "../server/memory/notes.ts";
import { setVaultPaused } from "../server/memory/vault.ts";
import {
  BackupService,
  restoreBackup,
  resumeRestore,
} from "../server/operations/backup.ts";

// Two real releases are needed. The earlier release produced a valid review,
// job, Vault file and receipt; the second release changed these memories' state.
const reviewedRelease = "b98241429466f1ad6406288c1f0ad724bafe6115";
const heldRelease = "3370f59f60a4131676b5324a2ff4abdf714c65e3";
function release(dir: string, commit: string) {
  const checkout = join(dir, commit);
  mkdirSync(checkout);
  const archive = execFileSync(
    "git",
    [
      "archive",
      commit,
      "server",
      "shared",
      "services",
      "utils",
      "constants.ts",
      "types.ts",
      "package.json",
      "test/app-data-fixture.ts",
      "test/ts-loader.mjs",
    ],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  execFileSync("tar", ["-xf", "-", "-C", checkout], { input: archive });
  symlinkSync(resolve("node_modules"), join(checkout, "node_modules"), "dir");
  return checkout;
}
function run(checkout: string, temp: string, args: string[]) {
  return execFileSync(
    process.execPath,
    [
      "--experimental-transform-types",
      "--loader",
      "./test/ts-loader.mjs",
      ...args,
    ],
    {
      cwd: checkout,
      env: { ...process.env, TMPDIR: temp },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}
function finishProof(app: AppDatabase) {
  let batches = 0;
  while (advanceLineage(app)) {
    batches++;
    assert.ok(batches < 20000, "offline verification must converge");
  }
  return batches;
}

test("F-06: real schema 2 approvals survive direct upgrade and recover after schema 3 false holds, restart and detached restore", async (t) => {
  const temp = mkdtempSync(join(tmpdir(), "map-long-lineage-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const earlier = release(temp, reviewedRelease);
  const fixture = "test/memory-long-legacy-fixture.mjs";
  copyFileSync(resolve(fixture), join(earlier, fixture));
  const legacy = JSON.parse(run(earlier, temp, [fixture, temp]));
  // The release program has closed the DB. Both migration paths start from
  // the same committed ledger and immutable files. They only read the shared editable Vault.
  const directRoot = join(temp, "direct-schema-2");
  cpSync(legacy.root, directRoot, { recursive: true });
  const schema2 = new DatabaseSync(join(directRoot, "app-data.sqlite"), {
    readOnly: true,
  });
  try {
    assert.equal(
      schema2.prepare("SELECT schema_version FROM app_metadata").get()!
        .schema_version,
      2,
    );
    assert.equal(
      schema2
        .prepare("SELECT state FROM memory_documents WHERE note_id=?")
        .get(legacy.clean.note)!.state,
      "PUBLISHED",
    );
  } finally {
    schema2.close();
  }
  const second = release(temp, heldRelease);
  const missingCreatorRoot = join(temp, "old-membership-withdrawal");
  cpSync(directRoot, missingCreatorRoot, { recursive: true });
  const oldRoom = new DatabaseSync(join(missingCreatorRoot, "app-data.sqlite"));
  try {
    // Exercise the released schema's membership-removal trigger on a published note.
    // Room creation, the grants, candidate, approval and receipt came from the released APIs.
    const { room, actor } = legacy.main;
    const removed = oldRoom
      .prepare(
        `DELETE FROM room_memberships WHERE workspace_id=? AND room_id=?
      AND actor_id=(SELECT created_by FROM rooms WHERE workspace_id=? AND room_id=?)`,
      )
      .run(actor.workspaceId, room, actor.workspaceId, room);
    assert.equal(removed.changes, 1);
    assert.equal(
      oldRoom
        .prepare("SELECT state FROM memory_documents WHERE note_id=?")
        .get(legacy.clean.note)!.state,
      "NEEDS_REVIEW",
    );
  } finally {
    oldRoom.close();
  }
  run(second, temp, [
    "--input-type=module",
    "-e",
    `
    import {AppDatabase} from "./server/app-data/db.ts";
    const app=new AppDatabase({root:process.argv[1]});
    if (app.db.prepare("SELECT schema_version FROM app_metadata").get().schema_version!==3) throw Error("expected Schema 3");
    app.close();
  `,
    missingCreatorRoot,
  ]);
  const missingCreator = new AppDatabase({ root: missingCreatorRoot });
  try {
    assert.ok(finishProof(missingCreator) > 1);
    const work = missingCreator.db
      .prepare(
        "SELECT status,calls_done,refs_done FROM memory_lineage_work WHERE candidate_id=?",
      )
      .get(legacy.clean.candidate)!;
    assert.ok(Number(work.refs_done) > 16384 || Number(work.calls_done) > 256);
    assert.equal(work.status, "INVALID");
    const p = new AuthorizationPolicy(missingCreator);
    p.assert(legacy.main.actor, "READ_MEMORY", {
      roomId: legacy.main.room,
      personaId: legacy.main.persona,
      visibility: "persona_private",
    });
    assert.throws(
      () => readNote(missingCreator, p, legacy.main.actor, legacy.clean.note),
      /MEMORY_UNAVAILABLE/,
    );
    assert.equal(
      missingCreator.db
        .prepare("SELECT state FROM memory_documents WHERE note_id=?")
        .get(legacy.clean.note)!.state,
      "NEEDS_REVIEW",
    );
  } finally {
    missingCreator.close();
  }
  const before = JSON.parse(
    run(second, temp, [
      "--input-type=module",
      "-e",
      `
    import {AppDatabase} from "./server/app-data/db.ts";
    import {AuthorizationPolicy} from "./server/auth/authorization.ts";
    import {readNote} from "./server/memory/notes.ts";
    const [root,workspaceId,actorId,...noteIds]=process.argv.slice(1);
    const app=new AppDatabase({root}), policy=new AuthorizationPolicy(app);
    const held=noteIds.map(id=>{
      const row=app.db.prepare("SELECT c.state AS candidate,d.state AS document FROM memory_documents d JOIN memory_candidates c USING(candidate_id) WHERE d.note_id=?").get(id);
      try {readNote(app,policy,{actorId,workspaceId},id);}catch(error){row.read=error.code;}
      return row;
    });
    console.log(JSON.stringify(held));app.close();
  `,
      legacy.root,
      legacy.main.actor.workspaceId,
      legacy.main.actor.actorId,
      legacy.clean.note,
      legacy.edited.note,
    ]),
  );
  assert.deepEqual(
    before,
    Array.from({ length: 2 }, () => ({
      candidate: "NEEDS_REVIEW",
      document: "NEEDS_REVIEW",
      read: "MEMORY_UNAVAILABLE",
    })),
  );
  function unchanged(app: AppDatabase) {
    function records(query: string) {
      return JSON.parse(JSON.stringify(app.db.prepare(query).all()));
    }
    assert.deepEqual(
      records("SELECT * FROM memory_reviews ORDER BY review_id"),
      legacy.immutable.reviews,
    );
    assert.deepEqual(
      records("SELECT * FROM memory_receipts ORDER BY operation_id"),
      legacy.immutable.receipts,
    );
    assert.deepEqual(
      records("SELECT * FROM memory_versions ORDER BY note_id,version"),
      legacy.immutable.versions,
    );
    assert.deepEqual(
      records("SELECT * FROM memory_jobs ORDER BY operation_id"),
      legacy.immutable.jobs,
    );
    for (const [table, actual] of [
      ["app_provider_calls", legacy.immutable.calls],
      ["app_generation_receipts", legacy.immutable.generationReceipts],
    ] as const)
      assert.deepEqual(
        app.db
          .prepare(`SELECT call_id FROM ${table} ORDER BY call_id`)
          .all()
          .map((row) => row.call_id),
        actual,
      );
  }
  const progress = (app: AppDatabase) =>
    app.db
      .prepare(
        "SELECT candidate_id,status,calls_done,refs_done FROM memory_lineage_work ORDER BY candidate_id",
      )
      .all();
  let checkpoint: ReturnType<typeof progress>;
  const partial = new AppDatabase({ root: legacy.root });
  const backup = join(temp, "snapshot"),
    restoredRoot = join(temp, "detached");
  try {
    unchanged(partial);
    let work: ReturnType<typeof progress>, progressed: number;
    // The first scheduled row may itself be genuinely stale. Continue until
    // at least one valid call has been committed on the long verification.
    do {
      assert.equal(advanceLineage(partial), true);
      work = progress(partial);
      progressed = work.reduce((n, row) => n + Number(row.calls_done), 0);
    } while (progressed === 0);
    assert.ok(progressed <= 4);
    checkpoint = work;
    // One bounded tick cannot finish the long proof or publish an undecided candidate.
    const policy = new AuthorizationPolicy(partial);
    const held = new MemoryCandidates(partial, policy).get(
      legacy.main.actor,
      legacy.main.room,
      legacy.clean.candidate,
    );
    assert.equal(held.state, "NEEDS_REVIEW");
    assert.equal(held.rechecking, true);
    assert.equal(held.body, "");
    for (const note of [legacy.clean, legacy.edited])
      assert.throws(
        () => readNote(partial, policy, legacy.main.actor, note.note),
        /MEMORY_UNAVAILABLE/,
      );
    await new BackupService(partial).backup(backup);
  } finally {
    partial.close();
  }
  await restoreBackup(backup, restoredRoot);
  for (const [route, target] of [
    ["direct schema 2", directRoot],
    ["after schema 3 false hold", legacy.root],
    ["detached restore", restoredRoot],
  ] as const) {
    const app = new AppDatabase({ root: target });
    try {
      assert.equal(
        app.db.prepare("SELECT schema_version FROM app_metadata").get()!
          .schema_version,
        4,
      );
      const policy = new AuthorizationPolicy(app),
        candidates = new MemoryCandidates(app, policy);
      if (target === directRoot) {
        unchanged(app);
        assert.ok(progress(app).every((row) => row.calls_done === 0));
        for (const item of [legacy.clean, legacy.edited])
          assert.throws(
            () => readNote(app, policy, legacy.main.actor, item.note),
            /MEMORY_UNAVAILABLE/,
          );
      } else {
        assert.deepEqual(progress(app), checkpoint);
      }
      if (target === restoredRoot) {
        assert.equal(
          app.db.prepare("SELECT restored FROM app_operational_state").get()!
            .restored,
          1,
        );
        assert.equal(
          app.db.prepare("SELECT paused FROM memory_vault").get()!.paused,
          1,
        );
        try {
          assert.equal(advanceLineage(app), false);
        } catch (error) {
          if ((error as { code?: string }).code !== "MAINTENANCE") throw error;
        }
        assert.deepEqual(progress(app), checkpoint);
        assert.throws(
          () => readNote(app, policy, legacy.main.actor, legacy.clean.note),
          /MAINTENANCE/,
        );
        await new SessionService(app).resetPassword(
          legacy.main.actor.actorId,
          "synthetic-long-lineage-reset",
        );
        await resumeRestore(restoredRoot);
        assert.equal(
          app.db.prepare("SELECT paused FROM memory_vault").get()!.paused,
          1,
        );
        setVaultPaused(app, false);
      }
      const batches = finishProof(app);
      assert.ok(batches > 1);
      for (const note of [legacy.clean, legacy.edited]) {
        const current = readNote(app, policy, legacy.main.actor, note.note);
        assert.equal(current.body, note.body);
        assert.equal(current.version, note.version);
        assert.equal(current.digest, note.digest);
        const verified = candidates.get(
          legacy.main.actor,
          legacy.main.room,
          note.candidate,
        );
        assert.equal(verified.state, "PUBLISHED");
        assert.equal(verified.rechecking, undefined);
      }
      const pending = candidates.get(
        legacy.main.actor,
        legacy.main.room,
        legacy.pending.candidate,
      );
      assert.equal(pending.state, "PENDING_REVIEW");
      assert.equal(pending.rechecking, undefined);
      assert.ok(pending.body.length > 0);
      assert.equal(
        app.db
          .prepare("SELECT 1 FROM memory_documents WHERE note_id=?")
          .get(legacy.pending.note),
        undefined,
      );
      assert.equal(
        app.db
          .prepare("SELECT 1 FROM memory_reviews WHERE candidate_id=?")
          .get(legacy.pending.candidate),
        undefined,
      );
      for (const item of [
        legacy.corrected,
        legacy.withdrawn,
        legacy.revoked,
        legacy.drift,
      ]) {
        const actor =
          item === legacy.revoked ? legacy.other.actor : legacy.main.actor;
        const state = app.db
          .prepare("SELECT state FROM memory_documents WHERE note_id=?")
          .get(item.note)!.state;
        assert.notEqual(state, "PUBLISHED");
        const ownerRoom =
          item === legacy.revoked ? legacy.other.room : legacy.main.room;
        assert.equal(
          candidates.get(actor, ownerRoom, item.candidate).rechecking,
          undefined,
        );
        assert.throws(
          () => readNote(app, policy, actor, item.note),
          /MEMORY_UNAVAILABLE|NOT_FOUND/,
        );
      }
      assert.equal(
        app.db
          .prepare("SELECT state FROM memory_documents WHERE note_id=?")
          .get(legacy.withdrawn.note)!.state,
        "RETRACTED",
      );
      assert.equal(readFileSync(legacy.driftFile, "utf8"), legacy.humanBytes);
      if (target === restoredRoot)
        assert.equal(
          existsSync(
            join(restoredRoot, "restored-vault", basename(legacy.driftFile)),
          ),
          false,
        );
      unchanged(app);
      // The remote input is outside this /memory manifest's 50-message window;
      // its true ancestor revisions must still invalidate this recovered note.
      const repo = new ConversationRepository(app, policy);
      repo.correctMessage(legacy.main.actor, legacy.main.room, legacy.distant, {
        expectedRevision: 1,
        content: "訂正した日程",
      });
      assert.throws(
        () => readNote(app, policy, legacy.main.actor, legacy.clean.note),
        /MEMORY_UNAVAILABLE/,
      );
      assert.equal(
        app.db
          .prepare("SELECT state FROM memory_documents WHERE note_id=?")
          .get(legacy.clean.note)!.state,
        "NEEDS_REVIEW",
      );
      t.diagnostic(
        `${route}: ${batches} verification batches; preserved ${legacy.immutable.calls.length} provider calls, ${legacy.immutable.receipts.length} publication receipts, ${legacy.immutable.versions.length} versions`,
      );
    } finally {
      app.close();
    }
  }
});
