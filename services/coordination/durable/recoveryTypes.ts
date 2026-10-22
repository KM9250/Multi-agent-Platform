import type { WorkflowUsage } from '../types';
import type { DurableExecutionState } from './executionLedger';

export type RecoveryDisposition = 'INACTIVE' | 'READY_TO_RESUME' | 'REVIEW_REQUIRED' | 'RECOVERY_FAILED';
export type RecoveryNextStep = 'NONE' | 'REVALIDATE_PREPARED_ACTION' | 'REFLECT_RECORDED_RESULT'
  | 'CONTINUE_VERIFICATION' | 'COMPLETE_SAFETY_STOP' | 'CONSIDER_NEW_PLAN' | 'REQUIRE_OPERATOR_REVIEW';
export interface RecoveryAuthorizationRequirement {
  kind: 'ACTION_APPROVAL' | 'SECURITY_REVIEW' | 'EVIDENCE_REVIEW' | 'EXPLICIT_RESUME';
  reference?: string; effectState?: 'not_dispatched' | 'applied'; satisfied: boolean;
}
export interface ExecutionStateSummary {
  actionId: string; sessionId: string; taskId: string; state: DurableExecutionState;
  taskStatus: string; sessionState: string; reviewReason?: string;
  finalizedEventId?: string; safetyStopIncomplete?: boolean;
}
export interface RecoveryInspection {
  workflowRunId: string; workflowStatus: string; disposition: RecoveryDisposition; nextStep: RecoveryNextStep;
  journalCursor: number; journalTimestamp?: number; inspectedAt: number;
  pendingActionIds: string[]; executionStates: ExecutionStateSummary[];
  recordedUsage: WorkflowUsage;
  budgetStatus: 'WITHIN_RECORDED_LIMITS' | 'RECORDED_LIMIT_EXHAUSTED' | 'UNVERIFIED';
  modelCallCoverage: 'NOT_TRACKED_YET'; requiresExplicitAuthorization: boolean;
  authorizationRequirements: RecoveryAuthorizationRequirement[]; stopJournalEventId?: string;
  reasonCodes: string[]; executable: false; executionAllowed: false;
}
export interface TimelineQueryOptions {
  limit?: number; cursor?: string; actionId?: string; eventKind?: string;
  fromTimestamp?: number; toTimestamp?: number;
}
export interface WorkflowTimelineEntry {
  source: 'JOURNAL' | 'EXECUTION_AUDIT' | 'RUNTIME_AUDIT' | 'CURRENT_SNAPSHOT';
  eventKind: string; workflowRunId: string; sessionId?: string; taskId?: string; actionId?: string; attemptId?: string;
  auditEventId?: string; auditSequence?: number; journalEventId?: string; journalSequence?: number;
  actorAgentId?: string; subjectAgentId?: string; runtimeInstanceId?: string; generation?: number;
  previousState?: string; nextState?: string; reasonCode?: string; occurredAt: number; recordedAt?: number;
  historicalCoverage: 'COMPLETE_FOR_SOURCE' | 'PARTIAL' | 'CURRENT_ONLY';
}
export interface WorkflowTimelinePage {
  workflowRunId: string; entries: WorkflowTimelineEntry[]; nextCursor?: string;
  ordering: 'LEGACY_JOURNAL_THEN_AUDIT_THEN_CURRENT';
  crossSourceClockOrderGuaranteed: false;
  ledgerHistoricalCoverage: 'PARTIAL';
}
