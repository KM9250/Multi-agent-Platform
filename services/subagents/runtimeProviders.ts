import { SubAgentProviderRegistry } from './providers/providerRegistry';
import { registerGoogleProvider } from './providers/googleProvider';
export function createRuntimeSubAgentProviderRegistry(apiKey = process.env.API_KEY): SubAgentProviderRegistry { const registry = new SubAgentProviderRegistry(); if (apiKey) registerGoogleProvider(registry, apiKey); return registry; }
