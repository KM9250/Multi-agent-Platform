import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AppDatabase } from "./app-data/db.ts";
import { AuthorizationPolicy, AuthError } from "./auth/authorization.ts";
import { SessionService } from "./auth/sessions.ts";
import { AttachmentStore } from "./attachments/store.ts";
import {
  BackupService,
  restoreBackup,
  resumeRestore,
} from "./operations/backup.ts";
import { acquireHostLock, assertOperationalRoot } from "./operations/locks.ts";
import { inspectDataHealth } from "./operations/health.ts";
import { protectedDataRoot } from "./http/config.ts";
import { registerVault, setVaultPaused, vaultStatus } from "./memory/vault.ts";
import { registerHandwrittenNote, scanVault } from "./memory/importer.ts";
import { setNoteTrust } from "./memory/notes.ts";
import { listVaultConflicts } from "./memory/conflicts.ts";

function flags(argv: string[]): Record<string, string> {
  const output: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (
      !/^--[a-z-]+$/.test(argv[i]) ||
      !argv[i + 1] ||
      argv[i + 1].startsWith("--") ||
      output[argv[i].slice(2)]
    )
      throw new AuthError("INVALID_ARGUMENTS", 400);
    output[argv[i].slice(2)] = argv[i + 1];
  }
  return output;
}
async function stdinPassword(): Promise<string> {
  if (process.stdin.isTTY) throw new AuthError("PASSWORD_STDIN_REQUIRED", 400);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 1026) throw new AuthError("PASSWORD_LENGTH", 400);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks)
    .toString("utf8")
    .replace(/\r?\n$/, "");
}
export async function runCli(argv = process.argv.slice(2)) {
  const command = argv[0],
    args = flags(argv.slice(1)),
    root = args.root ?? process.env.MAP_DATA_ROOT;
  const allowed: Record<string, string[]> = {
    "account-create": ["root", "username", "workspace", "no-public-grants"],
    "account-revoke": ["root", "actor"],
    "password-reset": ["root", "actor"],
    grant: [
      "root",
      "actor",
      "workspace",
      "operation",
      "room",
      "persona",
      "provider",
      "visibility",
    ],
    revoke: ["root", "actor", "workspace", "operation"],
    backup: ["root", "destination"],
    restore: ["source", "destination"],
    resume: ["root"],
    "vault-register": ["root", "path", "trust-new"],
    "vault-register-note": [
      "root",
      "workspace",
      "actor",
      "room",
      "persona",
      "visibility",
      "note",
      "path",
      "digest",
      "request",
      "trusted",
    ],
    "vault-status": ["root"],
    "vault-pause": ["root"],
    "vault-resume": ["root"],
    "vault-rescan": ["root"],
    "vault-conflicts": [
      "root",
      "workspace",
      "room",
      "actor",
      "after-note",
      "after-candidate",
    ],
    "vault-trust": ["root", "workspace", "actor", "note", "trusted"],
    "attachment-check": ["root", "remove-orphans"],
    status: ["root", "warning-bytes"],
  };
  if (
    !allowed[command] ||
    Object.keys(args).some((k) => !allowed[command].includes(k))
  )
    throw new AuthError("INVALID_ARGUMENTS", 400);
  if (command === "restore") {
    if (!args.source || !args.destination || !isAbsolute(args.source))
      throw new AuthError("INVALID_ARGUMENTS", 400);
    return restoreBackup(
      resolve(args.source),
      protectedDataRoot(args.destination),
    );
  }
  if (!root) throw new AuthError("DATA_ROOT_REQUIRED", 400);
  const protectedRoot = protectedDataRoot(root, process.env.MAP_STATIC_ROOT);
  if (command === "resume") {
    await resumeRestore(protectedRoot);
    return { resumed: true };
  }
  if (command.startsWith("vault-") && command !== "vault-status")
    assertOperationalRoot(protectedRoot);
  const app = new AppDatabase({ root: protectedRoot });
  try {
    const sessions = new SessionService(app),
      policy = new AuthorizationPolicy(app);
    switch (command) {
      case "account-create":
        if (!args.username) throw new AuthError("INVALID_ARGUMENTS", 400);
        return await sessions.createAccount({
          username: args.username,
          password: await stdinPassword(),
          workspaceId: args.workspace,
          publicGrants: args["no-public-grants"] !== "true",
        });
      case "account-revoke":
        if (!args.actor) throw new AuthError("INVALID_ARGUMENTS", 400);
        sessions.revokeAccount(args.actor);
        return { revoked: true };
      case "password-reset":
        if (!args.actor) throw new AuthError("INVALID_ARGUMENTS", 400);
        await sessions.resetPassword(args.actor, await stdinPassword());
        return { reset: true };
      case "grant":
        if (!args.actor || !args.workspace || !args.operation)
          throw new AuthError("INVALID_ARGUMENTS", 400);
        policy.grant(args.actor, args.workspace, args.operation, {
          roomId: args.room,
          personaId: args.persona,
          provider: args.provider,
          visibility: args.visibility,
        });
        return { granted: true };
      case "revoke":
        if (!args.actor || !args.workspace)
          throw new AuthError("INVALID_ARGUMENTS", 400);
        policy.revoke(args.actor, args.workspace, args.operation);
        return { revoked: true };
      case "backup":
        if (!args.destination) throw new AuthError("INVALID_ARGUMENTS", 400);
        return await new BackupService(app).backup(
          protectedDataRoot(args.destination),
        );
      case "vault-status":
        return vaultStatus(app);
      case "vault-conflicts": {
        if (!args.workspace || !args.actor || !args.room)
          throw new AuthError("INVALID_ARGUMENTS", 400);
        const actor = { workspaceId: args.workspace, actorId: args.actor };
        return listVaultConflicts(
          app,
          policy,
          actor,
          args.room,
          args["after-note"],
          args["after-candidate"],
        );
      }
      case "vault-register":
      case "vault-register-note":
      case "vault-pause":
      case "vault-resume":
      case "vault-rescan":
      case "vault-trust": {
        const release = acquireHostLock(app.root);
        try {
          assertOperationalRoot(app.root);
          if (command === "vault-register") {
            if (
              !args.path ||
              (args["trust-new"] !== undefined &&
                !["true", "false"].includes(args["trust-new"]))
            )
              throw new AuthError("INVALID_ARGUMENTS", 400);
            return registerVault(app, args.path, {
              trustNew:
                args["trust-new"] === undefined
                  ? undefined
                  : args["trust-new"] === "true",
              staticRoot: process.env.MAP_STATIC_ROOT,
            });
          }
          if (command === "vault-rescan") return await scanVault(app);
          if (command === "vault-register-note") {
            if (
              !args.workspace ||
              !args.actor ||
              !args.room ||
              !args.persona ||
              !args.visibility ||
              !args.note ||
              !args.path ||
              !args.digest ||
              !args.request ||
              (args.trusted !== undefined &&
                !["true", "false"].includes(args.trusted))
            )
              throw new AuthError("INVALID_ARGUMENTS", 400);
            const actor = { workspaceId: args.workspace, actorId: args.actor };
            policy.assert(actor, "MANAGE_VAULT");
            return await registerHandwrittenNote(app, policy, actor, {
              roomId: args.room,
              personaId: args.persona,
              scope: args.visibility,
              noteId: args.note,
              relativePath: args.path,
              expectedDigest: args.digest,
              requestId: args.request,
              trusted: args.trusted === "true",
            });
          }
          if (command === "vault-trust") {
            if (
              !args.workspace ||
              !args.actor ||
              !args.note ||
              !["true", "false"].includes(args.trusted)
            )
              throw new AuthError("INVALID_ARGUMENTS", 400);
            const actor = { workspaceId: args.workspace, actorId: args.actor };
            policy.assert(actor, "MANAGE_VAULT");
            await setNoteTrust(
              app,
              policy,
              actor,
              args.note,
              args.trusted === "true",
            );
            return { updated: true };
          }
          return setVaultPaused(app, command === "vault-pause");
        } finally {
          release();
        }
      }
      case "attachment-check": {
        if (
          args["remove-orphans"] !== undefined &&
          !["true", "false"].includes(args["remove-orphans"])
        )
          throw new AuthError("INVALID_ARGUMENTS", 400);
        const release = acquireHostLock(app.root);
        try {
          return await new AttachmentStore(app, policy).collectOrphans(
            args["remove-orphans"] === "true",
          );
        } finally {
          release();
        }
      }
      case "status": {
        const warningBytes =
          args["warning-bytes"] === undefined
            ? undefined
            : Number(args["warning-bytes"]);
        if (
          warningBytes !== undefined &&
          (!Number.isSafeInteger(warningBytes) || warningBytes <= 0)
        )
          throw new AuthError("INVALID_ARGUMENTS", 400);
        return await inspectDataHealth(app, {
          ...(warningBytes === undefined ? {} : { warningBytes }),
          retentionMode: "manual",
        });
      }
      default:
        throw new AuthError("INVALID_ARGUMENTS", 400);
    }
  } finally {
    app.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  runCli()
    .then((result) => process.stdout.write(JSON.stringify(result) + "\n"))
    .catch((error: any) => {
      process.stderr.write(
        JSON.stringify({
          error: {
            code: /^[A-Z0-9_]+$/.test(error?.code ?? "")
              ? error.code
              : "COMMAND_FAILED",
          },
        }) + "\n",
      );
      process.exitCode = 1;
    });
