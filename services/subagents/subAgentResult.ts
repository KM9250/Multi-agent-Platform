import type { SubAgentTaskContract, SubAgentTaskResult } from './types';

export class InvalidSubAgentResultError extends Error {
  readonly code = 'INVALID_TASK_RESULT';
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const optionalString = (value: unknown): value is string | undefined =>
  value === undefined || typeof value === 'string';

export const parseSubAgentResult = (text: string, task: SubAgentTaskContract): SubAgentTaskResult => {
  if (!text.trim()) throw new InvalidSubAgentResultError('Provider returned an empty result');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new InvalidSubAgentResultError('Provider result is not valid JSON'); }
  if (!isRecord(value)) throw new InvalidSubAgentResultError('Provider result must be an object');
  const result = value;
  if (typeof result.taskId !== 'string' || result.taskId !== task.taskId) throw new InvalidSubAgentResultError('Result taskId does not match contract');
  if (typeof result.subAgentId !== 'string' || result.subAgentId !== task.subAgentId) throw new InvalidSubAgentResultError('Result subAgentId does not match contract');
  if (!['completed', 'failed', 'aborted'].includes(typeof result.status === 'string' ? result.status : '') || typeof result.summary !== 'string' || !result.summary.trim()) {
    throw new InvalidSubAgentResultError('Result status and non-empty summary are required');
  }
  if (result.evidence !== undefined && !Array.isArray(result.evidence)) throw new InvalidSubAgentResultError('Result evidence must be an array');
  if (result.unresolved !== undefined && (!Array.isArray(result.unresolved) || !result.unresolved.every(item => typeof item === 'string'))) {
    throw new InvalidSubAgentResultError('Result unresolved must be a string array');
  }
  if (result.confidence !== undefined && (typeof result.confidence !== 'number' || !Number.isFinite(result.confidence) || result.confidence < 0 || result.confidence > 1)) {
    throw new InvalidSubAgentResultError('Result confidence must be a finite number between 0 and 1');
  }
  if (!optionalString(result.errorCode) || !optionalString(result.errorDetail)) throw new InvalidSubAgentResultError('Result error fields must be strings');
  const metadata = result.metadata;
  if (metadata !== undefined) {
    if (!isRecord(metadata) || !optionalString(metadata.provider) || !optionalString(metadata.model)) {
      throw new InvalidSubAgentResultError('Result metadata is invalid');
    }
    const latency = metadata.latencyMs;
    if (latency !== undefined && (typeof latency !== 'number' || !Number.isFinite(latency) || latency < 0)) {
      throw new InvalidSubAgentResultError('Result metadata latencyMs must be a non-negative finite number');
    }
  }

  const normalized: SubAgentTaskResult = {
    taskId: result.taskId as string,
    subAgentId: result.subAgentId as string,
    status: result.status as SubAgentTaskResult['status'],
    summary: result.summary,
  };
  if (result.result !== undefined) normalized.result = result.result;
  if (result.evidence !== undefined) normalized.evidence = result.evidence as unknown[];
  if (result.unresolved !== undefined) normalized.unresolved = result.unresolved as string[];
  if (result.confidence !== undefined) normalized.confidence = result.confidence as number;
  if (result.errorCode !== undefined) normalized.errorCode = result.errorCode;
  if (result.errorDetail !== undefined) normalized.errorDetail = result.errorDetail;
  if (isRecord(metadata)) normalized.metadata = {
    ...(metadata.provider === undefined ? {} : { provider: metadata.provider as string }),
    ...(metadata.model === undefined ? {} : { model: metadata.model as string }),
    ...(metadata.latencyMs === undefined ? {} : { latencyMs: metadata.latencyMs as number }),
  };
  return normalized;
};
