import type { CoordinationPolicy, RiskDecision, WorkflowBudget, WorkflowUsage } from './types';

const POSITIVE_BUDGET_FIELDS: (keyof WorkflowBudget)[] = [
  'maxWallTimeMs', 'maxRounds', 'maxLlmCalls', 'maxInputTokens', 'maxOutputTokens',
  'maxEstimatedCost', 'maxConsecutiveErrors', 'maxNoProgressCycles',
];

export const validatePolicy = (policy: CoordinationPolicy): void => {
  if (!policy.policyId.trim() || !policy.version.trim()) throw new Error('Policy identity and version are required.');
  for (const field of POSITIVE_BUDGET_FIELDS) {
    const value = policy.budgets[field];
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${field} must be a finite positive value.`);
  }
  if (!Number.isInteger(policy.schedulerRules.sameModelConcurrency) || policy.schedulerRules.sameModelConcurrency <= 0) {
    throw new Error('sameModelConcurrency must be a positive integer.');
  }
  if (!Number.isInteger(policy.retryRules.maxAttempts) || policy.retryRules.maxAttempts <= 0) {
    throw new Error('maxAttempts must be a positive integer.');
  }
};

/** Unknown action classes always fail closed to human review. */
export const evaluateRisk = (policy: CoordinationPolicy, actionClass: string): RiskDecision =>
  policy.riskRules[actionClass] ?? 'NEEDS_USER';

export const findExhaustedBudget = (
  budget: WorkflowBudget,
  usage: WorkflowUsage,
  elapsedMs: number,
): keyof WorkflowBudget | undefined => {
  if (elapsedMs >= budget.maxWallTimeMs) return 'maxWallTimeMs';
  if (usage.rounds >= budget.maxRounds) return 'maxRounds';
  if (usage.llmCalls >= budget.maxLlmCalls) return 'maxLlmCalls';
  if (usage.inputTokens >= budget.maxInputTokens) return 'maxInputTokens';
  if (usage.outputTokens >= budget.maxOutputTokens) return 'maxOutputTokens';
  if (usage.estimatedCost >= budget.maxEstimatedCost) return 'maxEstimatedCost';
  if (usage.consecutiveErrors >= budget.maxConsecutiveErrors) return 'maxConsecutiveErrors';
  if (usage.noProgressCycles >= budget.maxNoProgressCycles) return 'maxNoProgressCycles';
  return undefined;
};
