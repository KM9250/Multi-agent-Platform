import type { CoordinationSnapshot } from '../types';
import { findExhaustedBudget } from '../policy';
import { emptyWorkflowUsage } from '../usage';
import type { ExecutionStateSummary, RecoveryAuthorizationRequirement, RecoveryDisposition, RecoveryInspection, RecoveryNextStep } from './recoveryTypes';

export interface RecoveryFacts {
  workflowRunId: string; inspectedAt: number; snapshot?: CoordinationSnapshot;
  executions: ExecutionStateSummary[]; missingHistoricalLedger?: boolean;
  integrityReason?: string; unresolvedSecurityReview?: boolean; unresolvedEvidenceReview?: boolean;
  authorizationRequirements?: RecoveryAuthorizationRequirement[];
}
/** Static diagnosis only. The result never grants dispatch, model calls, or a resume. */
export function classifyRecovery(facts: RecoveryFacts): RecoveryInspection {
  const { snapshot: s, executions, inspectedAt } = facts;
  const reasons: string[] = [];
  const budgetStatus = !s ? 'UNVERIFIED' : findExhaustedBudget(s.run.budget, s.run.usage, Math.max(0, inspectedAt - s.run.createdAt))
    ? 'RECORDED_LIMIT_EXHAUSTED' : 'WITHIN_RECORDED_LIMITS';
  const finish = (disposition: RecoveryDisposition, nextStep: RecoveryNextStep, reason: string): RecoveryInspection => ({
    workflowRunId: facts.workflowRunId, workflowStatus: s?.run.status ?? 'UNKNOWN', disposition, nextStep,
    journalCursor: s?.events.at(-1)?.sequence ?? 0, journalTimestamp: s?.events.at(-1)?.timestamp, inspectedAt,
    pendingActionIds: executions.filter(e => e.state !== 'FINALIZED').map(e => e.actionId), executionStates: executions,
    recordedUsage: { ...(s?.run.usage ?? emptyWorkflowUsage()) }, budgetStatus,
    modelCallCoverage: 'NOT_TRACKED_YET', requiresExplicitAuthorization: disposition !== 'INACTIVE',
    authorizationRequirements: (facts.authorizationRequirements ?? []).map(requirement => ({ ...requirement })),
    stopJournalEventId: s ? [...s.events].reverse().find(event => ['WorkflowBlocked','WorkflowSuspended'].includes(event.type))?.eventId : undefined,
    reasonCodes: [...new Set([reason, ...reasons, ...(budgetStatus === 'RECORDED_LIMIT_EXHAUSTED' ? ['RECORDED_BUDGET_EXHAUSTED'] : []),
      'MODEL_CALL_COVERAGE_NOT_TRACKED', 'EXECUTION_NOT_AUTHORIZED'])], executable: false, executionAllowed: false,
  });
  if (facts.integrityReason || !s) return finish('RECOVERY_FAILED', 'REQUIRE_OPERATOR_REVIEW', facts.integrityReason ?? 'SAVED_DATA_INVALID');
  for (const e of executions) if (e.reviewReason) reasons.push(e.reviewReason);
  const unknown = executions.some(e => e.state === 'DISPATCH_RESERVED' || e.state === 'REVIEW_REQUIRED' && e.reviewReason !== 'SECURITY_REVIEW_REQUIRED');
  if (unknown) return finish('REVIEW_REQUIRED', s.run.status === 'RUNNING' && executions.some(e => e.safetyStopIncomplete)
    ? 'COMPLETE_SAFETY_STOP' : 'REQUIRE_OPERATOR_REVIEW', 'EXECUTION_OUTCOME_REVIEW_REQUIRED');
  if (facts.unresolvedSecurityReview || facts.unresolvedEvidenceReview) return finish('REVIEW_REQUIRED', 'REQUIRE_OPERATOR_REVIEW',
    facts.unresolvedSecurityReview ? 'SECURITY_REVIEW_REQUIRED' : 'EVIDENCE_REVIEW_REQUIRED');
  if (['RESOLVED','CANCELLED','FAILED'].includes(s.run.status)) return finish('INACTIVE', 'NONE', 'WORKFLOW_TERMINAL');
  if (s.run.status === 'BLOCKED') return finish('REVIEW_REQUIRED', 'REQUIRE_OPERATOR_REVIEW', 'WORKFLOW_BLOCKED');
  if (s.run.status === 'SUSPENDED') return finish('INACTIVE', 'NONE', 'WORKFLOW_SUSPENDED');
  if (s.run.status !== 'RUNNING') return finish('RECOVERY_FAILED', 'REQUIRE_OPERATOR_REVIEW', 'WORKFLOW_STATE_INVALID');
  if (facts.missingHistoricalLedger) return finish('REVIEW_REQUIRED', 'REQUIRE_OPERATOR_REVIEW', 'HISTORICAL_EXECUTION_UNTRACKED');
  if (s.run.executionMode !== 'supervised_autonomous') return finish('REVIEW_REQUIRED', 'REQUIRE_OPERATOR_REVIEW', 'WORKFLOW_MODE_REQUIRES_REVIEW');
  if (budgetStatus === 'RECORDED_LIMIT_EXHAUSTED') return finish('REVIEW_REQUIRED', 'REQUIRE_OPERATOR_REVIEW', 'RECORDED_BUDGET_EXHAUSTED');
  const active = executions.filter(e => ['PREPARED','RESULT_RECORDED'].includes(e.state) && e.taskStatus === 'ASSIGNED');
  if (active.length > 1) return finish('RECOVERY_FAILED', 'REQUIRE_OPERATOR_REVIEW', 'EXECUTION_STATE_CONFLICT');
  const result = executions.find(e => e.state === 'RESULT_RECORDED');
  if (result) return result.taskStatus === 'ASSIGNED' && result.sessionState === 'OPEN'
    ? finish('READY_TO_RESUME', 'REFLECT_RECORDED_RESULT', 'RECORDED_RESULT_VALIDATED')
    : finish('REVIEW_REQUIRED', 'REQUIRE_OPERATOR_REVIEW', 'RESULT_REFLECTION_CONDITIONS_UNMET');
  const prepared = executions.find(e => e.state === 'PREPARED' && e.taskStatus === 'ASSIGNED');
  if (prepared) {
    reasons.push('POLICY_APPROVAL_LEASE_BUDGET_REVALIDATION_REQUIRED');
    return prepared.sessionState === 'OPEN' ? finish('READY_TO_RESUME', 'REVALIDATE_PREPARED_ACTION', 'PREPARED_ACTION_VALIDATED')
      : finish('REVIEW_REQUIRED', 'REQUIRE_OPERATOR_REVIEW', 'PREPARED_SESSION_NOT_OPEN');
  }
  if (Object.values(s.sessions).some(session => session.state === 'SUSPENDED')) return finish('REVIEW_REQUIRED', 'REQUIRE_OPERATOR_REVIEW', 'SESSION_SUSPENDED');
  if (Object.values(s.sessions).some(session => session.state === 'OPEN')) return finish('READY_TO_RESUME', 'CONTINUE_VERIFICATION', 'SESSION_FOLLOWUP_REQUIRED');
  return finish('READY_TO_RESUME', 'CONSIDER_NEW_PLAN', 'NO_ACTIVE_SESSION');
}
