import { types as nodeTypes } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { AppError, APP_LIMITS } from "../../shared/app-contracts/index.ts";
export const id = () => randomUUID();
export const digest = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
export function canonical(value: unknown): string {
  checkValue(value);
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return (
    "{" +
    Object.keys(value)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + canonical((value as any)[k]))
      .join(",") +
    "}"
  );
}
export function checkValue(value: unknown, depth = 0): void {
  if (depth > APP_LIMITS.maxDepth) throw new AppError("INPUT_TOO_DEEP", 413);
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (value.length > APP_LIMITS.requestBytes)
      throw new AppError("INPUT_TOO_LARGE", 413);
    return;
  }
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object") throw new AppError("INVALID_INPUT");
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    throw new AppError("INVALID_INPUT");
  const keys = Object.keys(value);
  if (keys.length > 10000) throw new AppError("INPUT_TOO_LARGE", 413);
  for (const k of keys) {
    if (["__proto__", "constructor", "prototype"].includes(k))
      throw new AppError("INVALID_INPUT");
    const d = Object.getOwnPropertyDescriptor(value, k);
    if (!d || !("value" in d)) throw new AppError("INVALID_INPUT");
    checkValue(d.value, depth + 1);
  }
}
export function object(
  value: unknown,
  keys: readonly string[],
): Record<string, any> {
  checkValue(value);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AppError("INVALID_INPUT");
  for (const key of Object.keys(value))
    if (!keys.includes(key)) throw new AppError("UNKNOWN_FIELD");
  return value as Record<string, any>;
}
export function string(
  value: unknown,
  max: number = APP_LIMITS.messageChars,
  required = true,
): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    (required && !value.trim()) ||
    value.includes("\0")
  )
    throw new AppError("INVALID_INPUT");
  return value;
}
export function integer(
  value: unknown,
  min = 1,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < min ||
    Number(value) > max
  )
    throw new AppError("INVALID_INPUT");
  return Number(value);
}
export function bool(value: unknown): boolean {
  if (typeof value !== "boolean") throw new AppError("INVALID_INPUT");
  return value;
}
export function guard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError("STORAGE_FAILURE", 503);
  }
}

/** Policy callbacks receive detached immutable facts, never live query state or a mutable DTO. */
export function securePolicy<
  T extends import("../../shared/app-contracts/index.ts").AuthorizationPort,
>(policy: T): import("../../shared/app-contracts/index.ts").AuthorizationPort {
  const assert = policy.assert.bind(policy),
    read = policy.canReadSegment.bind(policy),
    revision = policy.revision?.bind(policy);
  const reject = (value: unknown): never => {
    if (nodeTypes.isPromise(value))
      Promise.prototype.then.call(value, undefined, () => {});
    throw new AppError("INVALID_AUTHORIZATION_CALLBACK", 403);
  };
  const sync = (value: unknown) => {
    if (value !== undefined) reject(value);
  };
  return Object.freeze({
    assert: (actor, operation, scope = {}) =>
      sync(
        assert(
          Object.freeze({ ...actor }),
          operation,
          Object.freeze({ ...scope }),
        ),
      ),
    canReadSegment: (actor, segment) => {
      const allowed = read(
        Object.freeze({ ...actor }),
        Object.freeze({ ...segment }),
      );
      if (typeof allowed !== "boolean") reject(allowed);
      return allowed === true;
    },
    ...(revision
      ? {
          revision: (actor, workspaceId) => {
            const value = revision(Object.freeze({ ...actor }), workspaceId);
            if (!Number.isSafeInteger(value) || value < 1) reject(value);
            return value;
          },
        }
      : {}),
  });
}
