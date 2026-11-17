import { mkdtempSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../server/app-data/db.ts";
import {
  AuthorizationPolicy,
  PUBLIC_USER_OPERATIONS,
} from "../server/auth/authorization.ts";
import { ConversationRepository } from "../server/app-data/repository.ts";
import { GenerationCoordinator } from "../server/generation/coordinator.ts";
import { FakeProvider } from "../server/generation/provider.ts";

/** Host-created synthetic identities; HTTP/browser tests separately exercise the real KDF/login. */
export function appFixture() {
  const root = mkdtempSync(join(tmpdir(), "map-data-fixture-"));
  chmodSync(root, 0o700);
  const app = new AppDatabase({ root }),
    policy = new AuthorizationPolicy(app),
    actor = { actorId: "synthetic-actor", workspaceId: "synthetic-workspace" };
  app.db.prepare("INSERT INTO workspaces VALUES(?,1)").run(actor.workspaceId);
  app.db
    .prepare("INSERT INTO principals VALUES(?,?,1)")
    .run(actor.actorId, actor.workspaceId);
  for (const operation of PUBLIC_USER_OPERATIONS)
    policy.grant(actor.actorId, actor.workspaceId, operation);
  const repository = new ConversationRepository(app, policy);
  const room = repository.createRoom(actor, { title: "Synthetic fixture" });
  const persona = repository.createPersona(actor, room.id, {
    name: "Synthetic persona",
    model: "synthetic",
  });
  const provider = new FakeProvider(),
    generation = new GenerationCoordinator(app, repository, policy, {
      provider,
      defaultModel: "synthetic",
    });
  return {
    root,
    app,
    policy,
    actor,
    repository,
    room,
    persona,
    provider,
    generation,
    dispose() {
      try {
        app.close();
      } catch {}
      rmSync(root, { recursive: true, force: true });
    },
  };
}
