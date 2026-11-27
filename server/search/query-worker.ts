import { AppError } from "../../shared/app-contracts/index.ts";
import { AppDatabase } from "../app-data/db.ts";
import { AuthorizationPolicy, type Actor } from "../auth/authorization.ts";
import { SQLiteSearchBackend } from "./backend.ts";
import { SearchSources } from "./sources.ts";
import type { SearchTarget } from "../../shared/search-contracts.ts";
import type { AiSearchBinding } from "./ai-binding.ts";

export interface LexicalJob {
  root: string;
  appPath: string;
  indexPath: string;
  actor: Actor;
  idleTimeoutMs: number;
  roomId: string;
  query: string;
  cursor: string;
  target: SearchTarget;
  includeHistory: boolean;
  personaId?: string;
  from?: number;
  until?: number;
  aiBinding?: AiSearchBinding;
}
const accessCodes = new Set(["FORBIDDEN", "UNAUTHENTICATED", "NOT_FOUND", "RUN_NOT_ACTIVE", "CONTEXT_CHANGED", "INVALID_AI_CONTEXT_BINDING"]);

function freshness(sources: SearchSources, job: LexicalJob) {
  try {
    return sources.hasUnindexedChanges(job.target, job.cursor);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (accessCodes.has(code)) throw error;
    if (code === "SEARCH_RESYNC_REQUIRED" || code === "MEMORY_RESYNC_REQUIRED")
      throw new AppError("SEARCH_CURSOR_INVALID", 409);
    throw new AppError("SEARCH_FRESHNESS_UNAVAILABLE", 503);
  }
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
    const sources = new SearchSources(app, policy, job.actor, job.roomId, job.aiBinding);
    index = new SQLiteSearchBackend(job.indexPath, { readOnly: true });
    const result = sources.withCandidateSnapshot(job.target, () => {
      const lagging = freshness(sources, job);
      const candidates = index!.query({
        query: job.query,
        target: job.target,
        includeHistory: job.includeHistory,
        personaId: job.personaId,
        from: job.from,
        until: job.until,
        scopeLocalRanking: !!job.aiBinding,
        limit: 100,
        allowsScope: sources.allowsScope.bind(sources),
        eligible: sources.eligible.bind(sources),
      });
      return { ...candidates, lagging };
    });
    process.send!({ result });
  } catch (e) {
    const code = (e as { code?: string }).code;
    process.send!({
      error:
        accessCodes.has(code) ||
        code === "SEARCH_CURSOR_INVALID" ||
        code === "SEARCH_FRESHNESS_UNAVAILABLE"
          ? code
          : "INDEX_UNAVAILABLE",
    });
  } finally {
    index?.close();
    app?.close();
    process.disconnect();
  }
});
