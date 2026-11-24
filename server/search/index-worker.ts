import { randomUUID } from "node:crypto";
import { setImmediate as yieldToWorker } from "node:timers/promises";
import { closeSync, existsSync, openSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import type { DatabaseSync } from "node:sqlite";
import {
  APP_CONTRACT,
  MEMORY_CONTRACT,
  SEARCH_CONTRACT,
  AppError,
} from "../../shared/app-contracts/index.ts";
import { AppDatabase } from "../app-data/db.ts";
import { AuthorizationPolicy } from "../auth/authorization.ts";
import { SQLiteSearchBackend, BACKEND_CONTRACT } from "./backend.ts";
import { ANALYZER_VERSION, NORMALIZER_VERSION } from "./lexical.ts";
import { CHUNKER_VERSION, CHUNK_LENGTH, CHUNK_OVERLAP } from "./chunk.ts";
import { SearchSources } from "./sources.ts";
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
  type IndexJob,
} from "./index-registry.ts";

type Stage = "PAGE_READ" | "PAGE_COMMITTED" | "VALIDATING" | "READY" | "ACTIVE";

function changeState(db: DatabaseSync, id: string, from: string, to: string) {
  if (
    !db
      .prepare("UPDATE generations SET state=? WHERE id=? AND state=?")
      .run(to, id, from).changes
  )
    throw new AppError("SEARCH_GENERATION_CHANGED", 409);
}

/** A worker owns exactly one partition job. The caller retains the host lock until worker exit. */
export async function updateGeneration(
  app: AppDatabase,
  job: IndexJob,
  signal: AbortSignal,
  observe?: (stage: Stage) => void,
) {
  const { binding, jobId } = job;
  const actor = { workspaceId: binding.workspaceId, actorId: binding.actorId };
  const policy = new AuthorizationPolicy(app);
  const acl = assertAvailable(app, policy, actor, binding.roomId);
  const dir = indexDirectory(app.root, binding);
  const reg = openRegistry(dir, true)!;
  let backend: SQLiteSearchBackend | undefined;
  try {
    if (
      reg.prepare("SELECT requester,state FROM jobs WHERE id=?").get(jobId)
        ?.requester !== JSON.stringify(binding)
    )
      throw new AppError("SEARCH_JOB_BINDING_MISMATCH");
    const config = {
      backend: "sqlite-fts5",
      backendContract: BACKEND_CONTRACT,
      searchContract: SEARCH_CONTRACT,
      sourceContracts: { archive: APP_CONTRACT, memory: MEMORY_CONTRACT },
      normalizer: NORMALIZER_VERSION,
      analyzer: ANALYZER_VERSION,
      chunker: CHUNKER_VERSION,
      chunkLength: CHUNK_LENGTH,
      overlap: CHUNK_OVERLAP,
      targets: ["current-memory", "current-and-historical-archive"],
    };
    const configDigest = hash(JSON.stringify(config));
    const epoch = hash(app.cursorKey);
    const base = { ...config, configDigest, binding, acl, epoch };
    const check = () => {
      signal.throwIfAborted();
      if (reg.prepare("SELECT paused FROM control").get()?.paused)
        throw new AppError("SEARCH_STOPPED", 409);
      if (assertAvailable(app, policy, actor, binding.roomId) !== acl)
        throw new AppError("SEARCH_RESYNC_REQUIRED", 409);
    };
    check();
    const active = reg
      .prepare("SELECT id,manifest FROM generations WHERE state='ACTIVE'")
      .get();
    const chosen = job.rollback
      ? reg
          .prepare(
            "SELECT id,manifest FROM generations WHERE state='RETIRED' AND id=?",
          )
          .get(job.rollback)
      : active;
    if (job.rollback && !chosen)
      throw new AppError("SEARCH_GENERATION_UNAVAILABLE", 409);
    const old = chosen ? JSON.parse(String(chosen.manifest)) : null;
    const reusable =
      old?.acl === acl &&
      old.epoch === epoch &&
      old.configDigest === configDigest &&
      JSON.stringify(old.binding) === JSON.stringify(binding) &&
      existsSync(generationPath(dir, String(chosen!.id)));
    if (job.rollback && !reusable)
      throw new AppError("SEARCH_ROLLBACK_INCOMPATIBLE", 409);
    const create = !job.rollback && (job.rebuild || !reusable);
    const generationId = create ? randomUUID() : String(chosen!.id);
    const path = generationPath(dir, generationId);
    protectDatabase(path);
    inRegistryTransaction(reg, () => {
      const changed = reg
        .prepare(
          "UPDATE jobs SET state='RUNNING',generation=? WHERE id=? AND state='QUEUED'",
        )
        .run(generationId, jobId);
      if (!changed.changes) throw new AppError("SEARCH_JOB_INTERRUPTED", 409);
      if (create) {
        reg
          .prepare(
            "INSERT INTO generations(id,state,manifest,created) VALUES(?,'BUILDING',?,?)",
          )
          .run(
            generationId,
            JSON.stringify({ ...base, generationId }),
            Date.now(),
          );
      }
      if (job.rollback) changeState(reg, generationId, "RETIRED", "BUILDING");
    });
    if (create) closeSync(openSync(path, "wx", 0o600));
    backend = new SQLiteSearchBackend(path, { create });
    const sources = new SearchSources(app, policy, actor, binding.roomId);
    let memoryChanged = false;
    const refresh = async (stream: "memory" | "archive") => {
      let more: boolean;
      do {
        check();
        const after = backend!.getCursor(stream);
        const page =
          stream === "memory"
            ? sources.memoryPage(after ?? undefined)
            : sources.archivePage(after ?? undefined);
        check();
        observe?.("PAGE_READ");
        backend!.applyPage({
          upserts: page.upserts,
          deletes: page.deletes.map((id) => ({ target: stream, id })),
          cursor: { stream, value: page.cursor },
          expectedCursor: after,
        });
        if (stream === "memory" && (page.upserts.length || page.deletes.length))
          memoryChanged = true;
        observe?.("PAGE_COMMITTED");
        more = page.hasMore;
        await yieldToWorker();
      } while (more);
    };
    await refresh("memory");
    await refresh("archive");
    const switching = create || Boolean(job.rollback);
    if (switching) {
      changeState(reg, generationId, "BUILDING", "VALIDATING");
      observe?.("VALIDATING");
      // Baseline pages and deltas have immutable cutoffs. Catch up after both baselines.
      await refresh("memory");
      await refresh("archive");
    }
    if (switching) backend.validate();
    check();
    const manifest = {
      ...base,
      generationId,
      validated: true,
      coverage: backend.coverage(),
      positions: {
        memory: backend.getCursor("memory"),
        archive: backend.getCursor("archive"),
      },
    };
    if (switching) {
      changeState(reg, generationId, "VALIDATING", "READY");
      observe?.("READY");
    }
    check();
    inRegistryTransaction(reg, () => {
      if (switching) {
        reg.exec("UPDATE generations SET state='RETIRED' WHERE state='ACTIVE'");
        changeState(reg, generationId, "READY", "ACTIVE");
      }
      reg
        .prepare(
          "UPDATE generations SET manifest=?,synced=?,reason=NULL WHERE id=?",
        )
        .run(JSON.stringify(manifest), Date.now(), generationId);
      reg
        .prepare("UPDATE jobs SET state='SUCCEEDED',finished=? WHERE id=?")
        .run(Date.now(), jobId);
    });
    observe?.("ACTIVE");
    return generationId;
  } catch (error) {
    const code = errorCode(error);
    const status = (error as { status?: number })?.status;
    if (
      status === 401 ||
      status === 403 ||
      ["MEMORY_RESYNC_REQUIRED", "SEARCH_RESYNC_REQUIRED"].includes(code)
    ) {
      // Poison the old cursor even if a later reader would again be allowed through a different grant.
      reg
        .prepare(
          "UPDATE generations SET state='INVALIDATED',reason=? WHERE state='ACTIVE'",
        )
        .run(code);
    }
    failJob(reg, jobId, code, signal.aborted);
    throw error;
  } finally {
    backend?.close();
    reg.close();
  }
}

if (parentPort && workerData?.type === "search-index") {
  const port = parentPort,
    controller = new AbortController();
  port.on("message", () => controller.abort());
  const job = workerData.job as IndexJob;
  let app: AppDatabase | undefined;
  try {
    if (!existsSync(job.appPath))
      throw new AppError("SEARCH_SOURCE_UNAVAILABLE");
    app = new AppDatabase({ root: job.root, path: job.appPath });
    const generationId = await updateGeneration(app, job, controller.signal);
    port.postMessage({ generationId });
  } catch (error) {
    port.postMessage({ error: errorCode(error) });
  } finally {
    app?.close();
    port.close();
  }
}
