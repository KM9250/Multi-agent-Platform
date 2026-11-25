import {
  fstatSync,
  openSync,
  readFileSync,
  closeSync,
  constants,
} from "node:fs";
import { isAbsolute } from "node:path";
import { AppError } from "../../shared/app-contracts/index.ts";
import { AppDatabase, assertSafePath } from "../app-data/db.ts";
import { AuthorizationPolicy } from "../auth/authorization.ts";
import { acquireHostLock, assertOperationalRoot } from "../operations/locks.ts";
import { manageIndex, requestIndexUpdate } from "./index.ts";
import {
  configureSearchProfile,
  getSearchProfile,
  recoverSearchDispatches,
  stopSearchProfile,
  budgetStatus,
} from "./profile.ts";

const common = ["root", "workspace", "actor", "room"];
export const searchFlags: Record<string, string[]> = {
  "search-status": common,
  "search-stop": common,
  "search-resume": common,
  "search-delete": common,
  "search-sync": common,
  "search-rebuild": common,
  "search-rollback": [...common, "generation"],
  "search-profile-set": [...common, "config"],
  "search-profile-stop": common,
};

function readConfig(path?: string): unknown {
  if (!path || !isAbsolute(path)) throw new AppError("INVALID_ARGUMENTS");
  assertSafePath(path, "file");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16_384)
      throw new AppError("INVALID_ARGUMENTS");
    return JSON.parse(readFileSync(fd, "utf8"));
  } finally {
    closeSync(fd);
  }
}

export async function runSearchCommand(
  app: AppDatabase,
  policy: AuthorizationPolicy,
  command: string,
  args: Record<string, string>,
) {
  if (!args.workspace || !args.actor || !args.room)
    throw new AppError("INVALID_ARGUMENTS");
  const binding = {
    workspaceId: args.workspace,
    actorId: args.actor,
    roomId: args.room,
  };
  const actor = { workspaceId: args.workspace, actorId: args.actor };
  const release = acquireHostLock(app.root);
  try {
    assertOperationalRoot(app.root);
    // This lock excludes live server and CLI dispatchers for the entire data root.
    recoverSearchDispatches(app);
    if (command === "search-status") {
      const profile = getSearchProfile(app, actor, args.room);
      return {
        ...manageIndex(app, binding, "status"),
        profile,
        budget: profile
          ? budgetStatus(app, actor, args.room, profile.version)
          : null,
      };
    }
    if (command === "search-delete") return manageIndex(app, binding, "delete");
    if (command === "search-stop") return manageIndex(app, binding, "stop");
    if (command === "search-resume") return manageIndex(app, binding, "resume");
    if (command === "search-profile-stop") {
      stopSearchProfile(app, actor, args.room);
      return { paused: true };
    }
    if (command === "search-profile-set")
      return configureSearchProfile(
        app,
        actor,
        args.room,
        readConfig(args.config),
      );
    if (command === "search-rollback" && !args.generation)
      throw new AppError("INVALID_ARGUMENTS");
    const generationId = await requestIndexUpdate(
      app,
      policy,
      actor,
      args.room,
      {
        force: true,
        rebuild: command === "search-rebuild",
        external: command !== "search-rollback",
        rollback: command === "search-rollback" ? args.generation : undefined,
      },
    );
    return { state: "ACTIVE", generationId };
  } finally {
    release();
  }
}
