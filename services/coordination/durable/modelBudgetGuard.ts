import type { RunnerModelUsage } from '../runner/types';
import { DurableStoreError } from './integrity';
export interface ModelAmounts { llmCalls: number; inputTokens: number; outputTokens: number; costMicros: number }
export const zeroAmounts = (): ModelAmounts => ({ llmCalls: 0, inputTokens: 0, outputTokens: 0, costMicros: 0 });
export function safeAmount(n: number): number {
  if (!Number.isSafeInteger(n) || n < 0) throw new DurableStoreError('MODEL_INVALID_QUOTE');
  return n;
}
/** Decimal arithmetic avoids binary multiplication rounding the available budget up. */
export function costMicros(n: number, rounding: 'ceil' | 'floor' = 'ceil'): number {
  if (!Number.isFinite(n) || n < 0) throw new DurableStoreError('MODEL_INVALID_QUOTE');
  const [mantissa, exponent = '0'] = n.toString().toLowerCase().split('e');
  const [whole, fraction = ''] = mantissa.split('.');
  const digits = BigInt(whole + fraction), power = Number(exponent) - fraction.length + 6;
  const divisor = power < 0 ? 10n ** BigInt(-power) : 1n;
  const numerator = power >= 0 ? digits * 10n ** BigInt(power) : digits;
  const value = numerator / divisor + (rounding === 'ceil' && numerator % divisor !== 0n ? 1n : 0n);
  return safeAmount(Number(value));
}
export function usageAmounts(u: RunnerModelUsage): ModelAmounts {
  if (u.llmCalls !== 1) throw new DurableStoreError('MODEL_INVALID_USAGE');
  return { llmCalls: 1, inputTokens: safeAmount(u.inputTokens), outputTokens: safeAmount(u.outputTokens), costMicros: costMicros(u.estimatedCost) };
}
export function addAmounts(a: ModelAmounts, b: ModelAmounts): ModelAmounts {
  return Object.fromEntries(Object.keys(a).map(k => [k, safeAmount(a[k as keyof ModelAmounts] + b[k as keyof ModelAmounts])])) as unknown as ModelAmounts;
}
