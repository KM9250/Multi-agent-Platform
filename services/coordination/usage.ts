import type { ProgressRecordedPayload, UsageRecordedPayload, WorkflowUsage } from './types';

export const emptyWorkflowUsage = (): WorkflowUsage => ({
  rounds: 0, llmCalls: 0, inputTokens: 0, outputTokens: 0, estimatedCost: 0,
  consecutiveErrors: 0, noProgressCycles: 0,
});

const safeSum = (left: number, right: number, name: string): number => {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new Error(`${name} usage overflow.`);
  return result;
};

export const validateUsagePayload = (payload: UsageRecordedPayload): UsageRecordedPayload => {
  if (!payload || !Number.isSafeInteger(payload.llmCalls) || payload.llmCalls < 1) throw new Error('llmCalls must be a positive safe integer.');
  if (!Number.isSafeInteger(payload.inputTokens) || payload.inputTokens < 0) throw new Error('inputTokens must be a non-negative safe integer.');
  if (!Number.isSafeInteger(payload.outputTokens) || payload.outputTokens < 0) throw new Error('outputTokens must be a non-negative safe integer.');
  if (!Number.isFinite(payload.estimatedCost) || payload.estimatedCost < 0) throw new Error('estimatedCost must be finite and non-negative.');
  const sourceRef = payload.sourceRef?.trim();
  if (payload.sourceRef !== undefined && !sourceRef) throw new Error('sourceRef cannot be empty.');
  return { ...payload, ...(sourceRef ? { sourceRef } : {}) };
};

export const applyUsageDelta = (current: WorkflowUsage, input: UsageRecordedPayload): WorkflowUsage => {
  const payload = validateUsagePayload(input);
  const estimatedCost = current.estimatedCost + payload.estimatedCost;
  if (!Number.isFinite(estimatedCost)) throw new Error('estimatedCost usage overflow.');
  return { ...current, llmCalls: safeSum(current.llmCalls, payload.llmCalls, 'llmCalls'),
    inputTokens: safeSum(current.inputTokens, payload.inputTokens, 'inputTokens'),
    outputTokens: safeSum(current.outputTokens, payload.outputTokens, 'outputTokens'), estimatedCost };
};

export const validateProgressPayload = (payload: ProgressRecordedPayload): ProgressRecordedPayload => {
  if (!payload || !['PROGRESS', 'NO_PROGRESS', 'ERROR'].includes(payload.outcome)) throw new Error('Progress outcome is invalid.');
  const summary = payload.summary?.trim(); if (!summary) throw new Error('Progress summary is required.');
  if (payload.evidenceEventIds !== undefined && !Array.isArray(payload.evidenceEventIds)) throw new Error('evidenceEventIds must be an array.');
  const evidenceEventIds = payload.evidenceEventIds?.map(id => id.trim());
  if (evidenceEventIds?.some(id => !id) || evidenceEventIds && new Set(evidenceEventIds).size !== evidenceEventIds.length) throw new Error('evidenceEventIds must be non-empty and unique.');
  return { ...payload, summary, ...(evidenceEventIds ? { evidenceEventIds } : {}) };
};

export const applyProgress = (current: WorkflowUsage, input: ProgressRecordedPayload): WorkflowUsage => {
  const payload = validateProgressPayload(input); const rounds = safeSum(current.rounds, 1, 'rounds');
  if (payload.outcome === 'PROGRESS') return { ...current, rounds, consecutiveErrors: 0, noProgressCycles: 0 };
  const noProgressCycles = safeSum(current.noProgressCycles, 1, 'noProgressCycles');
  if (payload.outcome === 'NO_PROGRESS') return { ...current, rounds, consecutiveErrors: 0, noProgressCycles };
  return { ...current, rounds, consecutiveErrors: safeSum(current.consecutiveErrors, 1, 'consecutiveErrors'), noProgressCycles };
};
