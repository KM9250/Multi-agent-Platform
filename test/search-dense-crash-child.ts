import { AppDatabase } from "../server/app-data/db.ts";
import { AuthorizationPolicy } from "../server/auth/authorization.ts";
import {
  dispatchEmbedding,
  getSearchProfile,
} from "../server/search/profile.ts";
import { spaceId } from "../server/search/embedding.ts";
const [root, roomId, workspaceId, actorId, phase] = process.argv.slice(2);
const app = new AppDatabase({
  root,
  hooks: {
    afterCommit(name) {
      if (name === phase) process.exit(27);
    },
  },
});
const policy = new AuthorizationPolicy(app),
  actor = { workspaceId, actorId };
const profile = getSearchProfile(app, actor, roomId)!;
await dispatchEmbedding(
  app,
  policy,
  {
    spaceId,
    async embed() {
      process.exit(28);
    },
  },
  {
    actor,
    roomId,
    profile,
    scopes: profile.scopes,
    purpose: "QUERY_EMBEDDING",
    operationKey: phase,
    readText: () => "fixture",
    signal: new AbortController().signal,
  },
);
