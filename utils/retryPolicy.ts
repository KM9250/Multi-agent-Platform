const RETRYABLE = new Set(['EMPTY_RESPONSE', 'NETWORK_ERROR', 'MODEL_OVERLOADED', 'UNKNOWN_ERROR', 'MALFORMED_RESPONSE', 'QUOTA_EXCEEDED']);
const REGENERATE_ONLY = new Set(['CONTENT_BLOCKED', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SENSITIVE_PERSONAL_DATA', 'PARTIAL_RESPONSE']);
export const canRetryGeneration = (errorCode?: string): boolean => !!errorCode && RETRYABLE.has(errorCode);
export const canRegenerateGeneration = (errorCode?: string): boolean => !errorCode || REGENERATE_ONLY.has(errorCode) || errorCode === 'EMPTY_RESPONSE';
