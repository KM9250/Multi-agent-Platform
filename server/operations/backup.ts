import {
  constants,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { open, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  holdDuplicateLineage,
  inventoryForBackup,
} from "../memory/importer.ts";
import { createHash, randomBytes } from "node:crypto";
import {
  AppDatabase,
  assertSafePath,
  identifyAppSchema,
} from "../app-data/db.ts";
import { canonical } from "../app-data/validation.ts";
import {
  APP_CONTRACT,
  MEMORY_CONTRACT,
} from "../../shared/app-contracts/index.ts";
import { hash, json, OperationError } from "./legacy.ts";
import { acquireHostLock } from "./locks.ts";
import {
  MAX_NOTE_BYTES,
  readVaultFile,
  validVaultPath,
} from "../memory/vault.ts";
import { memoryRecordsDigest, summarizeRows } from "./memory-ledger.ts";
import { parseMemoryMarkdown } from "../memory/markdown.ts";

type BackupAttachment = {
  workspaceId: string;
  roomId: string;
  id: string;
  blobKey: string;
  digest: string;
  size: number;
  state: string;
};
type VersionEntry = {
  noteId: string;
  revision: number;
  digest: string;
  bodyDigest: string;
};
type CurrentEntry = {
  noteId: string;
  revision: number;
  digest: string;
  path: string;
};
type Inventory = ReturnType<typeof summarizeRows>;
type MemoryInventory = {
  contract: typeof MEMORY_CONTRACT;
  recordsDigest: string;
  versions: Inventory;
  current: Inventory;
  registered: boolean;
};
type LegacyMemory = Omit<MemoryInventory, "versions" | "current"> & {
  versions: VersionEntry[];
  current: CurrentEntry[];
};
type ManifestHeader = {
  contract: string;
  createdAt: number;
  database: { file: "app-data.sqlite"; digest: string; size: number };
  referencesDigest: string;
  deletionsDigest: string;
  importsDigest: string;
  counts: Record<string, number>;
  integrity: "ok";
  restoreTested: false;
};
type SnapshotManifest = ManifestHeader & {
  schema: "MAP-MEM-1:BACKUP:3";
  appSchema: 2 | 3 | 4;
  attachments: Inventory;
  memory: MemoryInventory;
};
export type BackupManifest =
  | SnapshotManifest
  | (ManifestHeader & { attachments: BackupAttachment[] } & (
        | { schema: "MAP-DATA-1:BACKUP:1"; appSchema: 1 }
        | { schema: "MAP-MEM-1:BACKUP:2"; appSchema: 2; memory: LegacyMemory }
      ));
const pause = () => new Promise<void>((resolve) => setImmediate(resolve));
async function syncDirectory(path: string): Promise<void> {
  const directory = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
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
  maxBytes?: number,
): Promise<{ digest: string; size: number }> {
  assertSafePath(source, "file");
  assertSafePath(destination, "file");
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let output;
  try {
    const before = await input.stat();
    if (!before.isFile() || before.nlink !== 1)
      throw new OperationError("UNSAFE_BACKUP_FILE");
    if (maxBytes !== undefined && before.size > maxBytes)
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
      if (size + bytesRead > before.size)
        throw new OperationError("BACKUP_SOURCE_CHANGED", 409);
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
// Keep large ordered/grouped inventories in SQLite's disk-backed temporary
// store when the available index cannot satisfy a sort.
function openSnapshot(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA temp_store=FILE");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
function integrity(db: DatabaseSync): ReturnType<typeof identifyAppSchema> {
  const result = db.prepare("PRAGMA integrity_check").all();
  if (
    result.length !== 1 ||
    Object.values(result[0])[0] !== "ok" ||
    db.prepare("PRAGMA foreign_key_check").get()
  )
    throw new OperationError("BACKUP_INTEGRITY_FAILED", 409);
  try {
    return identifyAppSchema(db);
  } catch {
    throw new OperationError("BACKUP_SCHEMA_INVALID", 409);
  }
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
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(
        bytes,
        offset,
        bytes.length - offset,
        null,
      );
      if (!bytesRead) throw new OperationError("BACKUP_MANIFEST_INVALID");
      offset += bytesRead;
    }
    if ((await file.stat()).size !== bytes.length)
      throw new OperationError("BACKUP_MANIFEST_INVALID");
    return JSON.parse(bytes.toString("utf8"));
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
function versionPath(root: string, digest: string): string {
  if (!/^[a-f0-9]{64}$/.test(digest))
    throw new OperationError("BACKUP_MEMORY_VERSION_INVALID", 409);
  return join(root, "memory-versions", digest + ".md");
}
// Paths are untrusted even inside a correctly hashed backup. Restore writes
// exclusively into a fresh private tree and never opens the source Vault.
function restoredNotePath(vault: string, relative: string): string {
  if (!validVaultPath(relative) || !relative.toLowerCase().endsWith(".md"))
    throw new OperationError("BACKUP_MEMORY_PATH_INVALID", 409);
  return join(vault, ...relative.split("/"));
}
// The hash-verified app-data.sqlite *is* the indexed inventory. Each query
// has a fixed projection and order; neither side builds a per-revision array.
function versionRows(db: DatabaseSync) {
  return db
    .prepare(
      `SELECT note_id AS noteId,version AS revision,digest,body_digest AS bodyDigest
    FROM memory_versions ORDER BY note_id,version`,
    )
    .iterate() as unknown as Iterable<VersionEntry>;
}
function currentNotes(db: DatabaseSync, byPath = false) {
  const hasWitnesses = db
    .prepare(
      "SELECT 1 FROM sqlite_schema WHERE name='memory_backup_observed_files'",
    )
    .get();
  const observed = hasWitnesses
    ? ` OR EXISTS (SELECT 1 FROM memory_backup_observed_files f
    JOIN memory_lineage_work w ON w.candidate_id=d.candidate_id AND w.status='PENDING'
    WHERE f.note_id=d.note_id AND f.version=d.version AND f.digest=d.digest
      AND f.relative_path=d.relative_path AND d.state IN ('NEEDS_REVIEW','LINEAGE_PENDING'))`
    : "";
  return db
    .prepare(
      `SELECT d.note_id AS noteId,d.version AS revision,d.digest,d.relative_path AS path
    FROM memory_documents d WHERE d.state='PUBLISHED'${observed}
    ORDER BY ${byPath ? "d.relative_path,d.note_id" : "d.note_id"}`,
    )
    .iterate() as unknown as Iterable<CurrentEntry>;
}

// A pending legacy proof needs evidence that the editable file still exists. Record a
// positive observation only in the private outgoing snapshot; do not recreate missing files.
async function observePendingFiles(app: AppDatabase, path: string) {
  const snapshot = new DatabaseSync(path);
  try {
    snapshot.exec(
      "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN IMMEDIATE",
    );
    snapshot.exec("DELETE FROM memory_backup_observed_files");
    const capture = snapshot.prepare(
      "INSERT INTO memory_backup_observed_files VALUES (?,?,?,?)",
    );
    const pending =
      snapshot.prepare(`SELECT d.note_id,d.version,d.digest,d.relative_path
      FROM memory_lineage_work w JOIN memory_documents d USING(candidate_id)
      JOIN memory_receipts r ON r.note_id=d.note_id
      WHERE w.status='PENDING' AND w.mode='LEGACY' AND w.invalidated=0
        AND d.state IN ('LINEAGE_PENDING','NEEDS_REVIEW')`);
    if (!pending.get()) {
      snapshot.exec("COMMIT");
      return;
    }
    let files: Awaited<ReturnType<typeof inventoryForBackup>>;
    try {
      files = await inventoryForBackup(app);
    } catch (error) {
      // Missing or unscannable live Vault: preserve protected history; it cannot attest a held editable copy.
      if (
        !(error instanceof Error && "code" in error) ||
        String(error.code).startsWith("ERR_SQLITE")
      )
        throw error;
      snapshot.exec("COMMIT");
      return;
    }
    holdDuplicateLineage(snapshot, files.ids);
    app.maintenanceTransaction(
      () => holdDuplicateLineage(app.db, files.ids),
      "memory_backup_lineage_conflicts",
    );
    for (const note of pending.iterate()) {
      await pause();
      const paths = files.ids.get(String(note.note_id));
      if (
        paths?.length !== 1 ||
        paths[0] !== note.relative_path ||
        files.current.get(paths[0])?.digest !== note.digest
      )
        continue;
      let bytes: Buffer;
      try {
        bytes = readVaultFile(app, String(note.relative_path));
      } catch {
        continue;
      }
      if (
        hash(bytes) === note.digest &&
        parseMemoryMarkdown(bytes).noteId === note.note_id
      ) {
        capture.run(
          note.note_id,
          note.version,
          note.digest,
          note.relative_path,
        );
      }
    }
    snapshot.exec("COMMIT");
  } finally {
    snapshot.close();
  }
}
async function memorySnapshot(db: DatabaseSync): Promise<MemoryInventory> {
  let inspected = 0;
  for (const r of db
    .prepare(
      "SELECT body,body_digest,sources_json,sources_digest FROM memory_candidate_revisions",
    )
    .iterate()) {
    if (
      hash(String(r.body)) !== r.body_digest ||
      hash(String(r.sources_json)) !== r.sources_digest
    )
      throw new OperationError("BACKUP_CONTENT_DIGEST_MISMATCH", 409);
    if (++inspected % 64 === 0) await pause();
  }
  for (const job of db
    .prepare("SELECT markdown,file_digest FROM memory_jobs")
    .iterate()) {
    if (hash(String(job.markdown)) !== job.file_digest)
      throw new OperationError("BACKUP_CONTENT_DIGEST_MISMATCH", 409);
    if (++inspected % 64 === 0) await pause();
  }
  const mismatch = db
    .prepare(
      `SELECT 1 FROM memory_documents d
    LEFT JOIN memory_versions v ON v.note_id=d.note_id AND v.version=d.version
    WHERE v.note_id IS NULL OR d.digest<>v.digest OR d.body_digest<>v.body_digest LIMIT 1`,
    )
    .get();
  if (mismatch) throw new OperationError("BACKUP_MEMORY_VERSION_INVALID", 409);
  const registered = !!db
    .prepare("SELECT 1 FROM memory_vault WHERE singleton=1")
    .get();
  let lastPath: string | undefined;
  for (const item of currentNotes(db, true)) {
    if (!registered || lastPath === item.path)
      throw new OperationError("BACKUP_MEMORY_VERSION_INVALID", 409);
    restoredNotePath("restored-vault", item.path);
    lastPath = item.path;
  }
  return {
    contract: MEMORY_CONTRACT,
    registered,
    versions: summarizeRows(versionRows(db)),
    current: summarizeRows(currentNotes(db)),
    recordsDigest: memoryRecordsDigest(db),
  };
}
function distinctVersions(db: DatabaseSync) {
  // The same frozen file may be referenced by any number of revisions of the
  // same note. Check its contents once, and reject inconsistent associations.
  return db
    .prepare(
      `SELECT digest, min(note_id) AS noteId, max(note_id) AS lastNote,
    min(body_digest) AS bodyDigest, max(body_digest) AS lastBody FROM memory_versions
    GROUP BY digest ORDER BY digest`,
    )
    .iterate();
}
async function verifyVersions(root: string, db: DatabaseSync): Promise<void> {
  for (const version of distinctVersions(db)) {
    if (
      version.noteId !== version.lastNote ||
      version.bodyDigest !== version.lastBody
    )
      throw new OperationError("BACKUP_MEMORY_VERSION_INVALID", 409);
    const path = versionPath(root, String(version.digest));
    assertSafePath(path, "file");
    const file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const before = await file.stat();
      if (
        !before.isFile() ||
        before.nlink !== 1 ||
        before.size > MAX_NOTE_BYTES
      )
        throw new OperationError("BACKUP_MEMORY_VERSION_INVALID", 409);
      const bytes = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await file.read(
          bytes,
          offset,
          bytes.length - offset,
          null,
        );
        if (!bytesRead)
          throw new OperationError("BACKUP_MEMORY_DIGEST_MISMATCH", 409);
        offset += bytesRead;
      }
      if (
        (await file.stat()).size !== bytes.length ||
        hash(bytes) !== version.digest
      )
        throw new OperationError("BACKUP_MEMORY_DIGEST_MISMATCH", 409);
      const parsed = parseMemoryMarkdown(bytes);
      if (
        parsed.noteId !== version.noteId ||
        hash(parsed.body) !== version.bodyDigest
      )
        throw new OperationError("BACKUP_MEMORY_VERSION_INVALID", 409);
    } finally {
      await file.close();
    }
  }
}
async function copyVersions(
  source: string,
  target: string,
  db: DatabaseSync,
): Promise<void> {
  mkdirSync(join(target, "memory-versions"), { mode: 0o700 });
  for (const version of distinctVersions(db)) {
    const digest = String(version.digest);
    if (
      (
        await safeCopy(
          versionPath(source, digest),
          versionPath(target, digest),
          MAX_NOTE_BYTES,
        )
      ).digest !== digest
    )
      throw new OperationError("BACKUP_MEMORY_DIGEST_MISMATCH", 409);
  }
  await syncDirectory(join(target, "memory-versions"));
}
async function restoreVault(
  destination: string,
  db: DatabaseSync,
): Promise<void> {
  if (!db.prepare("SELECT 1 FROM memory_vault WHERE singleton=1").get()) return;
  const vault = join(destination, "restored-vault");
  mkdirSync(vault, { mode: 0o700 });
  let lastDirectory = vault;
  async function flushBranch() {
    for (let path = lastDirectory; path !== vault; path = dirname(path))
      await syncDirectory(path);
  }
  for (const note of currentNotes(db, true)) {
    const path = restoredNotePath(vault, note.path);
    if (dirname(path) !== lastDirectory) {
      await flushBranch();
      lastDirectory = dirname(path);
      assertSafePath(lastDirectory, "directory");
      mkdirSync(lastDirectory, { recursive: true, mode: 0o700 });
    }
    if (
      (
        await safeCopy(
          versionPath(destination, note.digest),
          path,
          MAX_NOTE_BYTES,
        )
      ).digest !== note.digest
    )
      throw new OperationError("BACKUP_MEMORY_DIGEST_MISMATCH", 409);
  }
  await flushBranch();
  await syncDirectory(vault);
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
function attachmentRows(db: DatabaseSync): Iterable<BackupAttachment> {
  return db
    .prepare(
      `SELECT workspace_id AS workspaceId, room_id AS roomId, attachment_id AS id,
    blob_key AS blobKey,digest,size,state FROM attachments ORDER BY workspace_id,room_id,attachment_id`,
    )
    .iterate() as unknown as Iterable<BackupAttachment>;
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
  async backup(destination: string): Promise<SnapshotManifest> {
    const root = resolve(destination);
    assertDetached(this.app.root, root);
    const release = acquireHostLock(this.app.root);
    let maintenance = false;
    try {
      const binding = this.app.db
        .prepare("SELECT root FROM memory_vault WHERE singleton=1")
        .get();
      if (binding) assertDetached(String(binding.root), root);
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
      await observePendingFiles(this.app, databasePath);
      const snapshot = openSnapshot(databasePath);
      let manifest: SnapshotManifest;
      try {
        const appSchema = integrity(snapshot);
        if (appSchema === 1)
          throw new OperationError("BACKUP_SCHEMA_INVALID", 409);
        await semanticIntegrity(snapshot);
        const summary = await describe(snapshot);
        const attachments = summarizeRows(attachmentRows(snapshot));
        for (const attachment of attachmentRows(snapshot)) {
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
        await syncDirectory(join(root, "attachments"));
        const memory = await memorySnapshot(snapshot);
        await copyVersions(this.app.root, root, snapshot);
        await verifyVersions(root, snapshot);
        manifest = {
          schema: "MAP-MEM-1:BACKUP:3",
          contract: APP_CONTRACT,
          appSchema,
          memory,
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
      await syncDirectory(root);
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
function expectedMemory(manifest: BackupManifest): MemoryInventory | undefined {
  if (manifest.schema === "MAP-DATA-1:BACKUP:1") return;
  if (manifest.schema === "MAP-MEM-1:BACKUP:3") return manifest.memory;
  const legacy = manifest.memory;
  return {
    contract: legacy.contract,
    registered: legacy.registered,
    versions: summarizeRows(legacy.versions),
    current: summarizeRows(legacy.current),
    recordsDigest: legacy.recordsDigest,
  };
}
function expectedAttachments(manifest: BackupManifest): Inventory {
  return manifest.schema === "MAP-MEM-1:BACKUP:3"
    ? manifest.attachments
    : summarizeRows(manifest.attachments);
}
function validInventory(value: any): boolean {
  return (
    !!value &&
    Number.isSafeInteger(value.count) &&
    value.count >= 0 &&
    typeof value.digest === "string" &&
    /^[a-f0-9]{64}$/.test(value.digest)
  );
}
async function verifyBackup(
  source: string,
  destination: string,
): Promise<BackupManifest> {
  assertSafePath(source, "directory");
  const manifest: BackupManifest = await readProtectedJson(
    join(source, "manifest.json"),
  );
  if (
    !manifest ||
    manifest.contract !== APP_CONTRACT ||
    manifest.database?.file !== "app-data.sqlite"
  )
    throw new OperationError("BACKUP_MANIFEST_INVALID");
  switch (manifest.schema) {
    case "MAP-DATA-1:BACKUP:1":
      if (manifest.appSchema !== 1 || !Array.isArray(manifest.attachments))
        throw new OperationError("BACKUP_MANIFEST_INVALID");
      break;
    case "MAP-MEM-1:BACKUP:2":
      if (
        manifest.appSchema !== 2 ||
        !Array.isArray(manifest.attachments) ||
        manifest.memory?.contract !== MEMORY_CONTRACT ||
        !Array.isArray(manifest.memory.versions) ||
        !Array.isArray(manifest.memory.current)
      )
        throw new OperationError("BACKUP_MANIFEST_INVALID");
      break;
    case "MAP-MEM-1:BACKUP:3":
      if (
        ![2, 3, 4].includes(manifest.appSchema) ||
        manifest.memory?.contract !== MEMORY_CONTRACT ||
        !validInventory(manifest.attachments) ||
        !validInventory(manifest.memory.versions) ||
        !validInventory(manifest.memory.current)
      )
        throw new OperationError("BACKUP_MANIFEST_INVALID");
      break;
    default:
      throw new OperationError("BACKUP_MANIFEST_INVALID");
  }
  const databasePath = join(source, "app-data.sqlite");
  const actual = await fileDigest(databasePath);
  if (
    actual.digest !== manifest.database.digest ||
    actual.size !== manifest.database.size
  )
    throw new OperationError("BACKUP_DATABASE_MISMATCH", 409);
  const db = openSnapshot(databasePath);
  try {
    if (integrity(db) !== manifest.appSchema)
      throw new OperationError("BACKUP_SCHEMA_INVALID", 409);
    const expected = expectedMemory(manifest);
    if (expected) {
      const binding = db
        .prepare("SELECT root FROM memory_vault WHERE singleton=1")
        .get();
      if (binding) assertDetached(String(binding.root), destination);
      if (json(await memorySnapshot(db)) !== json(expected))
        throw new OperationError("BACKUP_MANIFEST_MISMATCH", 409);
      await verifyVersions(source, db);
    }
    await semanticIntegrity(db);
    const summary = await describe(db);
    if (
      summary.referencesDigest !== manifest.referencesDigest ||
      summary.deletionsDigest !== manifest.deletionsDigest ||
      summary.importsDigest !== manifest.importsDigest ||
      json(summary.counts) !== json(manifest.counts) ||
      json(summarizeRows(attachmentRows(db))) !==
        json(expectedAttachments(manifest))
    )
      throw new OperationError("BACKUP_MANIFEST_MISMATCH", 409);
    for (const attachment of attachmentRows(db)) {
      const actual = await fileDigest(blobPath(source, attachment.blobKey));
      if (
        actual.digest !== attachment.digest ||
        actual.size !== attachment.size
      )
        throw new OperationError("BACKUP_ATTACHMENT_MISMATCH", 409);
    }
  } finally {
    db.close();
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
  const manifest = await verifyBackup(source, destination);
  safeEmptyRoot(destination);
  const release = acquireHostLock(destination);
  try {
    // The marker is written before copying anything. A crash during restoration stays fail-closed.
    await writeDurableJson(
      join(destination, "RESTORED_DISABLED"),
      { state: "COPYING", sourceManifestDigest: hash(json(manifest)) },
      true,
    );
    await syncDirectory(destination);
    mkdirSync(join(destination, "attachments"), { mode: 0o700 });
    for (const directory of ["staging", "exports", "backups"])
      mkdirSync(join(destination, directory), { mode: 0o700 });
    const copied = await safeCopy(
      join(source, "app-data.sqlite"),
      join(destination, "app-data.sqlite"),
    );
    if (copied.digest !== manifest.database.digest)
      throw new OperationError("BACKUP_DATABASE_MISMATCH", 409);
    // Read the indexed inventory from the exact copied database, before any
    // migration changes derived authority records. Do not reopen the source Vault.
    const snapshot = openSnapshot(join(destination, "app-data.sqlite"));
    try {
      if (
        integrity(snapshot) !== manifest.appSchema ||
        json(summarizeRows(attachmentRows(snapshot))) !==
          json(expectedAttachments(manifest))
      )
        throw new OperationError("RESTORE_REFERENCE_MISMATCH", 409);
      for (const attachment of attachmentRows(snapshot)) {
        const copy = await safeCopy(
          blobPath(source, attachment.blobKey),
          blobPath(destination, attachment.blobKey),
          attachment.size,
        );
        if (copy.digest !== attachment.digest || copy.size !== attachment.size)
          throw new OperationError("BACKUP_ATTACHMENT_MISMATCH", 409);
      }
      await syncDirectory(join(destination, "attachments"));
      const expected = expectedMemory(manifest);
      if (expected) {
        if (json(await memorySnapshot(snapshot)) !== json(expected))
          throw new OperationError("RESTORE_REFERENCE_MISMATCH", 409);
        await copyVersions(source, destination, snapshot);
        // The verified source catalogue contains the complete inventory for this backup
        // generation, even if a subsequent migration temporarily withholds the note.
        await restoreVault(destination, snapshot);
      }
    } finally {
      snapshot.close();
    }
    const app = new AppDatabase({ root: destination });
    try {
      app.db.exec("PRAGMA temp_store=FILE");

      app.maintenanceTransaction(() => {
        // A detached restore cannot witness whether an interrupted link was
        // already exposed then renamed/deleted by a human. Leave it for review.
        // The old restorer rebound its sole Vault to restored-vault and erased
        // preparation evidence. A later v2 backup of that root can contain
        // apparently PENDING/FAILED jobs that have already been visible.
        const binding = app.db
          .prepare("SELECT root FROM memory_vault WHERE singleton=1")
          .get();
        const lostWitness =
          Number(
            manifest.appSchema === 2 &&
              binding &&
              basename(String(binding.root)) === "restored-vault",
          ) || 0;
        const uncertain =
          "status='PUBLISHING' OR (status IN ('FAILED','PENDING') AND (prepared=1 OR ?=1))";
        app.db
          .prepare(
            `UPDATE memory_candidates SET state='CONFLICT'
          WHERE state IN ('PUBLISHING','APPROVED','FAILED') AND candidate_id IN
          (SELECT candidate_id FROM memory_jobs WHERE ${uncertain})`,
          )
          .run(lostWitness);
        app.db
          .prepare(
            `UPDATE memory_jobs SET status='CONFLICT',error_code='RESTORE_PUBLICATION_UNCERTAIN'
          WHERE ${uncertain}`,
          )
          .run(lostWitness);
        if (
          manifest.schema !== "MAP-DATA-1:BACKUP:1" &&
          manifest.memory.registered
        ) {
          const root = join(destination, "restored-vault");
          const stat = lstatSync(root, { bigint: true });
          app.db
            .prepare(
              "UPDATE memory_vault SET root=?,dev=?,ino=?,paused=1 WHERE singleton=1",
            )
            .run(root, String(stat.dev), String(stat.ino));
        }
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
      const memory = await memorySnapshot(app.db);
      if (
        summary.referencesDigest !== manifest.referencesDigest ||
        summary.deletionsDigest !== manifest.deletionsDigest ||
        summary.importsDigest !== manifest.importsDigest
      )
        throw new OperationError("RESTORE_REFERENCE_MISMATCH", 409);
      await writeDurableJson(
        join(destination, "restore-report.json"),
        {
          schema: "MAP-MEM-1:RESTORE:4",
          memoryRecordsDigest: memory.recordsDigest,
          vaultVersionsVerified: memory.versions.count,
          vaultDocumentsRestored: memory.current.count,
          verifiedAt: Date.now(),
          sourceManifestDigest: hash(json(manifest)),
          referencesDigest: summary.referencesDigest,
          deletionsDigest: summary.deletionsDigest,
          importsDigest: summary.importsDigest,
          counts: summary.counts,
          attachmentsVerified: expectedAttachments(manifest).count,
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
      await syncDirectory(destination);
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
    if (state.sourceManifestDigest !== report.sourceManifestDigest)
      throw new OperationError("RESTORE_REFERENCE_MISMATCH", 409);
    const app = new AppDatabase({ root });
    try {
      app.db.exec("PRAGMA temp_store=FILE");
      integrity(app.db);
      await semanticIntegrity(app.db);
      const summary = await describe(app.db);
      if (
        summary.referencesDigest !== report.referencesDigest ||
        summary.deletionsDigest !== report.deletionsDigest ||
        summary.importsDigest !== report.importsDigest
      )
        throw new OperationError("RESTORE_REFERENCE_MISMATCH", 409);
      const memory = await memorySnapshot(app.db);
      const migration = app.db
        .prepare(
          "SELECT * FROM app_restore_lineage_migration WHERE singleton=1",
        )
        .get();
      let verifiedDigest = memory.recordsDigest;
      if (migration && report.schema !== "MAP-MEM-1:RESTORE:4") {
        if (verifiedDigest !== migration.after_digest)
          throw new OperationError("RESTORE_REFERENCE_MISMATCH", 409);
        verifiedDigest = String(migration.before_digest);
        if (
          migration.source_schema === 3 &&
          report.schema === "MAP-MEM-1:RESTORE:2"
        ) {
          const older = app.db
            .prepare(
              "SELECT before_digest,after_digest FROM app_restore_migration_receipt WHERE singleton=1",
            )
            .get();
          if (older) {
            if (older.after_digest !== verifiedDigest)
              throw new OperationError("RESTORE_REFERENCE_MISMATCH", 409);
            verifiedDigest = String(older.before_digest);
          }
        }
      }
      const digestMatches = report.memoryRecordsDigest === verifiedDigest;
      const data1Restore =
        report.schema === "MAP-DATA-1:RESTORE:1" &&
        !memory.registered &&
        memory.versions.count === 0;
      if (!digestMatches && !data1Restore)
        throw new OperationError("RESTORE_REFERENCE_MISMATCH", 409);
      await verifyVersions(root, app.db);
      if (memory.registered) {
        const vault = join(root, "restored-vault");
        assertSafePath(vault, "directory");
        const stat = lstatSync(vault, { bigint: true });
        const binding = app.db
          .prepare("SELECT * FROM memory_vault WHERE singleton=1")
          .get()!;
        if (
          binding.root !== vault ||
          binding.dev !== String(stat.dev) ||
          binding.ino !== String(stat.ino) ||
          binding.paused !== 1
        )
          throw new OperationError("RESTORE_VAULT_BINDING_MISMATCH", 409);
        for (const note of currentNotes(app.db))
          if (
            (await fileDigest(restoredNotePath(vault, note.path))).digest !==
            note.digest
          )
            throw new OperationError("BACKUP_MEMORY_DIGEST_MISMATCH", 409);
      }
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
      await syncDirectory(root);
    } finally {
      app.close();
    }
  } finally {
    release();
  }
}
