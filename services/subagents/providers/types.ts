export interface SubAgentProviderRequest {
  model: string;
  systemInstruction: string;
  prompt: string;
  thinkingBudget?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export interface SubAgentProviderResponse {
  text: string;
  provider: string;
  model: string;
  latencyMs: number;
}

export interface SubAgentProvider {
  id: string;
  generate(request: SubAgentProviderRequest): Promise<SubAgentProviderResponse>;
}
