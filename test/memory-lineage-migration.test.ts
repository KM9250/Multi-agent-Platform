import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AppDatabase } from "../server/app-data/db.ts";
import { AuthorizationPolicy } from "../server/auth/authorization.ts";
import { ConversationRepository } from "../server/app-data/repository.ts";
import { MemoryCandidates } from "../server/memory/candidates.ts";
import { advanceLineage } from "../server/memory/lineage.ts";
import { readNote } from "../server/memory/notes.ts";

// Run the audited program to obtain its genuine ledger, receipt graph, private originals, and working Vault.
const audited = "b98241429466f1ad6406288c1f0ad724bafe6115";
test("PR39 F-01 migrates existing lineage and withholds stale or unprovable ancestry before serving", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "map-lineage-upgrade-")),
    old = join(dir, "audit");
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  mkdirSync(old);
  const archive = execFileSync(
    "git",
    [
      "archive",
      audited,
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
  execFileSync("tar", ["-xf", "-", "-C", old], { input: archive });
  symlinkSync(resolve("node_modules"), join(old, "node_modules"), "dir");
  copyFileSync(
    resolve("test/memory-lineage-fixture.ts"),
    join(old, "test/memory-lineage-fixture.ts"),
  );
  const source = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--experimental-transform-types",
        "--loader",
        "./test/ts-loader.mjs",
        "--input-type=module",
        "-e",
        `
    import { lineageFixture } from "./test/memory-lineage-fixture.ts";
    import { readNote } from "./server/memory/notes.ts";
    const f=lineageFixture(), neutral=await f.memory();
    f.publish(neutral.candidate.id);
    const chain=async()=>{
      const input=f.original(), first=await f.memory(), derived=await f.memory();
      f.publish(derived.candidate.id);
      return {input,origin:first.candidate.provenance.callId,id:derived.candidate.id,note:derived.noteId,refs:derived.candidate.sourceRefs};
    };
    const stale=await chain(); f.correct(stale.input);
    const future=await chain(), unknown=await chain(), missing=await chain();
    // A damaged old ancestor manifest must not make the derived current note available.
    f.app.db.prepare("UPDATE app_provider_calls SET manifest_digest='unknown' WHERE call_id=?").run(unknown.origin);
    f.app.db.prepare("UPDATE memory_candidates SET call_id=NULL,source_segment_id=NULL WHERE candidate_id=?").run(missing.id);
    console.log(JSON.stringify({root:f.root,actor:f.actor,room:f.room.id,neutral:neutral.noteId,stale,future,unknown,missing,
      oldBody:readNote(f.app,f.policy,f.actor,stale.note).body}));
    f.app.close();
  `,
      ],
      { cwd: old, env: { ...process.env, TMPDIR: dir }, encoding: "utf8" },
    ),
  );
  assert.equal(source.oldBody, "予定は月曜");
  const app = new AppDatabase({ root: source.root });
  t.after(() => app.close());
  // The audited schema-2 binary performs identification read-only and cannot reopen the upgraded DB.
  execFileSync(
    process.execPath,
    [
      "--experimental-transform-types",
      "--loader",
      "./test/ts-loader.mjs",
      "--input-type=module",
      "-e",
      `import assert from "node:assert/strict"; import {AppDatabase} from "./server/app-data/db.ts";
     assert.throws(()=>new AppDatabase({root:process.argv[1]}), /WRONG_DATABASE/);`,
      source.root,
    ],
    { cwd: old },
  );
  let batches = 0;
  while (advanceLineage(app))
    assert.ok(++batches < 2000, "legacy verification must converge");
  const policy = new AuthorizationPolicy(app),
    candidates = new MemoryCandidates(app, policy),
    repo = new ConversationRepository(app, policy);
  assert.equal(
    candidates.get(source.actor, source.room, source.missing.id).state,
    "NEEDS_REVIEW",
  );
  assert.throws(
    () => readNote(app, policy, source.actor, source.missing.note),
    /MEMORY_UNAVAILABLE/,
  );
  // The direct source ACL itself cannot be established for this damaged record.
  assert.throws(
    () => readNote(app, policy, source.actor, source.missing.note, 1),
    /NOT_FOUND/,
  );
  for (const chain of [source.stale, source.unknown]) {
    assert.equal(
      candidates.get(source.actor, source.room, chain.id).state,
      "NEEDS_REVIEW",
    );
    assert.throws(
      () => readNote(app, policy, source.actor, chain.note),
      /MEMORY_UNAVAILABLE/,
    );
    assert.equal(
      readNote(app, policy, source.actor, chain.note, 1).body,
      "予定は月曜",
    );
  }
  assert.equal(
    readNote(app, policy, source.actor, source.future.note).body,
    "予定は月曜",
  );
  assert.deepEqual(
    candidates.get(source.actor, source.room, source.future.id).sourceRefs,
    source.future.refs,
  );
  repo.correctMessage(source.actor, source.room, source.future.input, {
    expectedRevision: 1,
    content: "予定は火曜",
  });
  assert.throws(
    () => readNote(app, policy, source.actor, source.future.note),
    /MEMORY_UNAVAILABLE/,
  );
  assert.equal(
    readNote(app, policy, source.actor, source.neutral).body,
    "独立した記録",
  );
});
