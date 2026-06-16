export type GenerationOutcome = 'SUCCESS' | 'ERROR' | 'ABORTED';

export interface GenerationResult {
  outcome: GenerationOutcome;
  text: string;
  latencyMs: number;
  finishReason?: string;
  finishMessage?: string;
  errorCode?: string;
  errorDetail?: string;
}

interface FinishMetadata {
  finishReason?: string;
  finishMessage?: string;
  safetyRatings?: unknown;
  promptFeedback?: unknown;
}

export const getFinishMetadata = (value: unknown): FinishMetadata => {
  if (!value || typeof value !== 'object') return {};
  const record = value as Record<string, unknown>;
  const candidate = Array.isArray(record.candidates) ? record.candidates[0] as Record<string, unknown> | undefined : undefined;
  return {
    finishReason: typeof record.finishReason === 'string' ? record.finishReason : (typeof candidate?.finishReason === 'string' ? candidate.finishReason : undefined),
    finishMessage: typeof record.finishMessage === 'string' ? record.finishMessage : (typeof candidate?.finishMessage === 'string' ? candidate.finishMessage : undefined),
    safetyRatings: record.safetyRatings ?? candidate?.safetyRatings,
    promptFeedback: record.promptFeedback,
  };
};

const summarize = (metadata: FinishMetadata): string | undefined => {
  const parts = [
    metadata.finishReason ? `finishReason=${metadata.finishReason}` : undefined,
    metadata.finishMessage ? `finishMessage=${metadata.finishMessage}` : undefined,
    metadata.safetyRatings ? `safetyRatings=${JSON.stringify(metadata.safetyRatings).slice(0, 500)}` : undefined,
    metadata.promptFeedback ? `promptFeedback=${JSON.stringify(metadata.promptFeedback).slice(0, 500)}` : undefined,
  ].filter(Boolean);
  return parts.length ? parts.join('\n') : undefined;
};

export const classifyGenerationResult = (text: string, metadata: FinishMetadata, aborted: boolean, latencyMs = 0): GenerationResult => {
  if (aborted) return { outcome: 'ABORTED', text, latencyMs, finishReason: metadata.finishReason, finishMessage: metadata.finishMessage };
  const finishReason = metadata.finishReason?.toUpperCase();
  const detail = summarize(metadata);
  if (finishReason === 'SAFETY') return { outcome: 'ERROR', text, latencyMs, finishReason, finishMessage: metadata.finishMessage, errorCode: 'CONTENT_BLOCKED', errorDetail: detail || 'The response was blocked by safety filters.' };
  if (finishReason === 'BLOCKLIST') return { outcome: 'ERROR', text, latencyMs, finishReason, finishMessage: metadata.finishMessage, errorCode: 'BLOCKLIST', errorDetail: detail || 'The response was blocked by a blocklist.' };
  if (finishReason === 'PROHIBITED_CONTENT') return { outcome: 'ERROR', text, latencyMs, finishReason, finishMessage: metadata.finishMessage, errorCode: 'PROHIBITED_CONTENT', errorDetail: detail || 'The response contained prohibited content.' };
  if (finishReason === 'SPII') return { outcome: 'ERROR', text, latencyMs, finishReason, finishMessage: metadata.finishMessage, errorCode: 'SENSITIVE_PERSONAL_DATA', errorDetail: detail || 'The response was blocked for sensitive personal data.' };
  if (finishReason === 'MALFORMED_RESPONSE') return { outcome: 'ERROR', text, latencyMs, finishReason, finishMessage: metadata.finishMessage, errorCode: 'MALFORMED_RESPONSE', errorDetail: detail || 'The model returned a malformed response.' };
  if (finishReason === 'MAX_TOKENS' && text.trim().length > 0) return { outcome: 'ERROR', text, latencyMs, finishReason, finishMessage: metadata.finishMessage, errorCode: 'PARTIAL_RESPONSE', errorDetail: detail || 'The response stopped because it reached the output token limit.' };
  if (text.trim().length === 0) return { outcome: 'ERROR', text, latencyMs, finishReason, finishMessage: metadata.finishMessage, errorCode: 'EMPTY_RESPONSE', errorDetail: detail || 'The response stream completed without any text.' };
  return { outcome: 'SUCCESS', text, latencyMs, finishReason, finishMessage: metadata.finishMessage };
};
