import { AppError } from "../../shared/app-contracts/index.ts";
import type { SearchCitation } from "../../shared/search-sources.ts";
import { integer, object, string } from "../app-data/validation.ts";

/** Pure closed DTO validation; independent of live source readers and NOTE lineage. */
export function parseCitation(value: unknown): SearchCitation {
  const common = ["workspaceId", "roomId", "target", "version", "start", "end"];
  const type = (value as Partial<SearchCitation> | null)?.target;
  const extra = type === "memory" ? ["noteId", "fileDigest", "bodyDigest"]
    : type === "archive" ? ["messageId", "revisionId", "segmentId", "segmentDigest"] : [];
  const x = object(value, [...common, ...extra]);
  if (!extra.length) throw new AppError("INVALID_INPUT");
  for (const key of ["workspaceId", "roomId", ...extra]) {
    const v = string(x[key], 128);
    if (key.endsWith("Digest") && !/^[a-f0-9]{64}$/.test(v)) throw new AppError("INVALID_INPUT");
  }
  integer(x.version);
  integer(x.start, 0);
  integer(x.end, x.start + 1);
  if (x.end - x.start > 4096) throw new AppError("INVALID_CITATION_RANGE", 400);
  return x as SearchCitation;
}
