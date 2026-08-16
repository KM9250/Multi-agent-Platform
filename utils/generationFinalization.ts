import type { GenerationResult } from './generationResult';
import type { Message, MessageSegment } from '../types';
import { parseStructuredAgentOutput, STRUCTURED_OUTPUT_PARSE_ERROR } from './structuredAgentOutput';

export const SAFE_SEPARATED_ERROR_MESSAGE = 'Agent response could not be completed safely.';

export const prepareMessageForRegeneration = (message: Message, separationEnabled: boolean): Message => ({
  ...message,
  content: '',
  segments: separationEnabled ? [] : undefined,
  separationVersion: separationEnabled ? 1 : undefined,
  error: false,
  errorCode: undefined,
  errorDetail: undefined,
  isStreaming: true,
});

export const restoreMessageAfterAbort = (original: Message): Message => ({ ...original, isStreaming: false });

export const finalizeLegacyGeneration = (message: Message, content: string): Message => ({
  ...message,
  content,
  segments: undefined,
  separationVersion: undefined,
  isStreaming: false,
  error: false,
  errorCode: undefined,
  errorDetail: undefined,
});

export const finalizeSeparatedFailure = (message: Message, result: Pick<GenerationResult, 'errorCode' | 'errorDetail'>): Message => ({
  ...message,
  content: SAFE_SEPARATED_ERROR_MESSAGE,
  segments: [],
  separationVersion: 1,
  isStreaming: false,
  error: true,
  errorCode: result.errorCode || 'STRUCTURED_OUTPUT_ERROR',
  errorDetail: result.errorDetail,
});

export const finalizeSeparatedSuccess = (message: Message, raw: string, memoryRequest: boolean): Message => {
  try {
    const parsed = parseStructuredAgentOutput(raw, memoryRequest);
    return {
      ...message, content: parsed.publicMessage, segments: parsed.segments, separationVersion: 1,
      isStreaming: false, error: false, errorCode: undefined, errorDetail: undefined,
    };
  } catch (error) {
    return finalizeSeparatedFailure(message, {
      errorCode: STRUCTURED_OUTPUT_PARSE_ERROR,
      errorDetail: error instanceof Error ? error.message : 'Structured response could not be parsed.',
    });
  }
};

export const containsRawText = (message: Message, raw: string): boolean =>
  message.content.includes(raw) || (message.segments || []).some((segment: MessageSegment) => segment.content.includes(raw));
