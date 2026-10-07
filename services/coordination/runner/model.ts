import type { PreparedRunnerAction, RunnerExecutionResult, RunnerModelUsage, RunnerPlanProposal, RunnerVerification } from './types';
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object.');
  return value as Record<string, unknown>;
};
export const runnerText = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Expected non-empty text.');
  return value.trim();
};
export const validateRunnerUsage = (value: unknown): RunnerModelUsage => {
  const v = object(value);
  for (const key of ['llmCalls', 'inputTokens', 'outputTokens']) {
    if (!Number.isSafeInteger(v[key]) || (v[key] as number) < (key === 'llmCalls' ? 1 : 0)) throw new Error(`Invalid ${key}.`);
  }
  if (typeof v.estimatedCost !== 'number' || !Number.isFinite(v.estimatedCost) || v.estimatedCost < 0) throw new Error('Invalid estimatedCost.');
  return { llmCalls: v.llmCalls as number, inputTokens: v.inputTokens as number, outputTokens: v.outputTokens as number, estimatedCost: v.estimatedCost };
};
export const validateRunnerPlan = (value: unknown): RunnerPlanProposal => {
  const v = object(value);
  if (v.kind === 'finish') return { kind: 'finish', summary: runnerText(v.summary) };
  if (v.kind === 'needs_user') return { kind: 'needs_user', reason: runnerText(v.reason) };
  if (v.kind !== 'execute') throw new Error('Invalid plan kind.');
  const action = object(v.action);
  return { kind: 'execute', objective: runnerText(v.objective),
    ...(v.assigneeAgentId === undefined ? {} : { assigneeAgentId: runnerText(v.assigneeAgentId) }),
    action: { executorId: runnerText(action.executorId), operation: runnerText(action.operation), arguments: structuredClone(action.arguments) } };
};
export const validatePreparedRunnerAction = (value: unknown, executorId: string): PreparedRunnerAction => {
  const v = object(value);
  const action = { actionId: runnerText(v.actionId), executorId: runnerText(v.executorId), operation: runnerText(v.operation),
    actionClass: runnerText(v.actionClass), fingerprint: runnerText(v.fingerprint), publicSummary: runnerText(v.publicSummary),
    retrySafety: v.retrySafety as PreparedRunnerAction['retrySafety'], payload: structuredClone(v.payload) };
  if (action.executorId !== executorId || !['safe', 'never'].includes(action.retrySafety)) throw new Error('Invalid prepared action.');
  return action;
};
const refs = (value: unknown): string[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('Invalid evidence references.');
  const result = value.map(runnerText);
  if (new Set(result).size !== result.length) throw new Error('Duplicate evidence references.');
  return result;
};
export const validateRunnerExecution = (value: unknown): RunnerExecutionResult => {
  const v = object(value);
  if (!['succeeded', 'failed', 'uncertain', 'aborted'].includes(v.status as string)) throw new Error('Invalid execution status.');
  return { status: v.status as RunnerExecutionResult['status'], summary: runnerText(v.summary),
    resultRef: v.resultRef === undefined ? undefined : runnerText(v.resultRef), evidenceRefs: refs(v.evidenceRefs),
    errorCode: v.errorCode === undefined ? undefined : runnerText(v.errorCode), errorDetail: v.errorDetail === undefined ? undefined : runnerText(v.errorDetail) };
};
export const validateRunnerVerification = (value: unknown, acceptanceCriteria: string[]): RunnerVerification => {
  const v = object(value);
  if (!['PASS', 'FAIL', 'INCONCLUSIVE'].includes(v.taskOutcome as string) || !Array.isArray(v.criteria)) throw new Error('Invalid verification.');
  const seen = new Set<string>();
  const criteria = v.criteria.map(entry => {
    const c = object(entry); const criterion = runnerText(c.criterion);
    if (!acceptanceCriteria.includes(criterion) || seen.has(criterion)) throw new Error('Unknown or duplicate criterion.');
    seen.add(criterion);
    if (!['SATISFIED', 'UNSATISFIED', 'UNCHANGED'].includes(c.outcome as string)) throw new Error('Invalid criterion outcome.');
    return { criterion, outcome: c.outcome as RunnerVerification['criteria'][number]['outcome'],
      ...(c.note === undefined ? {} : { note: runnerText(c.note) }) };
  });
  return { taskOutcome: v.taskOutcome as RunnerVerification['taskOutcome'], summary: runnerText(v.summary), criteria };
};
