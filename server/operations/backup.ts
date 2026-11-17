import {
  constants,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { copyFile, open, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { AppDatabase, assertSafePath } from "../app-data/db.ts";
import { canonical } from "../app-data/validation.ts";
import { APP_CONTRACT } from "../../shared/app-contracts/index.ts";
import { hash, json, OperationError } from "./legacy.ts";
import { acquireHostLock } from "./locks.ts";

type Row = Record<string, any>;
type BackupAttachment = {
  workspaceId: string;
  roomId: string;
  id: string;
  blobKey: string;
  digest: string;
  size: number;
  state: string;
};
export type BackupManifest = {
  schema: "MAP-DATA-1:BACKUP:1";
  contract: string;
  appSchema: 1;
  createdAt: number;
  database: { file: "app-data.sqlite"; digest: string; size: number };
  attachments: BackupAttachment[];
  referencesDigest: string;
  deletionsDigest: string;
  importsDigest: string;
  counts: Record<string, number>;
  integrity: "ok";
  restoreTested: false;
};
const pause = () => new Promise<void>((resolve) => setImmediate(resolve));
function safeEmptyRoot(path: string): string {
  if (!isAbsolute(path))
    throw new OperationError("ABSOLUTE_DESTINATION_REQUIRED");
  const root = resolve(path);
  assertSafePath(root, "directory");
  if (existsSync(root) && readdirSync(root).length)
    throw new OperationError("DESTINATION_NOT_EMPTY", 409);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32" && lstatSync(root).mode & 0o077)
    throw new OperationError("DESTINATION_NOT_PRIVATE");
  return root;
}
async function fileDigest(
  path: string,
): Promise<{ digest: string; size: number }> {
  assertSafePath(path, "file");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1)
      throw new OperationError("UNSAFE_BACKUP_FILE");
    const digest = createHash("sha256");
    let size = 0;
    const buffer = Buffer.alloc(256 * 1024);
    while (true) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      digest.update(buffer.subarray(0, bytesRead));
      size += bytesRead;
      await pause();
    }
    const after = await file.stat();
    if (
      size !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    )
      throw new OperationError("BACKUP_SOURCE_CHANGED", 409);
    return { digest: digest.digest("hex"), size };
  } finally {
    await file.close();
  }
}
async function safeCopy(
  source: string,
  destination: string,
): Promise<{ digest: string; size: number }> {
  assertSafePath(source, "file");
  assertSafePath(destination, "file");
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let output;
  try {
    const before = await input.stat();
    if (!before.isFile() || before.nlink !== 1)
      throw new OperationError("UNSAFE_BACKUP_FILE");
    output = await open(
      destination,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    const digest = createHash("sha256"),
      buffer = Buffer.alloc(256 * 1024);
    let size = 0;
    while (true) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      const chunk = buffer.subarray(0, bytesRead);
      digest.update(chunk);
      await output.writeFile(chunk);
      size += bytesRead;
      await pause();
    }
    await output.sync();
    const after = await input.stat();
    if (
      size !== before.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.size !== after.size
    )
      throw new OperationError("BACKUP_SOURCE_CHANGED", 409);
    return { digest: digest.digest("hex"), size };
  } finally {
    await input.close();
    await output?.close();
  }
}
function integrity(db: DatabaseSync): void {
  const result = db.prepare("PRAGMA integrity_check").all();
  if (
    result.length !== 1 ||
    Object.values(result[0])[0] !== "ok" ||
    db.prepare("PRAGMA foreign_key_check").all().length
  )
    throw new OperationError("BACKUP_INTEGRITY_FAILED", 409);
  const metadata = db
    .prepare(
      "SELECT contract,schema_version FROM app_metadata WHERE singleton=1",
    )
    .get();
  if (metadata?.contract !== APP_CONTRACT || metadata.schema_version !== 1)
    throw new OperationError("BACKUP_SCHEMA_INVALID", 409);
  const migrations = db
    .prepare("SELECT version,name FROM app_migrations ORDER BY version")
    .all();
  if (
    migrations.length !== 1 ||
    migrations[0].version !== 1 ||
    migrations[0].name !== "app_001_conversation_persistence"
  )
    throw new OperationError("BACKUP_SCHEMA_INVALID", 409);
}
async function semanticIntegrity(db: DatabaseSync): Promise<void> {
  let checked = 0;
  for (const segment of db
    .prepare("SELECT content,digest FROM message_segments")
    .iterate()) {
    if (hash(String(segment.content)) !== segment.digest)
      throw new OperationError("BACKUP_CONTENT_DIGEST_MISMATCH", 409);
    if (++checked % 256 === 0) await pause();
  }
  for (const persona of db
    .prepare("SELECT config_json,digest FROM persona_revisions")
    .iterate()) {
    if (hash(String(persona.config_json)) !== persona.digest)
      throw new OperationError("BACKUP_CONTENT_DIGEST_MISMATCH", 409);
    try {
      canonical(JSON.parse(String(persona.config_json)));
    } catch {
      throw new OperationError("BACKUP_CONTENT_DIGEST_MISMATCH", 409);
    }
    if (++checked % 256 === 0) await pause();
  }
  const segments = db.prepare(
    "SELECT channel,visibility,content FROM message_segments WHERE workspace_id=? AND room_id=? AND message_id=? AND revision=? ORDER BY rowid",
  );
  for (const revision of db
    .prepare(
      "SELECT workspace_id,room_id,message_id,revision,content_digest FROM message_revisions",
    )
    .iterate()) {
    const body = segments.all(
      revision.workspace_id,
      revision.room_id,
      revision.message_id,
      revision.revision,
    );
    if (hash(canonical(body)) !== revision.content_digest)
      throw new OperationError("BACKUP_CONTENT_DIGEST_MISMATCH", 409);
    if (++checked % 64 === 0) await pause();
  }
  for (const source of db
    .prepare("SELECT original_content,source_digest FROM import_source_records")
    .iterate()) {
    if (hash(String(source.original_content)) !== source.source_digest)
      throw new OperationError("BACKUP_CONTENT_DIGEST_MISMATCH", 409);
    if (++checked % 256 === 0) await pause();
  }
}
async function readProtectedJson(path: string): Promise<any> {
  assertSafePath(path, "file");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024)
      throw new OperationError("BACKUP_MANIFEST_INVALID");
    return JSON.parse(await file.readFile("utf8"));
  } catch (e) {
    if (e instanceof OperationError) throw e;
    throw new OperationError("BACKUP_MANIFEST_INVALID");
  } finally {
    await file.close();
  }
}
async function writeDurableJson(
  path: string,
  value: unknown,
  exclusive = false,
): Promise<void> {
  assertSafePath(path, "file");
  const file = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_NOFOLLOW |
      (exclusive ? constants.O_EXCL : constants.O_TRUNC),
    0o600,
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1)
      throw new OperationError("UNSAFE_BACKUP_FILE");
    await file.writeFile(json(value));
    await file.sync();
  } finally {
    await file.close();
  }
}
const tables = [
  "rooms",
  "personas",
  "persona_revisions",
  "messages",
  "message_revisions",
  "message_segments",
  "attachments",
  "attachment_links",
  "import_batches",
  "import_item_map",
  "import_requests",
  "import_source_records",
  "import_source_registry",
  "persona_attachment_links",
  "import_decisions",
  "import_reactions",
];
async function orderedDigest(db: DatabaseSync, sql: string): Promise<string> {
  const digest = createHash("sha256");
  digest.update("[");
  let count = 0;
  for (const row of db.prepare(sql).iterate()) {
    if (count) digest.update(",");
    digest.update(json(row));
    count++;
    if (count % 256 === 0) await pause();
  }
  digest.update("]");
  return digest.digest("hex");
}
async function describe(db: DatabaseSync) {
  const referencesDigest = await orderedDigest(
    db,
    "SELECT workspace_id,room_id,message_id,revision,revision_id,parent_revision,content_digest FROM message_revisions ORDER BY workspace_id,room_id,message_id,revision",
  );
  const deletionParts = {
    messages: await orderedDigest(
      db,
      "SELECT workspace_id,room_id,message_id,deleted_at FROM messages WHERE deleted_at IS NOT NULL ORDER BY workspace_id,room_id,message_id",
    ),
    personas: await orderedDigest(
      db,
      "SELECT workspace_id,persona_id,deleted_at FROM personas WHERE deleted_at IS NOT NULL ORDER BY workspace_id,persona_id",
    ),
    rooms: await orderedDigest(
      db,
      "SELECT workspace_id,room_id,deleted_at FROM rooms WHERE deleted_at IS NOT NULL ORDER BY workspace_id,room_id",
    ),
    attachments: await orderedDigest(
      db,
      "SELECT workspace_id,room_id,attachment_id,state,deleted_at FROM attachments WHERE deleted_at IS NOT NULL ORDER BY workspace_id,room_id,attachment_id",
    ),
  };
  const importsDigest = await orderedDigest(
    db,
    "SELECT workspace_id,batch_id,status,manifest_digest,reconciliation_json FROM import_batches ORDER BY workspace_id,batch_id",
  );
  const counts = Object.fromEntries(
    tables.map((table) => [
      table,
      Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n),
    ]),
  );
  return {
    referencesDigest,
    deletionsDigest: hash(json(deletionParts)),
    importsDigest,
    counts,
  };
}
function attachmentRows(db: DatabaseSync): BackupAttachment[] {
  return db
    .prepare(
      "SELECT * FROM attachments ORDER BY workspace_id,room_id,attachment_id",
    )
    .all()
    .map((row) => ({
      workspaceId: String(row.workspace_id),
      roomId: String(row.room_id),
      id: String(row.attachment_id),
      blobKey: String(row.blob_key),
      digest: String(row.digest),
      size: Number(row.size),
      state: String(row.state),
    }));
}
function blobPath(root: string, key: string): string {
  if (!/^[a-f0-9-]{36}$/.test(key))
    throw new OperationError("BACKUP_MANIFEST_INVALID");
  return join(root, "attachments", key);
}
function assertDetached(source: string, destination: string): void {
  if (
    destination === source ||
    destination.startsWith(source + sep) ||
    source.startsWith(destination + sep)
  )
    throw new OperationError("BACKUP_DESTINATION_OVERLAP", 409);
}

export class BackupService {
  constructor(readonly app: AppDatabase) {}
  async backup(destination: string): Promise<BackupManifest> {
    const root = resolve(destination);
    assertDetached(this.app.root, root);
    const release = acquireHostLock(this.app.root);
    let maintenance = false;
    try {
      safeEmptyRoot(destination);
      mkdirSync(join(root, "attachments"), { mode: 0o700 });
      this.app.maintenanceTransaction(() => {
        const state = this.app.db
          .prepare(
            "SELECT maintenance,restored FROM app_operational_state WHERE singleton=1",
          )
          .get();
        if (state?.maintenance || state?.restored)
          throw new OperationError("MAINTENANCE_ALREADY_ACTIVE", 409);
        // Queued work is preserved in the snapshot but cannot be restored as dispatch authority.
        const running = this.app.db
          .prepare(
            "SELECT 1 FROM app_generation_runs WHERE state='RUNNING' LIMIT 1",
          )
          .get();
        const dispatched = this.app.db
          .prepare(
            "SELECT 1 FROM app_provider_calls WHERE state='DISPATCH_INTENT' LIMIT 1",
          )
          .get();
        if (running || dispatched)
          throw new OperationError("BACKUP_ACTIVE_GENERATION", 409);
        this.app.db
          .prepare(
            "UPDATE app_operational_state SET maintenance=1 WHERE singleton=1",
          )
          .run();
      }, "backup-maintenance");
      maintenance = true;
      const databasePath = join(root, "app-data.sqlite");
      this.app.db.prepare("VACUUM INTO ?").run(databasePath);
      chmodSync(databasePath, 0o600);
      const snapshot = new DatabaseSync(databasePath, { readOnly: true });
      let manifest: BackupManifest;
      try {
        integrity(snapshot);
        await semanticIntegrity(snapshot);
        const summary = await describe(snapshot),
          attachments = attachmentRows(snapshot);
        for (const attachment of attachments) {
          const actual = await safeCopy(
            blobPath(this.app.root, attachment.blobKey),
            blobPath(root, attachment.blobKey),
          );
          if (
            actual.digest !== attachment.digest ||
            actual.size !== attachment.size
          )
            throw new OperationError("BACKUP_ATTACHMENT_MISMATCH", 409);
        }
        manifest = {
          schema: "MAP-DATA-1:BACKUP:1",
          contract: APP_CONTRACT,
          appSchema: 1,
          createdAt: Date.now(),
          database: {
            file: "app-data.sqlite",
            ...(await fileDigest(databasePath)),
          },
          attachments,
          ...summary,
          integrity: "ok",
          restoreTested: false,
        };
      } finally {
        snapshot.close();
      }
      const path = join(root, "manifest.json");
      const file = await open(path, "wx", 0o600);
      try {
        await file.writeFile(json(manifest));
        await file.sync();
      } finally {
        await file.close();
      }
      const directory = await open(root, constants.O_RDONLY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      return manifest;
    } finally {
      if (maintenance)
        this.app.maintenanceTransaction(() => {
          this.app.db
            .prepare(
              "UPDATE app_operational_state SET maintenance=0 WHERE singleton=1",
            )
            .run();
        }, "backup-release");
      release();
    }
  }
}
async function verifyBackup(source: string): Promise<BackupManifest> {
  assertSafePath(source, "directory");
  const manifestPath = join(source, "manifest.json");
  assertSafePath(manifestPath, "file");
  if (lstatSync(manifestPath).size > 16 * 1024 * 1024)
    throw new OperationError("BACKUP_MANIFEST_INVALID");
  const manifest: BackupManifest = await readProtectedJson(manifestPath);
  if (
    !manifest ||
    manifest.schema !== "MAP-DATA-1:BACKUP:1" ||
    manifest.contract !== APP_CONTRACT ||
    manifest.appSchema !== 1 ||
    manifest.database?.file !== "app-data.sqlite" ||
    !Array.isArray(manifest.attachments)
  )
    throw new OperationError("BACKUP_MANIFEST_INVALID");
  const databasePath = join(source, "app-data.sqlite"),
    actual = await fileDigest(databasePath);
  if (
    actual.digest !== manifest.database.digest ||
    actual.size !== manifest.database.size
  )
    throw new OperationError("BACKUP_DATABASE_MISMATCH", 409);
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    integrity(db);
    await semanticIntegrity(db);
    const summary = await describe(db);
    if (
      summary.referencesDigest !== manifest.referencesDigest ||
      summary.deletionsDigest !== manifest.deletionsDigest ||
      summary.importsDigest !== manifest.importsDigest ||
      json(summary.counts) !== json(manifest.counts) ||
      json(attachmentRows(db)) !== json(manifest.attachments)
    )
      throw new OperationError("BACKUP_MANIFEST_MISMATCH", 409);
  } finally {
    db.close();
  }
  for (const attachment of manifest.attachments) {
    const actual = await fileDigest(blobPath(source, attachment.blobKey));
    if (actual.digest !== attachment.digest || actual.size !== attachment.size)
      throw new OperationError("BACKUP_ATTACHMENT_MISMATCH", 409);
  }
  return manifest;
}
export async function restoreBackup(
  source: string,
  destination: string,
): Promise<BackupManifest> {
  if (!isAbsolute(source) || !isAbsolute(destination))
    throw new OperationError("ABSOLUTE_DESTINATION_REQUIRED");
  source = resolve(source);
  destination = resolve(destination);
  assertDetached(source, destination);
  const manifest = await verifyBackup(source);
  safeEmptyRoot(destination);
  const release = acquireHostLock(destination);
  try {
    // The marker is written before copying anything. A crash during restoration stays fail-closed.
    await writeDurableJson(
      join(destination, "RESTORED_DISABLED"),
      { state: "COPYING", sourceManifestDigest: hash(json(manifest)) },
      true,
    );
    mkdirSync(join(destination, "attachments"), { mode: 0o700 });
    for (const directory of ["staging", "exports", "backups"])
      mkdirSync(join(destination, directory), { mode: 0o700 });
    const copied = await safeCopy(
      join(source, "app-data.sqlite"),
      join(destination, "app-data.sqlite"),
    );
    if (copied.digest !== manifest.database.digest)
      throw new OperationError("BACKUP_DATABASE_MISMATCH", 409);
    for (const attachment of manifest.attachments) {
      const copied = await safeCopy(
        blobPath(source, attachment.blobKey),
        blobPath(destination, attachment.blobKey),
      );
      if (
        copied.digest !== attachment.digest ||
        copied.size !== attachment.size
      )
        throw new OperationError("BACKUP_ATTACHMENT_MISMATCH", 409);
    }
    const app = new AppDatabase({ root: destination });
    try {
      app.maintenanceTransaction(() => {
        app.db.exec("DELETE FROM auth_sessions");
        app.db
          .prepare(
            "UPDATE auth_accounts SET password_hash='RESTORE_RESET_REQUIRED',credential_revision=credential_revision+1",
          )
          .run();
        app.db
          .prepare(
            "UPDATE app_generation_runs SET state='NEEDS_REVIEW',error_code='RESTORED_NO_REPLAY',completed_at=? WHERE state IN ('QUEUED','RUNNING')",
          )
          .run(Date.now());
        app.db
          .prepare(
            "UPDATE app_provider_calls SET state='OUTCOME_UNKNOWN',reason='RESTORED_NO_REPLAY' WHERE state IN ('RESERVED','DISPATCH_INTENT')",
          )
          .run();
        app.db
          .prepare(
            "UPDATE app_operational_state SET maintenance=1,restored=1 WHERE singleton=1",
          )
          .run();
        app.db
          .prepare("UPDATE app_metadata SET cursor_key=? WHERE singleton=1")
          .run(randomBytes(32).toString("hex"));
      }, "restore-disable");
      integrity(app.db);
      await semanticIntegrity(app.db);
      const summary = await describe(app.db);
      if (
        summary.referencesDigest !== manifest.referencesDigest ||
        summary.deletionsDigest !== manifest.deletionsDigest ||
        summary.importsDigest !== manifest.importsDigest
      )
        throw new OperationError("RESTORE_REFERENCE_MISMATCH", 409);
      await writeDurableJson(
        join(destination, "restore-report.json"),
        {
          schema: "MAP-DATA-1:RESTORE:1",
          verifiedAt: Date.now(),
          sourceManifestDigest: hash(json(manifest)),
          referencesDigest: summary.referencesDigest,
          deletionsDigest: summary.deletionsDigest,
          importsDigest: summary.importsDigest,
          counts: summary.counts,
          attachmentsVerified: manifest.attachments.length,
          sessionsInvalidated: true,
          credentialsRequireReset: true,
          workersDisabled: true,
        },
        true,
      );
      await writeDurableJson(join(destination, "RESTORED_DISABLED"), {
        state: "VERIFIED",
        sourceManifestDigest: hash(json(manifest)),
        credentialRevisions: app.db
          .prepare("SELECT actor_id,credential_revision FROM auth_accounts")
          .all(),
      });
      const directory = await open(destination, constants.O_RDONLY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      app.close();
    }
    return manifest;
  } finally {
    release();
  }
}
export async function resumeRestore(root: string): Promise<void> {
  assertSafePath(root, "directory");
  const release = acquireHostLock(root);
  try {
    const marker = join(root, "RESTORED_DISABLED");
    assertSafePath(marker, "file");
    if (!existsSync(marker))
      throw new OperationError("RESTORE_MARKER_MISSING", 409);
    const state = await readProtectedJson(marker);
    if (state.state !== "VERIFIED" || !Array.isArray(state.credentialRevisions))
      throw new OperationError("RESTORE_NOT_VERIFIED", 409);
    const report = await readProtectedJson(join(root, "restore-report.json"));
    const app = new AppDatabase({ root });
    try {
      integrity(app.db);
      await semanticIntegrity(app.db);
      const summary = await describe(app.db);
      if (
        summary.referencesDigest !== report.referencesDigest ||
        summary.deletionsDigest !== report.deletionsDigest ||
        summary.importsDigest !== report.importsDigest
      )
        throw new OperationError("RESTORE_REFERENCE_MISMATCH", 409);
      const account = app.db
        .prepare(
          "SELECT a.actor_id,a.credential_revision FROM auth_accounts a JOIN principals p ON p.actor_id=a.actor_id WHERE p.active=1 AND a.password_hash<>'RESTORE_RESET_REQUIRED'",
        )
        .all()
        .some(
          (row) =>
            Number(row.credential_revision) >
            Number(
              state.credentialRevisions.find(
                (r: any) => r.actor_id === row.actor_id,
              )?.credential_revision ?? 0,
            ),
        );
      if (!account)
        throw new OperationError("RESTORE_CREDENTIAL_RESET_REQUIRED", 409);
      for (const attachment of attachmentRows(app.db)) {
        const actual = await fileDigest(blobPath(root, attachment.blobKey));
        if (
          actual.digest !== attachment.digest ||
          actual.size !== attachment.size
        )
          throw new OperationError("BACKUP_ATTACHMENT_MISMATCH", 409);
      }
      app.maintenanceTransaction(() => {
        app.db
          .prepare(
            "UPDATE app_operational_state SET maintenance=0,restored=0 WHERE singleton=1",
          )
          .run();
      }, "restore-resume");
      await unlink(marker);
      const directory = await open(root, constants.O_RDONLY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      app.close();
    }
  } finally {
    release();
  }
}
