import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { OperationError } from "./legacy.ts";
import { assertSafePath } from "../app-data/db.ts";

/** Cooperative host lock: every HTTP server and maintenance CLI owns this for its full lifetime. */
export function acquireHostLock(root: string): () => void {
  const directory = resolve(root);
  assertSafePath(directory, "directory");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, ".server.lock"),
    nonce = randomUUID();
  let descriptor: number;
  try {
    descriptor = openSync(path, "wx", 0o600);
  } catch {
    throw new OperationError("HOST_IN_USE_OR_STALE_LOCK", 409);
  }
  writeSync(
    descriptor,
    JSON.stringify({ pid: process.pid, nonce, createdAt: Date.now() }),
  );
  const original = fstatSync(descriptor);
  closeSync(descriptor);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (!existsSync(path)) return;
    const current = lstatSync(path);
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.nlink !== 1 ||
      current.ino !== original.ino
    )
      throw new OperationError("HOST_LOCK_CHANGED", 409);
    let contents: any;
    try {
      contents = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new OperationError("HOST_LOCK_CHANGED", 409);
    }
    if (contents.nonce !== nonce)
      throw new OperationError("HOST_LOCK_CHANGED", 409);
    unlinkSync(path);
  };
}
export function assertOperationalRoot(root: string): void {
  if (existsSync(join(root, "RESTORED_DISABLED")))
    throw new OperationError("RESTORE_RESUME_REQUIRED", 503);
}
