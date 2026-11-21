import type { AppDatabase } from "../app-data/db.ts";
import {
  AppError,
  type Actor,
  type AuthorizationPort,
} from "../../shared/app-contracts/index.ts";
import { canonical, digest, object, string } from "../app-data/validation.ts";
import { assertPublicationCapacity } from "./limits.ts";
import { assertPublishable } from "./candidates.ts";
import {
  memoryScope,
  assertSourceAccess,
  assertSourcesCurrent,
} from "./sources.ts";
import { parseMemoryMarkdown } from "./markdown.ts";
import {
  prepareFrozen,
  publishFrozen,
  readVaultFile,
  saveVersion,
} from "./vault.ts";

type Job = {
  operation_id: string;
  candidate_id: string;
  revision: number;
  workspace_id: string;
  room_id: string;
  owner_persona_id: string;
  scope: string;
  reviewer_id: string;
  note_id: string;
  relative_path: string;
  markdown: string;
  file_digest: string;
  status: string;
  created_at: number;
};
type Hooks = {
  afterSelection?: () => void;
  afterPrepared?: () => void;
  afterLink?: () => void;
  beforeReceipt?: () => void;
};
function active(app: AppDatabase): boolean {
  return !!app.db
    .prepare(
      `SELECT 1 FROM memory_vault CROSS JOIN app_operational_state AS op
    WHERE paused=0 AND maintenance=0 AND restored=0`,
    )
    .get();
}
function setStatus(
  app: AppDatabase,
  job: Job,
  status: string,
  code: string | null = null,
): void {
  app.db
    .prepare(
      "UPDATE memory_jobs SET status=?,error_code=? WHERE operation_id=?",
    )
    .run(status, code, job.operation_id);
  app.db
    .prepare(
      "UPDATE memory_candidates SET state=? WHERE candidate_id=? AND current_revision=? AND state IN ('APPROVED','PUBLISHING')",
    )
    .run(status, job.candidate_id, job.revision);
}
function terminal(app: AppDatabase, job: Job, error: unknown): void {
  const code = (error as { code?: string })?.code ?? "PUBLICATION_FAILURE";
  const conflict = [
    "PUBLICATION_CONFLICT",
    "PUBLICATION_BINDING_MISMATCH",
    "NOTE_CHANGED",
    "UNSAFE_NOTE",
    "UNSAFE_VAULT_PATH",
    "ELOOP",
    "EEXIST",
  ].includes(code);
  app.transaction(() => {
    if (
      app.db
        .prepare(
          "SELECT 1 FROM memory_jobs WHERE operation_id=? AND status IN ('PENDING','PUBLISHING')",
        )
        .get(job.operation_id)
    )
      setStatus(app, job, conflict ? "CONFLICT" : "FAILED", code);
  }, "memory_publication_failure");
}
/** At most one bounded note per turn. Each SQLite writer verifies current grants before touching the editable file. */
export function publishNext(
  app: AppDatabase,
  policy: AuthorizationPort,
  hooks: Hooks = {},
): boolean {
  if (!active(app)) return false;
  const job = app.db
    .prepare(
      `SELECT * FROM memory_jobs WHERE status IN ('PENDING','PUBLISHING')
    ORDER BY created_at,operation_id LIMIT 1`,
    )
    .get() as Job | undefined;
  if (!job) return false;
  hooks.afterSelection?.();
  try {
    const prepared = app.transaction(() => {
      if (!active(app)) return false;
      const current = app.db
        .prepare("SELECT status FROM memory_jobs WHERE operation_id=?")
        .get(job.operation_id);
      if (!["PUBLISHING", "PENDING"].includes(String(current?.status)))
        return false;
      assertPublishable(app, policy, job);
      assertPublicationCapacity(app, job.operation_id);
      if (saveVersion(app, Buffer.from(job.markdown)) !== job.file_digest)
        throw new AppError("PUBLICATION_BINDING_MISMATCH", 409);
      if (current?.status === "PENDING") {
        prepareFrozen(app, job);
        app.db
          .prepare("UPDATE memory_jobs SET prepared=1 WHERE operation_id=?")
          .run(job.operation_id);
      }
      setStatus(app, job, "PUBLISHING");
      return true;
    }, "memory_prepare");
    if (!prepared) return false;
    hooks.afterPrepared?.();
    app.transaction(() => {
      if (
        !active(app) ||
        app.db
          .prepare("SELECT status FROM memory_jobs WHERE operation_id=?")
          .get(job.operation_id)?.status !== "PUBLISHING"
      )
        return;
      assertPublishable(app, policy, job);
      assertPublicationCapacity(app, job.operation_id);
      publishFrozen(app, job, hooks);
      hooks.beforeReceipt?.();
      const bytes = readVaultFile(app, job.relative_path);
      if (digest(bytes) !== job.file_digest)
        throw new AppError("PUBLICATION_CONFLICT", 409);
      assertPublishable(app, policy, job);
      const bodyDigest = digest(parseMemoryMarkdown(bytes).body);
      const now = Date.now();
      app.db
        .prepare(
          `INSERT INTO memory_documents(note_id,workspace_id,room_id,owner_persona_id,scope,candidate_id,state,relative_path,version,digest,body_digest,trusted)
        SELECT ?,?,?,?,?,?,'PUBLISHED',?,1,?,?,trust_new FROM memory_vault WHERE singleton=1`,
        )
        .run(
          job.note_id,
          job.workspace_id,
          job.room_id,
          job.owner_persona_id,
          job.scope,
          job.candidate_id,
          job.relative_path,
          job.file_digest,
          bodyDigest,
        );
      app.db
        .prepare(
          "INSERT INTO memory_versions(note_id,version,digest,body_digest,relative_path,created_at) VALUES(?,1,?,?,?,?)",
        )
        .run(job.note_id, job.file_digest, bodyDigest, job.relative_path, now);
      app.db
        .prepare(
          "INSERT INTO memory_receipts(operation_id,note_id,file_digest,created_at) VALUES(?,?,?,?)",
        )
        .run(job.operation_id, job.note_id, job.file_digest, now);
      setStatus(app, job, "PUBLISHED");
    }, "memory_receipt");
    return true;
  } catch (e) {
    const error = e as { code?: string; errcode?: number };
    // node:sqlite reports SQLITE_BUSY/LOCKED in errcode (including extended result codes).
    if (
      !active(app) ||
      error.code === "MAINTENANCE" ||
      [5, 6].includes((error.errcode ?? 0) & 255)
    )
      return false;
    terminal(app, job, e);
    return true;
  }
}
/** Explicit recovery reuses the reviewed operation and frozen bytes. A previously consumed stage is never recreated. */
export function retryPublication(
  app: AppDatabase,
  policy: AuthorizationPort,
  actor: Actor,
  roomId: string,
  candidateId: string,
  input: unknown,
) {
  const data = object(input, ["requestId"]);
  const requestId = string(data.requestId, 128);
  if (!/^[a-zA-Z0-9_-]+$/.test(requestId)) throw new AppError("INVALID_INPUT");
  return app.transaction(() => {
    const job = app.db
      .prepare(
        "SELECT * FROM memory_jobs WHERE workspace_id=? AND room_id=? AND candidate_id=? AND reviewer_id=?",
      )
      .get(actor.workspaceId, roomId, candidateId, actor.actorId) as
      | (Job & { prepared: number })
      | undefined;
    if (!job) throw new AppError("NOT_FOUND", 404);
    const candidateScope = memoryScope(actor, roomId, job.owner_persona_id);
    const destinationScope = memoryScope(
      actor,
      roomId,
      job.owner_persona_id,
      job.scope,
    );
    try {
      policy.assert(actor, "READ_ROOM", { roomId });
      policy.assert(actor, "READ_MEMORY", candidateScope);
      policy.assert(actor, "REVIEW_MEMORY", candidateScope);
      policy.assert(actor, "PUBLISH_MEMORY", destinationScope);
      if (job.scope === "room_shared")
        policy.assert(actor, "CHANGE_MEMORY_SCOPE", destinationScope);
      assertSourceAccess(app, policy, actor, candidateId);
      assertSourcesCurrent(app, policy, actor, candidateId);
    } catch {
      throw new AppError("NOT_FOUND", 404);
    }
    const requestDigest = digest(
      canonical({
        action: "retry",
        roomId,
        candidateId,
        operation: job.operation_id,
      }),
    );
    const prior = app.db
      .prepare(
        "SELECT room_id,request_digest FROM memory_requests WHERE workspace_id=? AND actor_id=? AND request_id=?",
      )
      .get(actor.workspaceId, actor.actorId, requestId);
    if (prior) {
      if (prior.room_id !== roomId || prior.request_digest !== requestDigest)
        throw new AppError("REQUEST_CONFLICT", 409);
      return { state: job.status };
    }
    if (job.status !== "FAILED")
      throw new AppError("PUBLICATION_NOT_FAILED", 409);
    const authorized = app.db
      .prepare(
        "UPDATE memory_candidates SET state='APPROVED' WHERE candidate_id=? AND current_revision=? AND state='FAILED'",
      )
      .run(candidateId, job.revision);
    if (!authorized.changes)
      throw new AppError("PUBLICATION_BINDING_MISMATCH", 409);
    assertPublishable(app, policy, job);
    assertPublicationCapacity(app, job.operation_id);
    const status = job.prepared ? "PUBLISHING" : "PENDING";
    app.db
      .prepare(
        "UPDATE memory_jobs SET status=?,error_code=NULL WHERE operation_id=?",
      )
      .run(status, job.operation_id);
    app.db
      .prepare("INSERT INTO memory_requests VALUES(?,?,?,?,?,?,?)")
      .run(
        actor.workspaceId,
        actor.actorId,
        roomId,
        requestId,
        requestDigest,
        JSON.stringify([candidateId]),
        Date.now(),
      );
    return { state: status };
  }, "memory_publication_retry");
}
export function startPublicationWorker(
  app: AppDatabase,
  policy: AuthorizationPort,
): () => void {
  const timer = setInterval(() => {
    try {
      publishNext(app, policy);
    } catch {
      /* The fixed poll interval retries unavailable storage without dispatching a Provider. */
    }
  }, 500);
  timer.unref();
  return () => clearInterval(timer);
}
