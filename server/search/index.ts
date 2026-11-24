import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { AppError } from "../../shared/app-contracts/index.ts";
import { type AppDatabase, assertSafePath } from "../app-data/db.ts";
import type { Actor, AuthorizationPolicy } from "../auth/authorization.ts";
import {
  assertAvailable,
  errorCode,
  failJob,
  generationPath,
  hash,
  indexDirectory,
  inRegistryTransaction,
  openRegistry,
  protectDatabase,
  type IndexBinding,
  type IndexJob,
} from "./index-registry.ts";

export const INDEX_WORKER_LIMITS = Object.freeze({
  concurrent: 1,
  queued: 4,
  deadlineMs: 30 * 60_000,
  refreshIntervalMs: 5_000,
});
const makeBinding = (actor: Actor, roomId: string): IndexBinding => ({
  workspaceId: actor.workspaceId,
  actorId: actor.actorId,
  roomId,
});
export type ActiveIndex =
  | {
      state: "ACTIVE";
      path: string;
      generationId: string;
      manifest: Record<string, any>;
      syncedAt: number;
      updating: boolean;
      reason?: string;
    }
  | {
      state: "UNBUILT" | "BUILDING" | "RESYNC_REQUIRED" | "STOPPED" | "FAILED";
      reason?: string;
    };

export function acquireActiveIndex(
  app: AppDatabase,
  policy: AuthorizationPolicy,
  actor: Actor,
  roomId: string,
): ActiveIndex {
  const acl = assertAvailable(app, policy, actor, roomId);
  const binding = makeBinding(actor, roomId);
  try {
    const dir = indexDirectory(app.root, binding);
    const db = openRegistry(dir);
    if (!db) return { state: "UNBUILT" };
    try {
      if (db.prepare("SELECT paused FROM control").get()?.paused)
        return { state: "STOPPED" };
      const latest = db
        .prepare(
          "SELECT state,reason FROM jobs ORDER BY created DESC,rowid DESC LIMIT 1",
        )
        .get();
      const active = db
        .prepare(
          "SELECT id,manifest,synced FROM generations WHERE state='ACTIVE'",
        )
        .get();
      const updating =
        latest?.state === "QUEUED" || latest?.state === "RUNNING";
      const failed =
        latest?.state === "FAILED" || latest?.state === "INTERRUPTED";
      if (!active) {
        if (updating) return { state: "BUILDING" };
        if (
          db
            .prepare(
              "SELECT 1 FROM generations WHERE state='INVALIDATED' LIMIT 1",
            )
            .get()
        )
          return { state: "RESYNC_REQUIRED" };
        return failed
          ? { state: "FAILED", reason: String(latest.reason) }
          : { state: "UNBUILT" };
      }
      const manifest = JSON.parse(String(active.manifest));
      const generationId = String(active.id);
      if (
        manifest.acl !== acl ||
        manifest.epoch !== hash(app.cursorKey) ||
        JSON.stringify(manifest.binding) !== JSON.stringify(binding)
      )
        return { state: "RESYNC_REQUIRED" };
      const path = generationPath(dir, generationId);
      protectDatabase(path);
      if (!existsSync(path))
        return { state: "UNBUILT", reason: "SEARCH_FILE_MISSING" };
      if (
        !manifest.validated ||
        manifest.generationId !== generationId ||
        !lstatSync(path).size
      )
        return { state: "FAILED", reason: "SEARCH_GENERATION_INVALID" };
      return {
        state: "ACTIVE",
        path,
        generationId,
        manifest,
        syncedAt: Number(active.synced),
        updating,
        ...(failed ? { reason: String(latest.reason) } : {}),
      };
    } finally {
      db.close();
    }
  } catch (error) {
    return { state: "FAILED", reason: errorCode(error) };
  }
}

interface Task {
  job: IndexJob;
  dir: string;
  controller: AbortController;
  promise: Promise<string>;
  resolve: (id: string) => void;
  reject: (reason: unknown) => void;
  waitStart: number;
}
const pending = new Map<string, Task>();
const queue: Task[] = [];
let running = 0;
const metrics = {
  started: 0,
  completed: 0,
  failed: 0,
  cancelled: 0,
  maxConcurrent: 0,
  waitMs: 0,
};
export const indexWorkerStatus = () => ({
  ...metrics,
  running,
  queued: queue.length,
  limits: INDEX_WORKER_LIMITS,
});

async function execute(task: Task) {
  const { job, controller } = task;
  const worker = new Worker(new URL("./index-worker.ts", import.meta.url), {
    workerData: { type: "search-index", job },
    resourceLimits: { maxOldGenerationSizeMb: 384 },
  });
  let hardStop: ReturnType<typeof setTimeout>;
  const abort = () => {
    worker.postMessage("cancel");
    // Also interrupts synchronous CPU/SQLite work that cannot receive the cooperative message.
    hardStop = setTimeout(() => {
      void worker.terminate();
    }, 250);
  };
  controller.signal.addEventListener("abort", abort, { once: true });
  if (controller.signal.aborted) abort();
  try {
    return await new Promise<string>((resolve, reject) => {
      let result: { generationId?: string; error?: string } = {};
      worker.on("message", (message) => {
        result = message;
      });
      worker.once("error", (error) => {
        result = { error: errorCode(error) };
      });
      worker.once("exit", (code) => {
        if (controller.signal.aborted) reject(controller.signal.reason);
        else if (code || !result.generationId)
          reject(new AppError(result.error ?? "SEARCH_WORKER_STOPPED", 503));
        else resolve(result.generationId);
      });
    });
  } finally {
    controller.signal.removeEventListener("abort", abort);
    clearTimeout(hardStop);
  }
}

function settleFailure(task: Task, error: unknown) {
  const cancelled = task.controller.signal.aborted;
  if (cancelled) metrics.cancelled++;
  else metrics.failed++;
  // A hard worker termination may skip its finally block. The durable pointer accepts ACTIVE only.
  try {
    const db = openRegistry(task.dir, true)!;
    try {
      failJob(db, task.job.jobId, errorCode(error), cancelled);
    } finally {
      db.close();
    }
  } catch {
    /* The derived store itself may be inaccessible. Never write an App DB recovery marker. */
  }
  task.reject(error);
}

function drain() {
  if (running >= INDEX_WORKER_LIMITS.concurrent) return;
  const task = queue.shift();
  if (!task) return;
  if (task.controller.signal.aborted) {
    settleFailure(task, task.controller.signal.reason);
    pending.delete(task.dir);
    drain();
    return;
  }
  running++;
  metrics.started++;
  metrics.maxConcurrent = Math.max(running, metrics.maxConcurrent);
  metrics.waitMs += Date.now() - task.waitStart;
  const finish = () => {
    running--;
    pending.delete(task.dir);
  };
  void execute(task).then(
    (id) => {
      finish();
      metrics.completed++;
      task.resolve(id);
      drain();
    },
    (error) => {
      finish();
      settleFailure(task, error);
      drain();
    },
  );
}

interface UpdateOptions {
  rebuild?: boolean;
  external?: boolean;
  rollback?: string;
  signal?: AbortSignal;
  force?: boolean;
}
export async function requestIndexUpdate(
  app: AppDatabase,
  policy: AuthorizationPolicy,
  actor: Actor,
  roomId: string,
  options: UpdateOptions = {},
): Promise<string> {
  assertAvailable(app, policy, actor, roomId);
  options.signal?.throwIfAborted();
  const binding = makeBinding(actor, roomId);
  const dir = indexDirectory(app.root, binding, true);
  const existing = pending.get(dir);
  if (existing) {
    if (
      (options.rebuild && !existing.job.rebuild) ||
      (options.external && !existing.job.external) ||
      (options.rollback && existing.job.rollback !== options.rollback)
    )
      throw new AppError("SEARCH_JOB_IN_PROGRESS", 409);
    return existing.promise;
  }
  if (queue.length >= INDEX_WORKER_LIMITS.queued)
    throw new AppError("SEARCH_QUEUE_FULL", 503);
  const active = acquireActiveIndex(app, policy, actor, roomId);
  if (active.state === "STOPPED") throw new AppError("SEARCH_STOPPED", 409);
  if (
    !options.force &&
    !options.rebuild &&
    !options.rollback &&
    !options.external &&
    active.state === "ACTIVE" &&
    !active.reason &&
    Date.now() - active.syncedAt < INDEX_WORKER_LIMITS.refreshIntervalMs
  )
    return active.generationId;
  const job: IndexJob = {
    root: app.root,
    appPath: app.path,
    binding,
    jobId: randomUUID(),
    rebuild:
      options.rebuild === true ||
      active.state === "FAILED" ||
      Boolean(active.reason),
    external: options.external === true,
    ...(options.rollback ? { rollback: options.rollback } : {}),
  };
  const db = openRegistry(dir, true)!;
  try {
    inRegistryTransaction(db, () => {
      // No running task for this partition and the caller holds the host lock. Leftover jobs are abandoned.
      db.exec(`UPDATE generations SET state='INTERRUPTED',reason='SEARCH_HOST_RESTART'
        WHERE state IN ('BUILDING','VALIDATING','READY');
        UPDATE jobs SET state='INTERRUPTED',reason='SEARCH_HOST_RESTART' WHERE state IN ('QUEUED','RUNNING');
        DELETE FROM jobs WHERE id IN (SELECT id FROM jobs ORDER BY created DESC,rowid DESC LIMIT -1 OFFSET 32)`);
      db.prepare(
        "INSERT INTO jobs(id,requester,state,created) VALUES(?,?,'QUEUED',?)",
      ).run(job.jobId, JSON.stringify(binding), Date.now());
    });
  } finally {
    db.close();
  }
  const controller = new AbortController();
  const abort = () =>
    controller.abort(new AppError("SEARCH_JOB_CANCELLED", 503));
  options.signal?.addEventListener("abort", abort, { once: true });
  let resolve: (id: string) => void, reject: (error: unknown) => void;
  const promise = new Promise<string>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const task = {
    job,
    dir,
    controller,
    promise,
    resolve,
    reject,
    waitStart: Date.now(),
  };
  const cancelQueued = () => {
    const position = queue.indexOf(task);
    if (position < 0) return;
    queue.splice(position, 1);
    pending.delete(dir);
    settleFailure(task, controller.signal.reason);
  };
  controller.signal.addEventListener("abort", cancelQueued, { once: true });
  const deadline = setTimeout(
    () => controller.abort(new AppError("SEARCH_INDEX_DEADLINE", 503)),
    INDEX_WORKER_LIMITS.deadlineMs,
  );
  pending.set(dir, task);
  queue.push(task);
  drain();
  try {
    return await promise;
  } finally {
    clearTimeout(deadline);
    controller.signal.removeEventListener("abort", cancelQueued);
    options.signal?.removeEventListener("abort", abort);
  }
}

export async function shutdownIndexWorkers(app: AppDatabase) {
  const tasks = [...pending.values()].filter(
    (task) => task.job.root === app.root,
  );
  for (const task of tasks)
    task.controller.abort(new AppError("SEARCH_JOB_CANCELLED", 503));
  await Promise.allSettled(tasks.map((task) => task.promise));
}

/** Host CLI only. Call under the exclusive host lock. */
export function manageIndex(
  app: AppDatabase,
  binding: IndexBinding,
  command: "status" | "stop" | "resume" | "delete",
) {
  const dir = indexDirectory(
    app.root,
    binding,
    command === "stop" || command === "resume",
  );
  if (pending.has(dir)) throw new AppError("SEARCH_JOB_IN_PROGRESS", 409);
  if (command === "delete") {
    if (existsSync(dir)) {
      const files = readdirSync(dir);
      for (const name of files) {
        if (
          !/^(generations|[a-f0-9-]{36})\.sqlite(?:-(?:wal|shm|journal))?$/.test(
            name,
          )
        )
          throw new AppError("SEARCH_UNEXPECTED_FILE", 409);
        assertSafePath(join(dir, name), "file");
      }
      for (const name of files) unlinkSync(join(dir, name));
      rmdirSync(dir);
    }
    return { deleted: true };
  }
  const db = openRegistry(dir, command !== "status");
  if (!db) return { state: "UNBUILT" };
  try {
    if (command !== "status") {
      db.prepare("UPDATE control SET paused=?").run(command === "stop" ? 1 : 0);
      return { paused: command === "stop" };
    }
    return {
      paused: db.prepare("SELECT paused FROM control").get()?.paused === 1,
      generations: db
        .prepare(
          "SELECT id,state,created,synced,reason,manifest FROM generations ORDER BY created DESC LIMIT 64",
        )
        .all()
        .map((g) => ({
          id: g.id,
          state: g.state,
          created: g.created,
          synced: g.synced,
          reason: g.reason,
          manifest: JSON.parse(String(g.manifest)),
        })),
      jobs: db
        .prepare(
          "SELECT id,state,created,finished,reason FROM jobs ORDER BY created DESC LIMIT 32",
        )
        .all(),
      workers: indexWorkerStatus(),
    };
  } finally {
    db.close();
  }
}
