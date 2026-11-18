import { writeSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { AppDatabase } from "../server/app-data/db.ts";
import { AuthorizationPolicy } from "../server/auth/authorization.ts";
import { ConversationRepository } from "../server/app-data/repository.ts";
import { GenerationCoordinator } from "../server/generation/coordinator.ts";
import { FakeProvider } from "../server/generation/provider.ts";
import { AttachmentStore } from "../server/attachments/store.ts";

const [root, boundary, roomId, runId] = process.argv.slice(2);
function stop(phase: string, when: string) {
  if (boundary !== `${phase}:${when}`) return;
  writeSync(1, "BOUNDARY\n");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
const app = new AppDatabase({
  root,
  hooks: {
    beforeCommit: (phase) => stop(phase, "before"),
    afterCommit: (phase) => stop(phase, "after"),
  },
});
if (boundary.startsWith("attachment:")) {
  const policy = new AuthorizationPolicy(app),
    actor = { actorId: "synthetic-actor", workspaceId: "synthetic-workspace" };
  const attachments = new AttachmentStore(app, policy, {
    hooks: {
      afterStaging: () => stop("attachment", "afterStaging"),
      afterFileCommit: () => stop("attachment", "afterFileCommit"),
    },
  });
  await attachments.upload(actor, roomId, {
    name: "synthetic.txt",
    mimeType: "text/plain",
    data: Buffer.from("synthetic attachment crash data"),
  });
}
if (boundary.startsWith("generation:") || boundary === "race") {
  const policy = new AuthorizationPolicy(app),
    repository = new ConversationRepository(app, policy),
    actor = { actorId: "synthetic-actor", workspaceId: "synthetic-workspace" };
  const provider = new FakeProvider((request) => {
    appendFileSync(join(root, "synthetic-provider-count"), "sent\n", {
      mode: 0o600,
    });
    stop("generation", "providerSent");
    return {
      text: "Crash-boundary synthetic saved answer.",
      finish: "STOP",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        completeness: "COMPLETE",
        semantics: "synthetic-v1",
      },
    };
  });
  const names = [
    "beforeAcceptCommit",
    "afterAcceptCommit",
    "beforeIntentCommit",
    "afterIntentCommit",
    "afterProviderResponse",
    "beforeResultCommit",
    "afterResultCommit",
  ] as const;
  const hooks = Object.fromEntries(
    names.map((name) => [name, () => stop("generation", name)]),
  );
  const generation = new GenerationCoordinator(app, repository, policy, {
    provider,
    defaultModel: "synthetic",
    hooks,
  });
  if (boundary.includes("AcceptCommit"))
    generation.accept(actor, roomId, {
      requestId: "crash-request",
      expectedRoomRevision: 1,
      content: "Synthetic crash input",
      recipient: { type: "all" },
    });
  else await generation.execute(runId);
}
if (boundary.startsWith("atomic:"))
  app.transaction(() => {
    app.db.prepare("INSERT INTO workspaces VALUES('crash-workspace',1)").run();
    app.db
      .prepare(
        "INSERT INTO principals VALUES('crash-actor','crash-workspace',1)",
      )
      .run();
    app.audit("crash-actor", "crash-workspace", "CRASH_FIXTURE", "synthetic");
  }, "atomic");
app.close();
