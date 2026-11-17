/** Server-only provider port. No SDK, scheduler or transparent HTTP retries. */
export interface ProviderRequest {
  model: string;
  purpose: "decision" | "subagent" | "answer" | "memory";
  systemInstruction: string;
  contents: Array<{
    role: "user" | "model";
    parts: Array<
      { text: string } | { inlineData: { mimeType: string; data: string } }
    >;
  }>;
  maxOutputTokens: number;
  signal: AbortSignal;
  structured: boolean;
}
export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  thoughtsTokens?: number;
  cachedInputTokens?: number;
  totalTokens?: number;
  completeness: "COMPLETE" | "PARTIAL" | "UNKNOWN";
  semantics: string;
}
export interface ProviderResult {
  text: string;
  finish: "STOP" | "SAFETY" | "INCOMPLETE" | "REJECTED";
  usage: ProviderUsage;
}
export interface ProviderAdapter {
  readonly name: string;
  readonly available?: boolean;
  supports(model: string): boolean;
  generate(request: ProviderRequest): Promise<ProviderResult>;
}
export class ProviderError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
function count(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : undefined;
}
export class GeminiProvider implements ProviderAdapter {
  readonly name = "google";
  private readonly models: Set<string>;
  private readonly fetcher: typeof fetch;
  constructor(
    private readonly options: {
      apiKey: string;
      allowedModels: string[];
      fetch?: typeof fetch;
    },
  ) {
    if (
      !options.apiKey ||
      !options.allowedModels.length ||
      options.allowedModels.some(
        (m) => !/^gemini-[a-zA-Z0-9._-]{1,100}$/.test(m),
      )
    )
      throw new ProviderError("PROVIDER_CONFIGURATION");
    this.models = new Set(options.allowedModels);
    this.fetcher = options.fetch ?? fetch;
  }
  supports(model: string) {
    return this.models.has(model);
  }
  async generate(request: ProviderRequest): Promise<ProviderResult> {
    if (!this.supports(request.model))
      throw new ProviderError("MODEL_NOT_ALLOWED");
    // The key is only in a header; no URL, logs, error messages or browser DTOs.
    const response = await this.fetcher(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(request.model)}:generateContent`,
      {
        method: "POST",
        redirect: "error",
        signal: request.signal,
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": this.options.apiKey,
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: request.systemInstruction }] },
          contents: request.contents,
          generationConfig: {
            maxOutputTokens: request.maxOutputTokens,
            ...(request.structured
              ? { responseMimeType: "application/json" }
              : {}),
          },
        }),
      },
    );
    if (!response.ok) {
      // Explicit rejection is distinct from a transport failure; do not expose provider body.
      if ([400, 401, 403, 404, 429].includes(response.status))
        return {
          text: "",
          finish: "REJECTED",
          usage: {
            completeness: "UNKNOWN",
            semantics: "gemini-v1beta-usageMetadata",
          },
        };
      throw new ProviderError("PROVIDER_OUTCOME_UNKNOWN");
    }
    // Bounded body even when the server ignores Content-Length.
    const reader = response.body?.getReader();
    if (!reader) throw new ProviderError("PROVIDER_OUTCOME_UNKNOWN");
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1_048_576) {
          await reader.cancel();
          throw new ProviderError("PROVIDER_RESPONSE_TOO_LARGE");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    let object: any;
    try {
      object = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new ProviderError("PROVIDER_INVALID_RESPONSE");
    }
    const u = object?.usageMetadata ?? {};
    const usage: ProviderUsage = {
      inputTokens: count(u.promptTokenCount),
      outputTokens: count(u.candidatesTokenCount),
      thoughtsTokens: count(u.thoughtsTokenCount),
      cachedInputTokens: count(u.cachedContentTokenCount),
      totalTokens: count(u.totalTokenCount),
      completeness: "PARTIAL",
      semantics:
        "gemini-v1beta-usageMetadata: candidates excludes thoughts; cached is subset of prompt",
    };
    usage.completeness =
      usage.inputTokens !== undefined &&
      usage.outputTokens !== undefined &&
      usage.totalTokens !== undefined &&
      usage.totalTokens ===
        usage.inputTokens + usage.outputTokens + (usage.thoughtsTokens ?? 0) &&
      (usage.cachedInputTokens === undefined ||
        usage.cachedInputTokens <= usage.inputTokens)
        ? "COMPLETE"
        : Object.values(u).length
          ? "PARTIAL"
          : "UNKNOWN";
    // Missing provider counters remain absent, never synthetic zero or undefined JSON tokens.
    for (const key of [
      "inputTokens",
      "outputTokens",
      "thoughtsTokens",
      "cachedInputTokens",
      "totalTokens",
    ] as const) {
      if (usage[key] === undefined) delete usage[key];
    }
    const candidate =
      Array.isArray(object?.candidates) && object.candidates.length === 1
        ? object.candidates[0]
        : undefined;
    const parts = candidate?.content?.parts;
    // Never request or collect provider-hidden thoughts. Explicit text only.
    const text = Array.isArray(parts)
      ? parts
          .filter((p) => p && typeof p.text === "string" && !p.thought)
          .map((p) => p.text)
          .join("")
      : "";
    const reason = candidate?.finishReason;
    return {
      text,
      usage,
      finish:
        object?.promptFeedback?.blockReason ||
        [
          "SAFETY",
          "RECITATION",
          "BLOCKLIST",
          "PROHIBITED_CONTENT",
          "SPII",
        ].includes(reason)
          ? "SAFETY"
          : reason === "STOP"
            ? "STOP"
            : "INCOMPLETE",
    };
  }
}
/** Explicitly synthetic; never selected implicitly when a real provider is missing. */
export class FakeProvider implements ProviderAdapter {
  readonly name = "synthetic";
  readonly calls: ProviderRequest[] = [];
  constructor(
    private readonly responder?: (
      request: ProviderRequest,
      index: number,
    ) => Promise<ProviderResult> | ProviderResult,
  ) {}
  supports(model: string) {
    return model === "synthetic";
  }
  async generate(request: ProviderRequest): Promise<ProviderResult> {
    this.calls.push(
      structuredClone({ ...request, signal: undefined }) as ProviderRequest,
    );
    if (this.responder) return this.responder(request, this.calls.length);
    const text =
      request.purpose === "decision"
        ? "RESPOND"
        : request.purpose === "memory"
          ? JSON.stringify({
              memory_export: [
                {
                  visibility: "self_only",
                  content: "Synthetic memory; Vault unpublished.",
                },
              ],
            })
          : request.purpose === "subagent"
            ? "Synthetic private worker summary."
            : request.structured
              ? JSON.stringify({ public_message: "Synthetic server response." })
              : "Synthetic server response.";
    return {
      text,
      finish: "STOP",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        completeness: "COMPLETE",
        semantics: "synthetic-v1",
      },
    };
  }
}

/** Saving conversations works before the host has configured paid provider access. */
export class UnavailableProvider implements ProviderAdapter {
  readonly name = "google";
  readonly available = false;
  supports(model: string) {
    return typeof model === "string" && model.length > 0 && model.length <= 120;
  }
  async generate(_request: ProviderRequest): Promise<ProviderResult> {
    throw new ProviderError("PROVIDER_NOT_CONFIGURED");
  }
}
