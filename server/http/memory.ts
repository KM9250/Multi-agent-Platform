import type { AppDatabase } from "../app-data/db.ts";
import {
  AuthError,
  type Actor,
  type AuthorizationPolicy,
} from "../auth/authorization.ts";
import { listVaultConflicts } from "../memory/conflicts.ts";
import { MemoryCandidates } from "../memory/candidates.ts";
import { scanVault } from "../memory/importer.ts";
import {
  listNoteChanges,
  listNotes,
  listVersions,
  lookupNote,
  readNote,
  retractNote,
} from "../memory/notes.ts";
import { vaultStatus } from "../memory/vault.ts";
import { retryPublication } from "../memory/worker.ts";

function query(url: URL, key?: string): string | undefined {
  const keys = [...url.searchParams.keys()];
  if (keys.length === 0) return undefined;
  if (!key || keys.length !== 1 || keys[0] !== key)
    throw new AuthError("INVALID_INPUT", 400);
  const value = url.searchParams.get(key)!;
  if (value.length === 0 || value.length > 160)
    throw new AuthError("INVALID_INPUT", 400);
  return value;
}

function versionQuery(url: URL, key: string): number | undefined {
  const raw = query(url, key);
  if (raw === undefined) return undefined;
  const version = Number(raw);
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(version))
    throw new AuthError("INVALID_INPUT", 400);
  return version;
}

export function memoryRoutes(app: AppDatabase, policy: AuthorizationPolicy) {
  const candidates = new MemoryCandidates(app, policy);
  return async (
    actor: Actor,
    method: string,
    parts: string[],
    url: URL,
    input: () => Promise<any>,
  ) => {
    if (parts[0] === "memory") {
      policy.assert(actor, "MANAGE_VAULT");
      query(url);
      if (parts.length === 2 && parts[1] === "vault" && method === "GET")
        return vaultStatus(app);
      if (
        parts.length === 3 &&
        parts[1] === "vault" &&
        parts[2] === "rescan" &&
        method === "POST"
      ) {
        const value = await input();
        if (
          !value ||
          Array.isArray(value) ||
          typeof value !== "object" ||
          Object.keys(value).length
        )
          throw new AuthError("INVALID_INPUT", 400);
        policy.assert(actor, "MANAGE_VAULT");
        const result = await scanVault(app);
        policy.assert(actor, "MANAGE_VAULT");
        return result;
      }
      throw new AuthError("NOT_FOUND", 404);
    }

    const [, roomId, , resource, id, action] = parts;
    if (parts.length === 4 && method === "GET") {
      if (resource === "candidates")
        return candidates.list(actor, roomId, query(url, "after"));
      if (resource === "changes")
        return listNoteChanges(app, policy, actor, roomId, query(url, "after"));
      if (resource === "notes")
        return listNotes(app, policy, actor, roomId, {
          after: query(url, "after"),
        });
      if (resource === "conflicts") {
        const entries = [...url.searchParams];
        if (
          entries.some(
            ([key, value]) =>
              !["afterNote", "afterCandidate"].includes(key) ||
              !value ||
              value.length > 160 ||
              url.searchParams.getAll(key).length !== 1,
          )
        )
          throw new AuthError("INVALID_INPUT", 400);
        return listVaultConflicts(
          app,
          policy,
          actor,
          roomId,
          url.searchParams.get("afterNote") ?? undefined,
          url.searchParams.get("afterCandidate") ?? undefined,
        );
      }
    }
    if (parts.length === 5 && resource === "candidates") {
      query(url);
      if (method === "GET") return candidates.get(actor, roomId, id);
      if (method === "PATCH")
        return candidates.edit(actor, roomId, id, await input());
    }
    if (
      parts.length === 6 &&
      resource === "candidates" &&
      action === "source" &&
      method === "GET"
    ) {
      query(url);
      return candidates.source(actor, roomId, id);
    }
    if (
      parts.length === 6 &&
      resource === "candidates" &&
      action === "retry" &&
      method === "POST"
    ) {
      query(url);
      return retryPublication(app, policy, actor, roomId, id, await input());
    }
    if (
      parts.length === 6 &&
      resource === "candidates" &&
      action === "retract" &&
      method === "POST"
    ) {
      query(url);
      return candidates.retract(actor, roomId, id, await input());
    }
    if (parts.length === 4 && resource === "reviews" && method === "POST") {
      query(url);
      return candidates.review(actor, roomId, await input());
    }
    if (resource === "notes" && id && parts.length <= 6) {
      if (lookupNote(app, policy, actor, id).room_id !== roomId)
        throw new AuthError("NOT_FOUND", 404);
      if (parts.length === 5 && method === "GET") {
        const version = versionQuery(url, "version");
        return readNote(app, policy, actor, id, version);
      }
      if (action === "history" && method === "GET") {
        const version = versionQuery(url, "before");
        return listVersions(app, policy, actor, id, version);
      }
      query(url);
      if (action === "retract" && method === "POST")
        return retractNote(app, policy, actor, id, await input());
      if (action === "proposals" && method === "POST")
        return candidates.propose(actor, roomId, id, await input());
    }
    throw new AuthError("NOT_FOUND", 404);
  };
}
