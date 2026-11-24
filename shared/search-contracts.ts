import type { SearchCitation, ResolvedExcerpt } from "./search-sources.ts";
export type { SearchCitation } from "./search-sources.ts";

export type SearchTarget = "memory" | "archive";
export type RevisionMode = "current" | "include_history";
export interface SearchDate {
  mode: "strict" | "approx";
  anchorDate: string;
  timeZone: string;
  /** Inclusive last civil date for an explicit strict interval. */
  endDate?: string;
}
export interface SearchDateRange extends SearchDate {
  firstDate: string;
  lastDate: string;
  startInclusive: number;
  endExclusive: number;
}
export interface SearchRequest {
  requestId: string;
  target: SearchTarget;
  query: string;
  revisionMode?: RevisionMode;
  retrievalMode?: "auto" | "lexical" | "hybrid";
  personaId?: string;
  date?: SearchDate;
  limit?: number;
}

/** Trusted caller metadata. The HTTP boundary only constructs human searches. */
export type SearchAudience =
  | { purpose: "human"; roomId: string; scope: SearchTarget }
  | {
      purpose: "ai_context";
      consumerPersonaId: string;
      roomId: string;
      scope: SearchTarget;
      destination: string;
      externalPurpose: string;
    };

export interface SearchResult {
  citation: SearchCitation;
  snippet: string;
  recordedAt: number;
  personaId: string | null;
  speakerId: string | null;
  role: string;
  channel: string;
  visibility: string;
  current: boolean;
  revisionKind?: "original" | "correction" | "regeneration" | "revision";
  dateLayer?: "anchor" | "near3" | "near7";
}
export interface SearchResponse {
  results: SearchResult[];
  scope: {
    roomId: string;
    target: SearchTarget;
    revisionMode: RevisionMode;
    personaId?: string;
    date?: SearchDateRange;
  };
  coverage: {
    indexState: string;
    revisionMode: RevisionMode;
    planned: string[];
    syncedAt?: number;
    updating?: boolean;
    denseState?: string;
  };
  methods: ("lexical" | "dense" | "rerank")[];
  status:
    | "ready"
    | "partial"
    | "degraded"
    | "unbuilt"
    | "building"
    | "resync_required"
    | "stopped"
    | "unavailable";
  reasons: string[];
  elapsedMs: number;
  external: { status: string; calls?: number; usage?: unknown };
  verification: { checked: number; excluded: number };
}
export type CitationResponse = ResolvedExcerpt & {
  surrounding?: ResolvedExcerpt[];
};
