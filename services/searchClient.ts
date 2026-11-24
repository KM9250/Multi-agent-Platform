import { appRequest, roomPath } from "./appClient";
import type {
  CitationResponse,
  SearchCitation,
  SearchRequest,
  SearchResponse,
} from "../shared/search-contracts";

export function searchRoom(
  roomId: string,
  request: SearchRequest,
  signal: AbortSignal,
) {
  return appRequest<SearchResponse>(
    roomPath(roomId) + "/search",
    "POST",
    request,
    signal,
  );
}

export function openSearchCitation(
  roomId: string,
  citation: SearchCitation,
  includeHistory: boolean,
  surrounding: boolean,
  signal: AbortSignal,
) {
  return appRequest<CitationResponse>(
    roomPath(roomId) + "/search/citation",
    "POST",
    { citation, includeHistory, surrounding },
    signal,
  );
}
