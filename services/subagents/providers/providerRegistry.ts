import type { SubAgentProvider } from './types';

export class ProviderNotConfiguredError extends Error {
  readonly code = 'PROVIDER_NOT_CONFIGURED';
  constructor(providerId: string) {
    super(`SubAgent provider is not configured: ${providerId}`);
    this.name = 'ProviderNotConfiguredError';
  }
}

export class SubAgentProviderRegistry {
  private readonly providers = new Map<string, SubAgentProvider>();

  registerProvider(provider: SubAgentProvider): void {
    if (!provider.id) throw new Error('Provider id is required');
    this.providers.set(provider.id, provider);
  }

  getProvider(providerId: string): SubAgentProvider {
    const provider = this.providers.get(providerId);
    if (!provider) throw new ProviderNotConfiguredError(providerId);
    return provider;
  }
}

export const subAgentProviderRegistry = new SubAgentProviderRegistry();
export const registerProvider = (provider: SubAgentProvider): void => subAgentProviderRegistry.registerProvider(provider);
export const getProvider = (id: string): SubAgentProvider => subAgentProviderRegistry.getProvider(id);
