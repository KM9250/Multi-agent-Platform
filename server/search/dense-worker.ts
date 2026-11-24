import { AppDatabase } from "../app-data/db.ts";
import { AuthorizationPolicy, type Actor } from "../auth/authorization.ts";
import { SQLiteSearchBackend } from "./backend.ts";
import { scanCorpus } from "./dense-corpus.ts";
import { assertDispatchScope, getSearchProfile } from "./profile.ts";
export interface DenseScanJob {
  root: string;
  appPath: string;
  indexPath: string;
  actor: Actor;
  roomId: string;
  idleTimeoutMs: number;
  profileVersion: number;
  query?: Float32Array;
}
process.once("message", (job: DenseScanJob) => {
  let app: AppDatabase | undefined, index: SQLiteSearchBackend | undefined;
  try {
    app = new AppDatabase({
      root: job.root,
      path: job.appPath,
      readOnly: true,
    });
    const policy = new AuthorizationPolicy(app, job.idleTimeoutMs);
    const profile = getSearchProfile(app, job.actor, job.roomId);
    if (!profile || profile.version !== job.profileVersion)
      throw Error("profile_changed_or_disabled");
    assertDispatchScope(
      app,
      policy,
      job.actor,
      job.roomId,
      profile,
      "QUERY_EMBEDDING",
      profile.scopes,
    );
    index = new SQLiteSearchBackend(job.indexPath, { readOnly: true });
    index.db.exec("BEGIN");
    const result = scanCorpus(
      app,
      policy,
      job.actor,
      job.roomId,
      index,
      profile,
      job.query,
    );
    process.send!({ result });
  } catch {
    process.send!({ error: "dense_unavailable" });
  } finally {
    index?.close();
    app?.close();
    process.disconnect();
  }
});
