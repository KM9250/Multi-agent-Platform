import { createTestDurableModelAdapter } from '../services/coordination/durable/modelCallCoordinator.ts';
import type { RunnerSupervisorProvider } from '../services/coordination/runner/types.ts';
export const testModel = (provider:RunnerSupervisorProvider,providerId='test') => createTestDurableModelAdapter(provider,{
 providerId,modelId:'test',inputTokens:1,maxOutputTokens:1,maxEstimatedCost:0,pricingId:'fixture-zero-cost',conditions:'in-memory-single-attempt',
});
