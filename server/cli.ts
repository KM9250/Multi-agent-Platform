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
import { acquireHostLock } from "./operations/locks.ts";
import { inspectDataHealth } from "./operations/health.ts";
import { protectedDataRoot } from "./http/config.ts";

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
