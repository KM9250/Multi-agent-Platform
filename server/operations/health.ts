import { existsSync, statSync, statfsSync } from "node:fs";
import type { AppDatabase } from "../app-data/db.ts";
import { AppError } from "../../shared/app-contracts/index.ts";

/** Host diagnostics only. No filenames, identities, message text or credentials. */
export function inspectDataHealth(
  app: AppDatabase,
  options: { warningBytes?: number; retentionMode?: "manual" } = {},
) {
  const warningBytes = options.warningBytes ?? 5 * 1024 ** 3;
  if (
    !Number.isSafeInteger(warningBytes) ||
    warningBytes <= 0 ||
    (options.retentionMode && options.retentionMode !== "manual")
  )
    throw new AppError("INVALID_CONFIGURATION");
  const databaseBytes = [app.path, `${app.path}-wal`, `${app.path}-shm`].reduce(
    (sum, path) => sum + (existsSync(path) ? statSync(path).size : 0),
    0,
  );
  const attachmentBytes = Number(
    app.db.prepare("SELECT COALESCE(SUM(size),0) AS n FROM attachments").get()!
      .n,
  );
  const space = statfsSync(app.root),
    freeBytes = space.bavail * space.bsize;
  const pendingGenerations = Number(
    app.db
      .prepare(
        "SELECT count(*) AS n FROM app_generation_runs WHERE state IN ('QUEUED','RUNNING')",
      )
      .get()!.n,
  );
  const unknownGenerations = Number(
    app.db
      .prepare(
        "SELECT count(*) AS n FROM app_generation_runs WHERE state='NEEDS_REVIEW'",
      )
      .get()!.n,
  );
  const incompleteImports = Number(
    app.db
      .prepare(
        "SELECT count(*) AS n FROM import_batches WHERE status<>'COMPLETE'",
      )
      .get()!.n,
  );
  return {
    schema: "MAP-DATA-1:HEALTH:1",
    retentionMode: "manual",
    automaticDeletion: false,
    databaseBytes,
    attachmentBytes,
    measuredBytes: databaseBytes + attachmentBytes,
    warningBytes,
    freeBytes,
    capacityWarning:
      databaseBytes + attachmentBytes >= warningBytes ||
      freeBytes < 256 * 1024 ** 2,
    capacityScope:
      "Database sidecars and registered attachment bytes; host must separately monitor exports, backups and orphan files",
    pendingGenerations,
    unknownGenerations,
    incompleteImports,
    ...(typeof (app as any).metrics === "function"
      ? { database: (app as any).metrics() }
      : {}),
  };
}
