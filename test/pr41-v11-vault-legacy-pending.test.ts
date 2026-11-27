import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AppDatabase } from "../server/app-data/db.ts";
import { AuthorizationPolicy } from "../server/auth/authorization.ts";
import { advanceLineage } from "../server/memory/lineage.ts";
import { readNote } from "../server/memory/notes.ts";
import { scanVault } from "../server/memory/importer.ts";
import { digest } from "../server/app-data/validation.ts";

test("PR41 v1.1 F01: genuine released publication keeps its legacy proof pending during a worker-first Vault outage", async t => {
  const dir = mkdtempSync(join(tmpdir(), "pr41-v11-legacy-vault-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const old = join(dir, "release"); mkdirSync(old);
  const releasedHead = "b98241429466f1ad6406288c1f0ad724bafe6115";
  const archive = execFileSync("git", ["archive", releasedHead, "server", "shared", "services", "utils", "constants.ts", "types.ts", "package.json", "test/app-data-fixture.ts", "test/ts-loader.mjs"], { maxBuffer: 32 * 1024 * 1024 });
  execFileSync("tar", ["-xf", "-", "-C", old], { input: archive });
  symlinkSync(resolve("node_modules"), join(old, "node_modules"), "dir");
  copyFileSync(resolve("test/memory-lineage-fixture.ts"), join(old, "test/memory-lineage-fixture.ts"));
  const source = JSON.parse(execFileSync(process.execPath, ["--experimental-transform-types", "--loader", "./test/ts-loader.mjs", "--input-type=module", "-e", `
    import {lineageFixture} from "./test/memory-lineage-fixture.ts";
    const f=lineageFixture(); f.original(); const memory=await f.memory(); f.publish(memory.candidate.id);
    const doc=f.app.db.prepare("SELECT relative_path,digest,state FROM memory_documents WHERE note_id=?").get(memory.noteId);
    console.log(JSON.stringify({root:f.root,vault:f.vault,actor:f.actor,roomId:f.room.id,candidateId:memory.candidate.id,noteId:memory.noteId,doc,schema:f.app.db.prepare("SELECT schema_version FROM app_metadata").get().schema_version,syntheticProviderCalls:f.provider.calls.length}));
    await f.generation.shutdown(); f.app.close();
  `], { cwd: old, env: { ...process.env, TMPDIR: dir }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  assert.equal(source.schema, 2);
  assert.equal(source.doc.state, "PUBLISHED");
  const normalRoot = join(dir, "normal"), outageRoot = join(dir, "outage"), scanFirstRoot = join(dir, "scan-first");
  cpSync(source.root, normalRoot, { recursive: true });
  cpSync(source.root, outageRoot, { recursive: true });
  cpSync(source.root, scanFirstRoot, { recursive: true });
  const normal = new AppDatabase({ root: normalRoot });
  const snapshot = (app: AppDatabase) => ({
    work: app.db.prepare("SELECT mode,prior_state,status,calls_done,refs_done,notes_done,invalidated FROM memory_lineage_work WHERE candidate_id=?").get(source.candidateId),
    candidate: app.db.prepare("SELECT state FROM memory_candidates WHERE candidate_id=?").get(source.candidateId),
    document: app.db.prepare("SELECT state,version,digest FROM memory_documents WHERE note_id=?").get(source.noteId),
    frontier: app.db.prepare("SELECT call_id,checked FROM memory_lineage_queue WHERE candidate_id=? ORDER BY call_id").all(source.candidateId),
    incomplete: app.db.prepare("SELECT incomplete FROM memory_scan_state").get()!.incomplete,
  });
  let normalAfter: ReturnType<typeof snapshot>;
  try {
    let slices=0; while(advanceLineage(normal)) assert.ok(++slices < 20);
    normalAfter=snapshot(normal);
    assert.equal(normalAfter.work!.status, "DONE");
    assert.equal(normalAfter.candidate!.state, "PUBLISHED");
    assert.equal(normalAfter.document!.state, "PUBLISHED");
    assert.equal(normalAfter.document!.digest, source.doc.digest);
    assert.equal(readNote(normal, new AuthorizationPolicy(normal), source.actor, source.noteId).state, "PUBLISHED");
  } finally { normal.close(); }
  const scanFirstApp = new AppDatabase({ root: scanFirstRoot });
  let scanFirst: any;
  const scanAway=source.vault+"-scan-away";
  try {
    const beforeScan=snapshot(scanFirstApp);
    renameSync(source.vault, scanAway);
    try {
      const failedScan=await scanVault(scanFirstApp);
      assert.equal(failedScan.status,"SCAN_FAILED");
      assert.equal(advanceLineage(scanFirstApp),true);
      const afterWorker=snapshot(scanFirstApp);
      assert.equal(afterWorker.work!.status,"PENDING");
      assert.equal(afterWorker.candidate!.state,"LINEAGE_PENDING");
      assert.equal(afterWorker.document!.state,"LINEAGE_PENDING");
      scanFirst={before:beforeScan,failedScan,afterWorker};
    } finally { renameSync(scanAway,source.vault); }
    scanFirst.recovery=await scanVault(scanFirstApp);
    assert.equal(scanFirst.recovery.status,"COMPLETE");
    let slices=0;while(advanceLineage(scanFirstApp))assert.ok(++slices<20);
    scanFirst.afterRecovery=snapshot(scanFirstApp);
    assert.equal(scanFirst.afterRecovery.work.status,"DONE");
    assert.equal(scanFirst.afterRecovery.candidate.state,"PUBLISHED");
    assert.equal(scanFirst.afterRecovery.document.state,"PUBLISHED");
    assert.equal(scanFirst.afterRecovery.document.digest,source.doc.digest);
  } finally { scanFirstApp.close(); }
  const app = new AppDatabase({ root: outageRoot });
  t.after(() => app.close());
  const before=snapshot(app);
  assert.equal(before.work!.status, "PENDING");
  assert.equal(before.work!.mode, "LEGACY");
  assert.equal(before.work!.prior_state, "PUBLISHED");
  assert.equal(before.candidate!.state, "LINEAGE_PENDING");
  assert.equal(before.document!.state, "LINEAGE_PENDING");
  assert.equal(before.incomplete, 0);
  const fileBefore=digest(readFileSync(join(source.vault, source.doc.relative_path)));
  const away=source.vault+"-away";
  renameSync(source.vault, away);
  let afterWorker: ReturnType<typeof snapshot>, afterRetry: ReturnType<typeof snapshot>;
  try {
    assert.equal(advanceLineage(app), true); afterWorker=snapshot(app);
    assert.equal(advanceLineage(app), true); afterRetry=snapshot(app);
  }
  finally { renameSync(away, source.vault); }
  const recovery=await scanVault(app);
  let slices=0; while(advanceLineage(app)) assert.ok(++slices < 20);
  const afterRecovery=snapshot(app);
  const result={auditedHead:"1869fb7d0feb82662a7704e0d97e98002cc74022",releasedHead,sourceSchema:source.schema,normalAfter,scanFirst,before,afterWorker,afterRetry,recovery,afterRecovery,fileBefore,fileAfter:digest(readFileSync(join(source.vault,source.doc.relative_path))),syntheticProviderCalls:source.syntheticProviderCalls,realProviderCalls:0,actualReleasedPublication:true,forgedManifestOrDependencies:false};
  const evidenceDir=process.env.PR41_V11_AUDIT_EVIDENCE_DIR ?? "/tmp/pr41-v11-reaudit-evidence";
  mkdirSync(evidenceDir,{recursive:true}); writeFileSync(join(evidenceDir,"f01-legacy-worker-before-scan.json"),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
  assert.equal(result.fileAfter,fileBefore);
  assert.equal(fileBefore,source.doc.digest);
  assert.equal(afterWorker.work!.status,"PENDING","a temporary root outage must not permanently reject an authentic migrated publication");
  assert.equal(afterWorker.candidate!.state,"LINEAGE_PENDING","temporary APPROVED state must be rolled back");
  assert.equal(afterWorker.document!.state,"LINEAGE_PENDING");
  assert.equal(afterWorker.work!.invalidated,0);
  assert.equal(afterWorker.incomplete,0,"the worker observed the outage before any failed scan");
  assert.ok(Number(afterWorker.work!.calls_done)>Number(before.work!.calls_done));
  assert.ok(Number(afterWorker.work!.refs_done)>Number(before.work!.refs_done));
  assert.ok(afterWorker.frontier.every(row=>row.checked===1));
  assert.deepEqual(afterRetry,afterWorker,"another outage retry retains completed CALL/REF proof and held states");
  assert.equal(recovery.status,"COMPLETE");
  assert.equal(afterRecovery.work!.status,"DONE");
  assert.equal(afterRecovery.candidate!.state,"PUBLISHED");
  assert.equal(afterRecovery.document!.state,"PUBLISHED");
  assert.equal(afterRecovery.document!.digest,source.doc.digest);
  assert.equal(afterRecovery.work!.calls_done,afterWorker.work!.calls_done);
  assert.equal(afterRecovery.work!.refs_done,afterWorker.work!.refs_done);
  assert.deepEqual(afterRecovery.frontier,afterWorker.frontier);
});
