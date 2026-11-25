import { createHash } from "node:crypto";

export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const EMBEDDING_SPACE = Object.freeze({
  provider: "google",
  model: "gemini-embedding-2",
  revision: "gemini-embedding-2",
  dimensions: 768,
  distance: "cosine",
  normalization: "unit-f32",
  templateVersion: "map-google-asymmetric-text-v1",
});
export const spaceId = hash(JSON.stringify(EMBEDDING_SPACE));
export type EmbeddingPurpose = "DOCUMENT_EMBEDDING" | "QUERY_EMBEDDING";
export type SearchPurpose = EmbeddingPurpose | "RERANK";
export interface SearchUsage {
  completeness: "COMPLETE" | "PARTIAL" | "UNKNOWN";
  unit: "input_token" | "rerank_search";
  quantity?: number;
}
export interface EmbeddingProvider {
  readonly spaceId: string;
  embed(request: {
    purpose: EmbeddingPurpose;
    text: string;
    signal: AbortSignal;
  }): Promise<{ vector: Float32Array; usage: SearchUsage }>;
}

export class DenseError extends Error {}
export function formattedInput(
  purpose: EmbeddingPurpose,
  text: string,
): string {
  if (!text || Buffer.byteLength(text) > 8192)
    throw new DenseError("input_limit");
  return purpose === "QUERY_EMBEDDING"
    ? `task: search result | query: ${text}`
    : `title: none | text: ${text}`;
}
export function unitVector(values: unknown): Float32Array {
  if (
    (!Array.isArray(values) && !(values instanceof Float32Array)) ||
    values.length !== EMBEDDING_SPACE.dimensions ||
    !values.every((n) => typeof n === "number" && Number.isFinite(n))
  )
    throw new DenseError("invalid_vector");
  const norm = Math.hypot(...values);
  if (!norm || !Number.isFinite(norm)) throw new DenseError("invalid_vector");
  return Float32Array.from(values, (n) => n / norm);
}

async function responseObject(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw new DenseError("invalid_response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if ((size += value.byteLength) > 128 * 1024) {
        await reader.cancel();
        throw new DenseError("response_limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export class GoogleEmbeddingProvider implements EmbeddingProvider {
  readonly spaceId = spaceId;
  constructor(
    private apiKey: string,
    private http: typeof fetch = fetch,
  ) {
    if (!apiKey) throw new DenseError("unconfigured_provider");
  }
  async embed({
    purpose,
    text,
    signal,
  }: Parameters<EmbeddingProvider["embed"]>[0]) {
    signal.throwIfAborted();
    const response = await this.http(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent",
      {
        method: "POST",
        redirect: "error",
        signal,
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": this.apiKey,
        },
        body: JSON.stringify({
          content: { parts: [{ text: formattedInput(purpose, text) }] },
          outputDimensionality: EMBEDDING_SPACE.dimensions,
        }),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new DenseError(
        [400, 401, 403, 404].includes(response.status)
          ? "provider_rejected"
          : "outcome_unknown",
      );
    }
    const body = await responseObject(response);
    if (body.embeddings !== undefined)
      throw new DenseError("invalid_vector_count");
    const vector = unitVector(body.embedding?.values);
    const quantity = body.usageMetadata?.promptTokenCount;
    const usage: SearchUsage =
      Number.isSafeInteger(quantity) && quantity >= 0
        ? { completeness: "COMPLETE", unit: "input_token", quantity }
        : {
            completeness:
              body.usageMetadata && Object.keys(body.usageMetadata).length
                ? "PARTIAL"
                : "UNKNOWN",
            unit: "input_token",
          };
    return { vector, usage };
  }
}

export interface AuthorizedRerankCandidate {
  id: string;
  text: string;
}
export interface Reranker {
  readonly maximumCandidates: number;
  rank(
    query: string,
    authorized: readonly AuthorizedRerankCandidate[],
    signal: AbortSignal,
  ): Promise<{
    ids: string[];
    used: boolean;
    usage?: SearchUsage;
  }>;
}
export function validateRanking(
  input: readonly string[],
  output: readonly string[],
  limit: number,
) {
  if (
    input.length > limit ||
    input.length !== new Set(input).size ||
    output.length !== input.length ||
    new Set(output).size !== input.length ||
    output.some((id) => !input.includes(id))
  )
    throw new DenseError("invalid_rerank_output");
}
export class DisabledReranker implements Reranker {
  readonly maximumCandidates = 100;
  async rank(
    query: string,
    authorized: readonly AuthorizedRerankCandidate[],
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    if (
      !query ||
      query.length > 2048 ||
      authorized.length > this.maximumCandidates ||
      authorized.some(
        (item) => !item.id || !item.text || item.text.length > 8192,
      )
    )
      throw new DenseError("rerank_input_limit");
    const ids = authorized.map((item) => item.id);
    validateRanking(ids, ids, this.maximumCandidates);
    return { ids: [...ids], used: false };
  }
}
