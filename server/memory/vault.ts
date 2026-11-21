import {
  type BigIntStats,
  closeSync,
  constants as C,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { AppError } from "../../shared/app-contracts/index.ts";
import type { AppDatabase } from "../app-data/db.ts";
import { digest } from "../app-data/validation.ts";

export const MAX_NOTE_BYTES = 256 * 1024;
const safeId = /^[a-zA-Z0-9_-]{1,100}$/;
const hash = /^[a-f0-9]{64}$/;
const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));
const inside = (a: string, b: string) =>
  a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
const overlaps = (a: string, b: string) => inside(a, b) || inside(b, a);
const fail = (code = "UNSAFE_VAULT_PATH"): never => {
  throw new AppError(code, 409);
};
const errorIs = (error: unknown, code: string) =>
  (error as NodeJS.ErrnoException)?.code === code;
const pinned = (fd: number) => `/proc/self/fd/${fd}`;

// Linux directory handles anchor each child lookup, including nested human renames.
// Refuse other adapters before touching files until the same guarantees have been tested.
function openDir(path: string): number {
  if (process.platform !== "linux" || !existsSync("/proc/self/fd"))
    fail("VAULT_ADAPTER_UNAVAILABLE");
  return openSync(path, C.O_DIRECTORY | C.O_NOFOLLOW | C.O_RDONLY);
}
function absoluteDir(path: string): number {
  if (!isAbsolute(path) || path !== resolve(path)) fail();
  let fd = openDir("/");
  try {
    for (const part of path.split("/").filter(Boolean)) {
      const next = openDir(join(pinned(fd), part));
      closeSync(fd);
      fd = next;
    }
    return fd;
  } catch (e) {
    closeSync(fd);
    throw e;
  }
}
function ensureDirectory(parent: number, name: string): number {
  const path = join(pinned(parent), name);
  try {
    mkdirSync(path, { mode: 0o700 });
    fsyncSync(parent);
  } catch (e) {
    if (!errorIs(e, "EEXIST")) throw e;
  }
  const fd = openDir(path);
  if (fstatSync(fd).mode & 0o077) {
    closeSync(fd);
    fail("VAULT_DIRECTORY_NOT_PRIVATE");
  }
  return fd;
}
export function validVaultPath(path: string): boolean {
  return (
    typeof path === "string" &&
    Buffer.byteLength(path) <= 1024 &&
    path.split("/").length <= 16 &&
    path
      .split("/")
      .every(
        (s) =>
          s.length > 0 &&
          !s.startsWith(".") &&
          !/[\\:\x00-\x1f\x7f]/.test(s) &&
          Buffer.byteLength(s) <= 255,
      )
  );
}
function vaultRow(app: AppDatabase) {
  return app.db.prepare("SELECT * FROM memory_vault WHERE singleton=1").get();
}
function registeredDir(app: AppDatabase): number {
  const row = vaultRow(app);
  if (!row) fail("VAULT_UNREGISTERED");
  const fd = absoluteDir(String(row.root));
  const st = fstatSync(fd, { bigint: true });
  if (
    String(st.dev) !== row.dev ||
    String(st.ino) !== row.ino ||
    (st.mode & 0o077n) !== 0n
  ) {
    closeSync(fd);
    fail("VAULT_IDENTITY_CHANGED");
  }
  return fd;
}
export function vaultRoot(app: AppDatabase): string {
  closeSync(registeredDir(app));
  return String(vaultRow(app)!.root);
}
function validateStaticPath(path: string): void {
  // Verify even a partially configured path through the deepest existing ancestor.
  let current = resolve(path);
  while (!lstatSync(current, { throwIfNoEntry: false }))
    current = dirname(current);
  closeSync(absoluteDir(current));
}
export function assertVaultOutsideStatic(
  app: AppDatabase,
  staticRoot: string,
): void {
  const row = vaultRow(app);
  if (!row) return;
  if (overlaps(String(row.root), resolve(staticRoot)))
    fail("VAULT_OVERLAPS_STATIC");
  // A symlinked static root could otherwise expose files without reaching an API.
  validateStaticPath(staticRoot);
}
export function vaultStatus(app: AppDatabase) {
  const row = vaultRow(app);
  return {
    registered: !!row,
    paused: row?.paused !== 0,
    trustNew: row?.trust_new === 1,
  };
}
export function registerVault(
  app: AppDatabase,
  root: string,
  options: { trustNew?: boolean; staticRoot?: string } = {},
) {
  const staticRoot = resolve(options.staticRoot ?? "dist");
  if (
    !isAbsolute(root) ||
    root !== resolve(root) ||
    overlaps(root, resolve(sourceRoot)) ||
    overlaps(root, app.root) ||
    overlaps(root, staticRoot)
  )
    fail();
  return app.transaction(() => {
    const existing = vaultRow(app);
    if (existing) {
      if (
        existing.root !== root ||
        (options.trustNew !== undefined &&
          !!existing.trust_new !== options.trustNew)
      )
        fail("VAULT_ALREADY_REGISTERED");
      closeSync(registeredDir(app));
      return vaultStatus(app);
    }
    validateStaticPath(staticRoot);
    const parent = absoluteDir(dirname(root));
    try {
      const fd = ensureDirectory(parent, basename(root));
      try {
        const dir = opendirSync(pinned(fd));
        try {
          if (dir.readSync()) fail("DEDICATED_EMPTY_VAULT_REQUIRED");
        } finally {
          dir.closeSync();
        }
        const st = fstatSync(fd, { bigint: true });
        app.db
          .prepare(
            "INSERT INTO memory_vault(singleton,root,dev,ino,paused,trust_new) VALUES(1,?,?,?,1,?)",
          )
          .run(root, String(st.dev), String(st.ino), options.trustNew ? 1 : 0);
      } finally {
        closeSync(fd);
      }
    } finally {
      closeSync(parent);
    }
    return vaultStatus(app);
  }, "memory_vault_register");
}
export function setVaultPaused(app: AppDatabase, paused: boolean) {
  return app.transaction(() => {
    if (
      !paused &&
      app.db
        .prepare("SELECT restored FROM app_operational_state WHERE singleton=1")
        .get()?.restored
    )
      fail("RESTORE_PAUSED");
    closeSync(registeredDir(app));
    app.db
      .prepare("UPDATE memory_vault SET paused=? WHERE singleton=1")
      .run(paused ? 1 : 0);
    return vaultStatus(app);
  }, "memory_vault_state");
}
function vaultDirectory(app: AppDatabase, dir: string): number {
  if (dir !== "" && !validVaultPath(dir)) fail();
  let fd = registeredDir(app);
  try {
    for (const part of dir.split("/").filter(Boolean)) {
      const next = openDir(join(pinned(fd), part));
      closeSync(fd);
      fd = next;
    }
    return fd;
  } catch (e) {
    closeSync(fd);
    throw e;
  }
}
export function withVaultDirectory<T>(
  app: AppDatabase,
  dir: string,
  read: (path: string) => T,
): T {
  const fd = vaultDirectory(app, dir);
  try {
    return read(pinned(fd));
  } finally {
    closeSync(fd);
  }
}
function readBounded(path: string): Buffer {
  const fd = openSync(path, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size > BigInt(MAX_NOTE_BYTES)
    )
      fail("UNSAFE_NOTE");
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let n = 0;
    while (n < bytes.length) {
      const k = readSync(fd, bytes, n, bytes.length - n, null);
      if (!k) break;
      n += k;
    }
    const after = lstatSync(path, { bigint: true });
    if (
      n !== Number(before.size) ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.ctimeNs !== after.ctimeNs ||
      before.mtimeNs !== after.mtimeNs ||
      after.nlink !== 1n
    )
      fail("NOTE_CHANGED");
    return bytes.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}
export function readVaultFile(app: AppDatabase, relativePath: string): Buffer {
  if (
    !validVaultPath(relativePath) ||
    !relativePath.toLowerCase().endsWith(".md")
  )
    fail();
  const directory = dirname(relativePath);
  const dir = directory === "." ? "" : directory;
  return withVaultDirectory(app, dir, (pinnedParent) => {
    const name = basename(relativePath);
    const original = join(pinnedParent, name);
    const first = lstatSync(original, { bigint: true });
    const result = readBounded(original);
    // Re-open from the registered root after the read: a parent directory may itself have moved.
    withVaultDirectory(app, dir, (currentParent) => {
      const last = lstatSync(join(currentParent, name), { bigint: true });
      if (
        first.ino !== last.ino ||
        first.dev !== last.dev ||
        first.ctimeNs !== last.ctimeNs
      )
        fail("NOTE_CHANGED");
    });
    return result;
  });
}
function withPrivateDirectory<T>(
  app: AppDatabase,
  name: "memory-versions" | "memory-publication-state",
  fn: (fd: number) => T,
): T {
  const root = absoluteDir(app.root);
  try {
    const directory = ensureDirectory(root, name);
    try {
      return fn(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    closeSync(root);
  }
}
export function readVersion(app: AppDatabase, fileDigest: string): Buffer {
  if (!hash.test(fileDigest)) fail("INVALID_VERSION");
  return withPrivateDirectory(app, "memory-versions", (fd) => {
    const bytes = readBounded(join(pinned(fd), fileDigest + ".md"));
    if (digest(bytes) !== fileDigest) fail("VERSION_INTEGRITY");
    return bytes;
  });
}
export function saveVersion(app: AppDatabase, bytes: Buffer): string {
  if (bytes.length > MAX_NOTE_BYTES) fail("NOTE_TOO_LARGE");
  const key = digest(bytes);
  return withPrivateDirectory(app, "memory-versions", (fd) => {
    const path = join(pinned(fd), key + ".md");
    if (!statOrNull(path)) {
      // Private content-addressed area. A complete staged inode is installed before a DB reference exists.
      const temp = join(pinned(fd), randomUUID() + ".tmp");
      const handle = openSync(temp, "wx", 0o400);
      try {
        writeFileSync(handle, bytes);
        fsyncSync(handle);
      } finally {
        closeSync(handle);
      }
      // All version writers run in an AppDatabase writer transaction; use rename within this private store.
      try {
        renameSync(temp, path);
        fsyncSync(fd);
      } catch (e) {
        try {
          unlinkSync(temp);
        } catch {}
        throw e;
      }
    }
    if (!readBounded(path).equals(bytes)) fail("VERSION_INTEGRITY");
    return key;
  });
}
export function freezePublication(input: {
  operationId: string;
  noteId: string;
  body: string;
  kind: string | null;
  assertionType: string | null;
  scope: string;
  sourceRefs: string[];
  recordedAt: number;
}) {
  if (!safeId.test(input.noteId) || !safeId.test(input.operationId))
    fail("INVALID_PUBLICATION_ID");
  const properties = {
    map_id: input.noteId,
    map_operation: input.operationId,
    kind: input.kind ?? "unclassified",
    assertion_type: input.assertionType ?? "unclassified",
    scope_hint: input.scope,
    source_refs: input.sourceRefs,
    recorded_at: new Date(input.recordedAt).toISOString(),
  };
  const markdown =
    "---\n" +
    Object.entries(properties)
      .map(([k, v]) => k + ": " + JSON.stringify(v))
      .join("\n") +
    "\n---\n" +
    input.body;
  if (Buffer.byteLength(markdown) > MAX_NOTE_BYTES) fail("NOTE_TOO_LARGE");
  return {
    markdown,
    fileDigest: digest(markdown),
    relativePath: input.noteId + ".md",
  };
}

type FrozenJob = {
  operation_id: string;
  note_id: string;
  relative_path: string;
  markdown: string;
  file_digest: string;
};
function verifyFrozen(job: FrozenJob): Buffer {
  if (
    !safeId.test(job.note_id) ||
    !safeId.test(job.operation_id) ||
    job.relative_path !== job.note_id + ".md" ||
    digest(job.markdown) !== job.file_digest ||
    !job.markdown.startsWith(
      "---\nmap_id: " +
        JSON.stringify(job.note_id) +
        "\nmap_operation: " +
        JSON.stringify(job.operation_id) +
        "\n",
    )
  )
    fail("PUBLICATION_BINDING_MISMATCH");
  return Buffer.from(job.markdown);
}
function stagedFile<T>(
  app: AppDatabase,
  job: FrozenJob,
  fn: (root: number, stageDir: number, stage: string) => T,
): T {
  const root = registeredDir(app);
  try {
    const dir = ensureDirectory(root, ".map-staging");
    try {
      return fn(root, dir, join(pinned(dir), job.operation_id + ".stage"));
    } finally {
      closeSync(dir);
    }
  } finally {
    closeSync(root);
  }
}
function statOrNull(path: string) {
  return lstatSync(path, { bigint: true, throwIfNoEntry: false });
}
// This lineage record lives under the protected app root. It binds a single editable inode
// to the frozen operation. The ctime changes during link/unlink; birth time stays stable.
function lineage(job: FrozenJob, st: BigIntStats | undefined): string {
  if (!st?.isFile() || st.birthtimeNs <= 0n) fail("PUBLICATION_CONFLICT");
  return JSON.stringify([
    job.operation_id,
    job.note_id,
    job.relative_path,
    job.file_digest,
    String(st.dev),
    String(st.ino),
    String(st.birthtimeNs),
  ]);
}
function saveEvidence(dir: number, path: string, record: string): void {
  const temp = join(pinned(dir), randomUUID() + ".tmp");
  const fd = openSync(temp, "wx", 0o400);
  try {
    writeFileSync(fd, record);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  // Serialized by the SQLite writer. Rename only in the private control directory.
  renameSync(temp, path);
  fsyncSync(dir);
}
function witnessPaths(dir: number, job: FrozenJob) {
  const file = join(pinned(dir), job.operation_id);
  return { ready: file + ".ready", attempt: file + ".attempt" };
}
function verifyEvidence(
  path: string,
  job: FrozenJob,
  st: BigIntStats | undefined,
): void {
  if (readBounded(path).toString("utf8") !== lineage(job, st))
    fail("PUBLICATION_CONFLICT");
}

/** Only a PENDING job can mint a ready witness, before its PUBLISHING state commits. */
export function prepareFrozen(app: AppDatabase, job: FrozenJob): void {
  const expected = verifyFrozen(job);
  stagedFile(app, job, (_root, dir, stage) =>
    withPrivateDirectory(app, "memory-publication-state", (control) => {
      const { ready, attempt } = witnessPaths(control, job);
      if (statOrNull(attempt)) fail("PUBLICATION_CONFLICT");
      const previous = statOrNull(ready);
      if (previous) verifyEvidence(ready, job, statOrNull(stage));
      if (!statOrNull(stage)) {
        const temp = join(pinned(dir), randomUUID() + ".tmp");
        const handle = openSync(temp, "wx", 0o600);
        try {
          writeFileSync(handle, expected);
          fsyncSync(handle);
        } finally {
          closeSync(handle);
        }
        renameSync(temp, stage);
      }
      fsyncSync(dir);
      const identity = lineage(job, statOrNull(stage));
      if (
        !readBounded(stage).equals(expected) ||
        identity !== lineage(job, statOrNull(stage))
      )
        fail("PUBLICATION_CONFLICT");
      if (!previous) saveEvidence(control, ready, identity);
    }),
  );
}

/** An attempt may have been operator-visible even when both content and link count look pristine.
 * Consume the ready witness durably BEFORE link(). Recovery with an attempted witness can only
 * inspect a surviving target. No retry interprets a missing target as permission to create it. */
export function publishFrozen(
  app: AppDatabase,
  job: FrozenJob,
  hooks?: {
    beforeLink?: () => void;
    afterLink?: () => void;
    beforeReceipt?: () => void;
  },
): Buffer {
  const expected = verifyFrozen(job);
  return stagedFile(app, job, (root, dir, stage) =>
    withPrivateDirectory(app, "memory-publication-state", (control) => {
      const { ready, attempt } = witnessPaths(control, job);
      const target = join(pinned(root), job.relative_path);
      let dest = statOrNull(target);
      const staged = statOrNull(stage);
      if (statOrNull(ready)) {
        if (statOrNull(attempt) || dest || staged?.nlink !== 1n)
          fail("PUBLICATION_CONFLICT");
        verifyEvidence(ready, job, staged);
        if (!readBounded(stage).equals(expected)) fail("PUBLICATION_CONFLICT");
        renameSync(ready, attempt);
        fsyncSync(control);
        hooks?.beforeLink?.();
        linkSync(stage, target); // EEXIST is terminal; another writer won this name.
        hooks?.afterLink?.();
        dest = statOrNull(target);
      } else if (!statOrNull(attempt)) {
        // Legacy PUBLISHING jobs have no pre-link witness. A lone stage (even nlink==1)
        // cannot distinguish never-linked from linked-then-deleted. Only a surviving
        // exact stage/destination pair proves the original editable inode.
        if (
          !staged?.isFile() ||
          !dest?.isFile() ||
          dest.nlink !== 2n ||
          dest.dev !== staged.dev ||
          dest.ino !== staged.ino
        )
          fail("PUBLICATION_CONFLICT");
        saveEvidence(control, attempt, lineage(job, staged));
      }
      verifyEvidence(attempt, job, dest);
      if (staged) {
        if (
          dest.nlink !== 2n ||
          dest.dev !== staged.dev ||
          dest.ino !== staged.ino
        )
          fail("PUBLICATION_CONFLICT");
        fsyncSync(root);
        unlinkSync(stage);
        fsyncSync(dir);
      }
      hooks?.beforeReceipt?.();
      const bytes = readVaultFile(app, job.relative_path);
      verifyEvidence(attempt, job, statOrNull(target));
      if (!bytes.equals(expected)) fail("PUBLICATION_CONFLICT");
      fsyncSync(root);
      return bytes;
    }),
  );
}
