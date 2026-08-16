import type { SubAgentTaskContract, SubAgentTaskResult } from './types';

export class InvalidSubAgentResultError extends Error {
  readonly code = 'INVALID_TASK_RESULT';
}

export const parseSubAgentResult = (text: string, task: SubAgentTaskContract): SubAgentTaskResult => {
  if (!text.trim()) throw new InvalidSubAgentResultError('Provider returned an empty result');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new InvalidSubAgentResultError('Provider result is not valid JSON'); }
  if (!value || typeof value !== 'object') throw new InvalidSubAgentResultError('Provider result must be an object');
  const result = value as Partial<SubAgentTaskResult>;
  if (result.taskId !== task.taskId) throw new InvalidSubAgentResultError('Result taskId does not match contract');
  if (result.subAgentId !== task.subAgentId) throw new InvalidSubAgentResultError('Result subAgentId does not match contract');
  if (!['completed', 'failed', 'aborted'].includes(result.status ?? '') || typeof result.summary !== 'string' || !result.summary.trim()) {
    throw new InvalidSubAgentResultError('Result status and non-empty summary are required');
  }
  return result as SubAgentTaskResult;
};
