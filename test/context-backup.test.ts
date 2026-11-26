import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appFixture } from "./app-data-fixture.ts";
import { lineageFixture } from "./memory-lineage-fixture.ts";
import { AppDatabase } from "../server/app-data/db.ts";
import { digest } from "../server/app-data/validation.ts";
import { SessionService } from "../server/auth/sessions.ts";
import { BackupService, restoreBackup, resumeRestore } from "../server/operations/backup.ts";
import { createAiSearchBinding } from "../server/search/ai-binding.ts";
import { configureSearchProfile } from "../server/search/profile.ts";
import { requestIndexUpdate, shutdownIndexWorkers } from "../server/search/index.ts";
import { reserveAnswerHold, reserveSearchRunBinding } from "../server/generation/search-budget.ts";
import { advanceLineage } from "../server/memory/lineage.ts";

function temporary(t: any) {
  const root = mkdtempSync(join(tmpdir(), "map-context-backup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
const rows = (app: AppDatabase, sql: string) => JSON.parse(JSON.stringify(app.db.prepare(sql).all()));

test("MEM-3A backup keeps answer manifests and search parents while restore releases unused holds without replay", async (t) => {
  const f = appFixture(), temp = temporary(t);
  t.after(async () => { await shutdownIndexWorkers(f.app); f.dispose(); });
  f.app.db.prepare("INSERT INTO auth_accounts VALUES(?,'context-host','synthetic',1,1)").run(f.actor.actorId);
  const answer = f.generation.accept(f.actor, f.room.id, {
    requestId: randomUUID(), expectedRoomRevision: f.room.revision, content: "hello",
    recipient: { type: "all" }, context: { mode: "none" },
  });
  await f.generation.execute(answer.runId);
  assert.equal(f.generation.get(f.actor, f.room.id, answer.runId).status, "COMPLETED");
  const completed = rows(f.app, "SELECT * FROM app_provider_calls ORDER BY call_id");
  assert.equal(JSON.parse(completed[0].manifest_json).contract, "MAP-MEM-3:CONTEXT:1");
  const request = f.generation.accept(f.actor, f.room.id, {
    requestId: randomUUID(), expectedRoomRevision: f.room.revision, content: "保存方式",
    recipient: { type: "all" }, context: { mode: "memory" },
  });
  f.app.db.prepare("UPDATE app_generation_runs SET state='RUNNING' WHERE run_id=?").run(request.runId);
  const binding = createAiSearchBinding(f.app, f.policy, f.actor, {
    runId: request.runId, planId: randomUUID(), consumerPersonaId: f.persona.id, provider: "synthetic", model: "synthetic",
  });
  const profile = configureSearchProfile(f.app, f.actor, f.room.id, {
    personaId: f.persona.id, scopes: ["room_shared"], purposes: ["QUERY_EMBEDDING"],
    maxCalls: 10, maxTokens: 100000, maxCostMicros: 10000, priceMicrosPerThousandTokens: 100,
    aiContext: { queryEmbedding: true, consumerPersonaIds: [f.persona.id], currency: "JPY" },
  });
  reserveAnswerHold(f.app, f.actor, { binding, reservedInputTokens: 128, reservedOutputTokens: 128,
    reservedCostMicros: 100, pricingVersion: "synthetic-host", currency: "JPY" });
  const operationId = randomUUID();
  f.app.transaction(() => {
    f.app.db.prepare(`INSERT INTO search_operations
      (operation_id,workspace_id,actor_id,room_id,profile_version,purpose,payload_digest,state,
        reserved_tokens,reserved_cost_micros,created_at,dispatched_at,finished_at)
      VALUES(?,?,?,?,?,'QUERY_EMBEDDING',?,'OUTCOME_UNKNOWN',8192,820,1,1,2)`)
      .run(operationId, f.actor.workspaceId, f.actor.actorId, f.room.id, profile.version, digest("synthetic-only"));
    reserveSearchRunBinding(f.app, f.actor, binding, operationId, 8192, 820, "JPY");
    f.app.db.prepare("UPDATE app_generation_runs SET state='NEEDS_REVIEW',error_code='SEARCH_OUTCOME_UNKNOWN' WHERE run_id=?")
      .run(request.runId);
  });
  const search = rows(f.app, "SELECT * FROM search_operations");
  const parents = rows(f.app, "SELECT * FROM search_operation_bindings");
  const backup = join(temp, "backup"), restored = join(temp, "restored");
  const manifest = await new BackupService(f.app).backup(backup);
  assert.equal(manifest.appSchema, 7);
  await restoreBackup(backup, restored);
  const app = new AppDatabase({ root: restored });
  try {
    assert.deepEqual(rows(app, "SELECT * FROM search_operations"), search);
    assert.deepEqual(rows(app, "SELECT * FROM search_operation_bindings"), parents);
    assert.deepEqual(rows(app, "SELECT * FROM app_provider_calls ORDER BY call_id"), completed);
    assert.equal(app.db.prepare("SELECT state FROM app_context_answer_holds WHERE plan_id=?").get(binding.planId)!.state, "RELEASED");
    assert.equal(app.db.prepare("SELECT state FROM app_generation_runs WHERE run_id=?").get(request.runId)!.state, "NEEDS_REVIEW");
    assert.equal(app.db.prepare("SELECT active FROM search_profiles").get()!.active, 0);
    const report = JSON.parse(readFileSync(join(restored, "restore-report.json"), "utf8"));
    assert.equal(report.schema, "MAP-MEM-3:RESTORE:7");
    assert.match(report.contextControlDigest, /^[a-f0-9]{64}$/);
    await new SessionService(app).resetPassword(f.actor.actorId, "synthetic-context-backup-reset");
    await resumeRestore(restored);
    assert.equal(app.db.prepare("SELECT restored FROM app_operational_state").get()!.restored, 0);
    assert.equal(f.provider.calls.length, 1, "only the original synthetic answer executes");
  } finally { app.close(); }
});

test("MEM-3A pending NOTE authority frontier survives backup and advances after explicit restore resume", async (t) => {
  const f = lineageFixture(), temp = temporary(t);
  t.after(async () => { await shutdownIndexWorkers(f.app); f.close(); });
  f.app.db.prepare("INSERT INTO auth_accounts VALUES(?,'lineage-host','synthetic',1,1)").run(f.actor.actorId);
  const scope = { roomId: f.room.id, personaId: f.persona.id, visibility: "room_shared" };
  for (const operation of ["READ_MEMORY", "PUBLISH_MEMORY", "CHANGE_MEMORY_SCOPE"])
    f.policy.grant(f.actor.actorId, f.actor.workspaceId, operation, scope);
  f.policy.grant(f.actor.actorId, f.actor.workspaceId, "EDIT_MEMORY", { ...scope, visibility: "persona_private" });
  f.original();
  const first = await f.memory();
  const old = first.candidate;
  f.candidates.edit(f.actor, f.room.id, old.id, { requestId: randomUUID(), expectedRevision: old.revision,
    body: old.body, kind: old.kind, assertionType: old.assertionType, scope: "room_shared" });
  f.publish(old.id);
  for (let index = 0; index < 160; index++) {
    const actorId = `restore-note-authority-${index}`;
    f.app.db.prepare("INSERT INTO principals VALUES(?,?,1)").run(actorId, f.actor.workspaceId);
    f.policy.grant(actorId, f.actor.workspaceId, "READ_ROOM", { roomId: f.room.id });
    f.app.db.prepare("INSERT INTO memory_authorities VALUES(?,?,'READ_ROOM',?,'','')").run(old.id, actorId, f.room.id);
  }
  await requestIndexUpdate(f.app, f.policy, f.actor, f.room.id, { force: true });
  const answer = f.generation.accept(f.actor, f.room.id, { requestId: randomUUID(), expectedRoomRevision: f.room.revision,
    content: "予定は何に決めていましたか", recipient: { type: "all" }, context: { mode: "memory" } });
  await f.generation.execute(answer.runId);
  const receipt = f.generation.get(f.actor, f.room.id, answer.runId);
  assert.equal(receipt.status, "COMPLETED", receipt.errorCode);
  const manifest = JSON.parse(String(f.app.db.prepare("SELECT manifest_json FROM app_provider_calls WHERE run_id=?").get(answer.runId)!.manifest_json));
  assert.equal(manifest.retrieval.sources[0]?.citation.noteId, first.noteId);
  const second = await f.memory();
  assert.equal(second.candidate.state, "LINEAGE_PENDING");
  const frontier = rows(f.app, "SELECT * FROM memory_lineage_notes ORDER BY candidate_id,note_id");
  assert.equal(frontier.length, 1);
  assert.equal(frontier[0].checked, 0);
  const backup = join(temp, "backup"), restored = join(temp, "restored");
  await new BackupService(f.app).backup(backup);
  await restoreBackup(backup, restored);
  const app = new AppDatabase({ root: restored });
  try {
    assert.deepEqual(rows(app, "SELECT * FROM memory_lineage_notes ORDER BY candidate_id,note_id"), frontier);
    assert.equal(app.db.prepare("SELECT status FROM memory_lineage_work WHERE candidate_id=?").get(second.candidate.id)!.status, "PENDING");
    await new SessionService(app).resetPassword(f.actor.actorId, "synthetic-note-frontier-reset");
    await resumeRestore(restored);
    let slices = 0;
    while (advanceLineage(app)) assert.ok(++slices < 100);
    assert.ok(slices > 1);
    const finished = app.db.prepare("SELECT status,notes_done FROM memory_lineage_work WHERE candidate_id=?").get(second.candidate.id)!;
    assert.equal(finished.status, "DONE");
    assert.equal(finished.notes_done, 1);
  } finally { app.close(); }
});

test("MEM-3A backup rejects unknown sources and rebound Plans; resume detects changes to sealed generation records", async (t) => {
  const f = appFixture(), temp = temporary(t);
  t.after(async () => { await shutdownIndexWorkers(f.app); f.dispose(); });
  f.app.db.prepare("INSERT INTO auth_accounts VALUES(?,'sealed-host','synthetic',1,1)").run(f.actor.actorId);
  const run = f.generation.accept(f.actor, f.room.id, { requestId: randomUUID(), expectedRoomRevision: f.room.revision,
    content: "hello", recipient: { type: "all" }, context: { mode: "none" } });
  await f.generation.execute(run.runId);
  const backup = join(temp, "valid"), restored = join(temp, "restored");
  await new BackupService(f.app).backup(backup);
  await restoreBackup(backup, restored);
  const app = new AppDatabase({ root: restored });
  try {
    await new SessionService(app).resetPassword(f.actor.actorId, "synthetic-sealed-context-reset");
    app.db.prepare("UPDATE app_generation_runs SET error_code='changed-after-restore' WHERE run_id=?").run(run.runId);
    await assert.rejects(resumeRestore(restored), /RESTORE_REFERENCE_MISMATCH/);
  } finally { app.close(); }
  const call = f.app.db.prepare("SELECT call_id,manifest_json FROM app_provider_calls").get()!;
  for (const [name, change, error] of [
    ["unknown-source", (manifest: any) => manifest.retrieval.sources.push({ alias: "S1", citation: { target: "summary" } }), /BACKUP_CONTEXT_MANIFEST_INVALID/],
    ["rebound-plan", (manifest: any) => { manifest.retrieval.runId = randomUUID(); }, /BACKUP_CONTEXT_BINDING_INVALID/],
  ] as const) {
    const manifest = JSON.parse(String(call.manifest_json));
    change(manifest);
    const invalid = JSON.stringify(manifest);
    f.app.db.prepare("UPDATE app_provider_calls SET manifest_json=?,manifest_digest=? WHERE call_id=?")
      .run(invalid, digest(invalid), call.call_id);
    const rejected = join(temp, name);
    await assert.rejects(new BackupService(f.app).backup(rejected), error);
    assert.equal(existsSync(join(rejected, "manifest.json")), false);
    assert.equal(f.app.db.prepare("SELECT maintenance FROM app_operational_state").get()!.maintenance, 0);
  }
});
