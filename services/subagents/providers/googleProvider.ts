import { GoogleGenAI } from '@google/genai';
import type { SubAgentProvider, SubAgentProviderRequest, SubAgentProviderResponse } from './types';
import type { SubAgentProviderRegistry } from './providerRegistry';
import type { RequestScheduler } from '../../scheduler';

export class GoogleSubAgentProvider implements SubAgentProvider {
  readonly id = 'google';
  constructor(private readonly apiKey: string, private readonly client = new GoogleGenAI({ apiKey }), private readonly scheduler?: RequestScheduler) {}

  async generate(request: SubAgentProviderRequest): Promise<SubAgentProviderResponse> {
    const started = Date.now();
    const execute = () => this.client.models.generateContent({
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
    const response = this.scheduler
      ? await this.scheduler.schedule({ provider: this.id, model: request.model, kind: 'subagent', signal: request.signal, execute })
      : await execute();
    return { text: response.text ?? '', provider: this.id, model: request.model, latencyMs: Date.now() - started };
  }
}

/** Explicit configuration avoids silently selecting Google for another provider ID. */
export const registerGoogleProvider = (registry: SubAgentProviderRegistry, apiKey: string, scheduler?: RequestScheduler): GoogleSubAgentProvider => {
  const provider = new GoogleSubAgentProvider(apiKey, undefined, scheduler);
  registry.registerProvider(provider);
  return provider;
};
