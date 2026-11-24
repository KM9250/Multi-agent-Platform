import { AppDatabase } from "../app-data/db.ts";
import { AuthorizationPolicy, type Actor } from "../auth/authorization.ts";
import { SQLiteSearchBackend } from "./backend.ts";
import { SearchSources } from "./sources.ts";
import type { SearchTarget } from "../../shared/search-contracts.ts";

export interface LexicalJob {
  root: string;
  appPath: string;
  indexPath: string;
  actor: Actor;
  idleTimeoutMs: number;
  roomId: string;
  query: string;
  target: SearchTarget;
  includeHistory: boolean;
  personaId?: string;
  from?: number;
  until?: number;
}
process.once("message", (job: LexicalJob) => {
  let app: AppDatabase | undefined, index: SQLiteSearchBackend | undefined;
  try {
    app = new AppDatabase({
      root: job.root,
      path: job.appPath,
      readOnly: true,
    });
    const policy = new AuthorizationPolicy(app, job.idleTimeoutMs);
    const sources = new SearchSources(app, policy, job.actor, job.roomId);
    index = new SQLiteSearchBackend(job.indexPath, { readOnly: true });
    const result = sources.withCandidateSnapshot(job.target, () =>
      index!.query({
        query: job.query,
        target: job.target,
        includeHistory: job.includeHistory,
        personaId: job.personaId,
        from: job.from,
        until: job.until,
        limit: 100,
        allowsScope: sources.allowsScope.bind(sources),
        eligible: sources.eligible.bind(sources),
      }),
    );
    process.send!({ result });
  } catch (e) {
    const code = (e as { code?: string }).code;
    process.send!({
      error: ["FORBIDDEN", "UNAUTHENTICATED", "NOT_FOUND"].includes(code)
        ? code
        : "INDEX_UNAVAILABLE",
    });
  } finally {
    index?.close();
    app?.close();
    process.disconnect();
  }
});
