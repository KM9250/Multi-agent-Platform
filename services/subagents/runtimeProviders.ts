import { SubAgentProviderRegistry } from './providers/providerRegistry';
import { registerGoogleProvider } from './providers/googleProvider';
import type { RequestScheduler } from '../scheduler';
export function createRuntimeSubAgentProviderRegistry(apiKey = process.env.API_KEY, scheduler?: RequestScheduler): SubAgentProviderRegistry { const registry = new SubAgentProviderRegistry(); if (apiKey) registerGoogleProvider(registry, apiKey, scheduler); return registry; }
