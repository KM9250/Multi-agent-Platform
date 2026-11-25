import { AppDatabase } from "../server/app-data/db.ts";
import { updateGeneration } from "../server/search/index-worker.ts";
import type { IndexJob } from "../server/search/index-registry.ts";
const job: IndexJob = JSON.parse(process.argv[2]),
  stage = process.argv[3];
const app = new AppDatabase({ root: job.root });
let pages = 0;
await updateGeneration(app, job, new AbortController().signal, (seen) => {
  if (seen !== stage) return;
  // Stream two is archive. A real process death leaves the active transaction/cursor at SQLite's boundary.
  if (stage.startsWith("PAGE_") && ++pages !== 2) return;
  process.exit(87);
});
process.exit(1);
