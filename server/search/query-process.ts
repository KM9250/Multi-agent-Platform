import { fork } from "node:child_process";
import { AppError } from "../../shared/app-contracts/index.ts";
import type { SQLiteSearchBackend } from "./backend.ts";
import type { LexicalJob } from "./query-worker.ts";

type Result = ReturnType<SQLiteSearchBackend["query"]> & { lagging: boolean };
/** The child owns its SQLite connections. SIGKILL also interrupts a native FTS query. */
export function runSearchProcess<T>(
  moduleUrl: URL,
  job: object,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const child = fork(moduleUrl, [], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      serialization: "advanced",
    });
    let result: T | undefined, error: Error | undefined;
    const abort = () => {
      child.kill("SIGKILL");
    };
    signal.addEventListener("abort", abort, { once: true });
    child.once("message", (message: { result?: T; error?: string }) => {
      result = message.result;
      if (message.error)
        error = new AppError(
          message.error,
          message.error === "UNAUTHENTICATED"
            ? 401
            : message.error === "FORBIDDEN"
              ? 403
              : message.error === "NOT_FOUND"
                ? 404
                : ["SEARCH_CURSOR_INVALID", "CONTEXT_CHANGED", "RUN_NOT_ACTIVE"].includes(message.error)
                  ? 409
                  : 503,
        );
    });
    child.once("error", (e) => {
      error = e;
    });
    child.once("close", () => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) reject(signal.reason);
      else if (error || !result)
        reject(error ?? new AppError("INDEX_UNAVAILABLE", 503));
      else resolve(result);
    });
    child.send(job, (e) => {
      if (e) {
        error = e;
        abort();
      }
    });
  });
}

export function lexicalQuery(
  job: LexicalJob,
  signal: AbortSignal,
): Promise<Result> {
  return runSearchProcess(
    new URL("./query-worker.ts", import.meta.url),
    job,
    signal,
  );
}
