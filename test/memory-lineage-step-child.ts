import { AppDatabase } from "../server/app-data/db.ts";
import { advanceLineage } from "../server/memory/lineage.ts";

// The host dies after committing one slice. Another DB handle must resume the same work.
const app = new AppDatabase({ root: process.argv[2] });
if (!advanceLineage(app)) throw new Error("No pending lineage");
process.kill(process.pid, "SIGKILL");
