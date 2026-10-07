import { evaluateRisk } from '../policy';
import type { CoordinationSnapshot, RiskDecision } from '../types';
import type { PreparedRunnerAction, RunnerPendingApproval } from './types';
export const evaluateRunnerActionRisk = (snapshot: CoordinationSnapshot, action: PreparedRunnerAction): RiskDecision =>
  Object.hasOwn(snapshot.policy.riskRules, action.actionClass)
    ? evaluateRisk(snapshot.policy, action.actionClass) : 'NEEDS_USER';
export const runnerPendingApproval = (workflowRunId: string, action: PreparedRunnerAction): RunnerPendingApproval => ({
  actionId: action.actionId, fingerprint: action.fingerprint, actionClass: action.actionClass,
  approvalRef: `map.runner.approval.v1:${[workflowRunId, action.actionId, action.fingerprint].map(encodeURIComponent).join(':')}`,
  summary: action.publicSummary,
});
export const runnerActionRef = (action: PreparedRunnerAction): string =>
  `map.runner.action.v1:${encodeURIComponent(action.actionId)}:${encodeURIComponent(action.fingerprint)}`;
export const parseRunnerActionRef = (refs: string[] = []): { actionId: string; fingerprint: string } | undefined => {
  const matches = refs.filter(ref => ref.startsWith('map.runner.action.v1:'));
  if (matches.length !== 1) return undefined;
  const parts = matches[0].slice('map.runner.action.v1:'.length).split(':');
  if (parts.length !== 2 || parts.some(part => !part)) return undefined;
  try { return { actionId: decodeURIComponent(parts[0]), fingerprint: decodeURIComponent(parts[1]) }; } catch { return undefined; }
};
