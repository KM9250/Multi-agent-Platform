/** Browser-safe references to the exact content a human reviewed. */
export const MEMORY_KINDS = [
  "unclassified",
  "semantic",
  "episodic",
  "procedural",
] as const;
export const ASSERTION_TYPES = [
  "unclassified",
  "user_assertion",
  "persona_subjective",
  "verified_record",
  "hypothesis",
] as const;
export const MEMORY_SCOPES = ["persona_private", "room_shared"] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];
export interface MemoryBinding {
  candidateId: string;
  revision: number;
  bodyDigest: string;
  sourcesDigest: string;
  ownerPersonaId: string;
  scope: MemoryScope;
  targetNoteId: string;
  targetVersion: number | null;
  targetDigest: string | null;
}
export interface MemoryCandidateDTO {
  /** This candidate depends on an answer that used an existing shared Note. */
  derivedFromMemory?: true;
  id: string;
  roomId: string;
  revision: number;
  body: string;
  kind: (typeof MEMORY_KINDS)[number];
  assertionType: (typeof ASSERTION_TYPES)[number];
  scope: MemoryScope;
  state: string;
  /** A held candidate is undergoing verification after migration. */
  rechecking?: true;
  ownerPersonaId: string;
  createdAt: number;
  sourceRefs: string[];
  provenance: {
    runId: string;
    callId: string;
    provider: string;
    model: string;
    generatedAt: number;
    manifestDigest: string;
  } | null;
  binding: MemoryBinding;
}

export interface MemoryChangeItem {
  changeId: string;
  noteId: string;
  version: number;
  digest: string;
  state: string;
  action: string;
}

export interface MemoryChangePage {
  mode: "baseline" | "delta";
  items: MemoryChangeItem[];
  hasMore: boolean;
  /** Persist with the applied page, including an empty checkpoint. */
  cursor: string;
}
