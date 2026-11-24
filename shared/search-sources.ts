/** Business identifiers only. A reference or byte digest never grants read access. */
interface SourceBinding {
  workspaceId: string;
  roomId: string;
  version: number;
}

export interface MemoryRef extends SourceBinding {
  target: "memory";
  noteId: string;
  fileDigest: string;
  bodyDigest: string;
}

export interface ArchiveRef extends SourceBinding {
  target: "archive";
  messageId: string;
  revisionId: string;
  segmentId: string;
  segmentDigest: string;
}

export type SourceRef = MemoryRef | ArchiveRef;
export type SearchTarget = SourceRef["target"];
/** Half-open UTF-16 offsets into one original segment or parsed Markdown body. */
export type SearchCitation = SourceRef & { start: number; end: number };
export type Citation = SearchCitation;

export interface SourceMetadata {
  personaId: string | null;
  speakerId: string | null;
  visibility: string;
  channel: string;
  role: string;
  recordedAt: number;
  current: boolean;
}

export interface SearchSource extends SourceBinding, SourceMetadata {
  target: SearchTarget;
  sourceId: string;
  groupId: string;
  ref: SourceRef;
  text: string;
}
export type SourceDocument = SearchSource;

export interface ResolvedExcerpt extends SourceMetadata {
  citation: SearchCitation;
  text: string;
}

export interface SourcePage {
  mode: "baseline" | "delta";
  cursor: string;
  hasMore: boolean;
  deletes: string[];
  upserts: SearchSource[];
}

export interface MemorySourceReader {
  memoryPage(after?: string): SourcePage;
  read(ref: MemoryRef): SearchSource;
}

export interface ArchiveSourceReader {
  archivePage(after?: string): SourcePage;
  read(ref: ArchiveRef, includeHistory?: boolean): SearchSource;
}

export interface CitationResolver {
  resolve(
    citation: SearchCitation,
    options?: {
      includeHistory?: boolean;
      surrounding?: number;
    },
  ): ResolvedExcerpt & { surrounding: ResolvedExcerpt[] };
}
