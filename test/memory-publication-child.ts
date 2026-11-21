import { AppDatabase } from "../server/app-data/db.ts";
import { AuthorizationPolicy } from "../server/auth/authorization.ts";
import { publishNext } from "../server/memory/worker.ts";

import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const [root, boundary, participant] = process.argv.slice(2);
const app = new AppDatabase({ root });
const stop = () => process.kill(process.pid, "SIGKILL");
// Both processes must have selected the same pending row before either may acquire the writer.
function meetOtherPublisher() {
  const other = participant === "one" ? "two" : "one";
  writeFileSync(join(root, "ready-" + participant), "selected", { flag: "wx" });
  const deadline = Date.now() + 10000;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(join(root, "ready-" + other))) {
    if (Date.now() >= deadline) throw new Error("Missing concurrent selection");
    Atomics.wait(wait, 0, 0, 10);
  }
}
const hooks = boundary
  ? { [boundary]: stop }
  : participant
    ? { afterSelection: meetOtherPublisher }
    : undefined;
publishNext(app, new AuthorizationPolicy(app), hooks);
app.close();
