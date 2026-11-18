import { readFileSync, writeSync } from "node:fs";
import { AppDatabase } from "../server/app-data/db.ts";
import { AuthorizationPolicy } from "../server/auth/authorization.ts";
import { ConversationRepository } from "../server/app-data/repository.ts";
import { AttachmentStore } from "../server/attachments/store.ts";
import { ImportService } from "../server/operations/import.ts";
const [root, inputPath, boundary] = process.argv.slice(2);
function stop(name: string) {
  if (boundary !== name) return;
  writeSync(1, "IMPORT_BOUNDARY\n");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
const app = new AppDatabase({
    root,
    hooks: {
      beforeCommit: (phase) => stop(`${phase}:before`),
      afterCommit: (phase) => stop(`${phase}:after`),
    },
  }),
  policy = new AuthorizationPolicy(app),
  repo = new ConversationRepository(app, policy),
  attachments = new AttachmentStore(app, policy);
const service = new ImportService(app, repo, attachments, policy, {
  afterItem(kind) {
    if (kind === "message") stop("message:item");
  },
});
await service.start(
  { actorId: "a", workspaceId: "w" },
  JSON.parse(readFileSync(inputPath, "utf8")),
);
app.close();
