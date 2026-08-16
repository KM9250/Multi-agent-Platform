import { GoogleGenAI } from '@google/genai';
import type { SubAgentProvider, SubAgentProviderRequest, SubAgentProviderResponse } from './types';
import type { SubAgentProviderRegistry } from './providerRegistry';

export class GoogleSubAgentProvider implements SubAgentProvider {
  readonly id = 'google';
  constructor(private readonly apiKey: string, private readonly client = new GoogleGenAI({ apiKey })) {}

  async generate(request: SubAgentProviderRequest): Promise<SubAgentProviderResponse> {
    const started = Date.now();
    const response = await this.client.models.generateContent({
      model: request.model,
      contents: request.prompt,
      config: {
        systemInstruction: request.systemInstruction,
        responseMimeType: 'application/json',
        maxOutputTokens: request.maxOutputTokens,
        thinkingConfig: request.thinkingBudget === undefined ? undefined : { thinkingBudget: request.thinkingBudget },
        abortSignal: request.signal,
      },
    });
    return { text: response.text ?? '', provider: this.id, model: request.model, latencyMs: Date.now() - started };
  }
}

/** Explicit configuration avoids silently selecting Google for another provider ID. */
export const registerGoogleProvider = (registry: SubAgentProviderRegistry, apiKey: string): GoogleSubAgentProvider => {
  const provider = new GoogleSubAgentProvider(apiKey);
  registry.registerProvider(provider);
  return provider;
};
