import type { SearchDateRange, SearchResponse } from "./search-contracts.ts";
import type { SearchCitation } from "./search-sources.ts";

export type ContextMode = "auto" | "none" | "memory" | "archive" | "both";
export interface TurnContext {
  mode?: ContextMode;
  timeZone?: string;
  date?: {
    mode: "approx" | "strict";
    anchorDate: string;
    endDate?: string;
  };
}

/** Accepted once and retained with request_json, never recomputed on a retry. */
export interface ContextDateInterpretation {
  version: "map-context-date-v1";
  status: "none" | "resolved" | "ambiguous" | "needs_condition";
  source: "none" | "explicit" | "absolute_text" | "relative_text" | "year_missing";
  timeZone: string;
  range?: SearchDateRange;
}
export interface ContextRoute {
  version: "map-context-router-v1" | "map-context-router-v2";
  requestedMode: ContextMode;
  mode: Exclude<ContextMode, "auto">;
  reason: string;
  query: { version: "map-context-query-v1"; text: string; truncated: boolean };
  dateInterpretation: ContextDateInterpretation;
  requiresEvidence: boolean;
  requiresExactExcerpt: boolean;
  /** v2 separates faithful excerpts from an explicit request for the whole Source. */
  requiresFullSource?: boolean;
}
export interface ContextSource {
  alias: string;
  citation: SearchCitation;
  ownerPersonaId: string | null;
  scope: "room_shared" | "public";
  recordedAt: number;
  channel: string;
}
export interface ContextPermission {
  operation: "READ_MEMORY" | "READ_CONVERSATION";
  roomId: string;
  personaId: string;
  visibility: "room_shared" | "public";
  provider: "";
}
export interface ContextSearchEvidence {
  target: "memory" | "archive";
  requestId: string;
  status: SearchResponse["status"];
  methods: SearchResponse["methods"];
  reasons: string[];
  scope: SearchResponse["scope"];
  coverage: SearchResponse["coverage"] & { generation?: string };
  external: SearchResponse["external"];
  searchOperationIds: string[];
}
/** References only. Private ancestors and source text are never copied here. */
export interface ContextPlanManifest {
  id: string;
  actorId: string;
  workspaceId: string;
  roomId: string;
  runId: string;
  consumerPersonaId: string;
  purpose: "answer";
  audience: "room";
  provider: string;
  model: string;
  inputBinding: {
    messageId: string;
    revision: number;
    seq: number;
    excludeMessageId?: string;
  };
  roomRevision: number;
  personaRevision: number;
  aclRevision: number;
  route: ContextRoute;
  searches: ContextSearchEvidence[];
  sources: ContextSource[];
  permissions: ContextPermission[];
  packingVersion: "map-context-pack-v1";
  estimatorVersion: "utf8-bytes-div3-v1";
  estimatedTokens: number;
  /** Digest of only the deterministic retrieval envelope, including its source text. */
  payloadDigest: string;
}
export type ContextPlan = ContextPlanManifest;
