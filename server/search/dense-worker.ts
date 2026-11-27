import { AppDatabase } from "../app-data/db.ts";
import { AuthorizationPolicy, type Actor } from "../auth/authorization.ts";
import { SQLiteSearchBackend } from "./backend.ts";
import { scanCorpus } from "./dense-corpus.ts";
import { assertDispatchScope, getSearchProfile } from "./profile.ts";
import { assertAiSearchBinding, type AiSearchBinding } from "./ai-binding.ts";
export interface DenseScanJob {
  root: string;
  appPath: string;
  indexPath: string;
  actor: Actor;
  roomId: string;
  idleTimeoutMs: number;
  profileVersion: number;
  query?: Float32Array;
  aiBinding?: AiSearchBinding;
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
    if (job.aiBinding) assertAiSearchBinding(app, policy, job.actor, job.roomId, job.aiBinding);
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
      job.aiBinding ? ["room_shared"] : profile.scopes,
    );
    index = new SQLiteSearchBackend(job.indexPath, { readOnly: true });
    index.db.exec("BEGIN");
    const result = scanCorpus(
      app,
      policy,
      job.actor,
      job.roomId,
      index,
      job.indexPath,
      profile,
      job.query,
      job.aiBinding,
    );
    process.send!({
      result: { state: result.state, candidates: result.candidates },
    });
  } catch {
    process.send!({ error: "dense_unavailable" });
  } finally {
    index?.close();
    app?.close();
    process.disconnect();
  }
});
