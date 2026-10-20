import type { RequestScheduler } from '../../scheduler';
import type { CoordinationAuditEntry, CoordinationAuditView, CoordinationEvent, CoordinationSnapshot, CoordinationTask } from '../types';

export interface CoordinationRunnerStore {
  readonly persistence?: 'durable';
  getSnapshot(workflowRunId: string): CoordinationSnapshot;
  append(event: CoordinationEvent): CoordinationSnapshot;
}
export interface RunnerClock { now(): number }
export interface RunnerIdGenerator { nextId(kind: string): string }
export interface RunnerRunOptions { signal?: AbortSignal }
export type RunnerStopReason = 'round_completed' | 'completed' | 'needs_user' | 'budget_exhausted' | 'stopped' | 'terminal' | 'cancelled' | 'error';
export interface RunnerRunResult {
  workflowRunId: string;
  reason: RunnerStopReason;
  snapshot: CoordinationSnapshot;
  roundsCompleted: number;
  pendingApproval?: RunnerPendingApproval;
  errorCode?: string;
  errorDetail?: string;
}
export type RunnerRoundResult = RunnerRunResult;
export interface CoordinationRunner {
  runOneRound(workflowRunId: string, options?: RunnerRunOptions): Promise<RunnerRoundResult>;
  runUntilStop(workflowRunId: string, options?: RunnerRunOptions): Promise<RunnerRunResult>;
  stop(workflowRunId: string): void;
  isRunning(workflowRunId: string): boolean;
}
export interface RunnerModelUsage { llmCalls: number; inputTokens: number; outputTokens: number; estimatedCost: number }
export interface RunnerModelResult<T> { value: T; usage: RunnerModelUsage; provider: string; model: string; latencyMs: number }
/** Errors may expose known consumed usage, including failed adapter attempts. */
export interface RunnerModelError extends Error { usage?: RunnerModelUsage }
export interface RunnerSupervisorProvider {
  /** Required when dependencies.scheduler is provided. Adapter owns bounded retries and aggregate usage. */
  scheduling?: { provider: string; model: string };
  plan(request: RunnerPlanRequest): Promise<RunnerModelResult<RunnerPlanProposal>>;
  verify(request: RunnerVerifyRequest): Promise<RunnerModelResult<RunnerVerification>>;
}
export interface RunnerPlanRequest {
  workflowRunId: string; goal: string; acceptanceCriteria: string[]; satisfiedCriteria: string[];
  audit: CoordinationAuditView; recentTrail: CoordinationAuditEntry[];
  systemContract: string; signal?: AbortSignal;
}
export interface RunnerVerifyRequest {
  workflowRunId: string; goal: string; acceptanceCriteria: string[]; task: CoordinationTask;
  evidence: RunnerEvidence[]; audit: CoordinationAuditView; systemContract: string; signal?: AbortSignal;
}
export type RunnerPlanProposal =
  | { kind: 'execute'; objective: string; assigneeAgentId?: string; action: RunnerActionProposal }
  | { kind: 'finish'; summary: string }
  | { kind: 'needs_user'; reason: string };
export interface RunnerActionProposal { executorId: string; operation: string; arguments: unknown }
export interface RunnerVerification {
  taskOutcome: 'PASS' | 'FAIL' | 'INCONCLUSIVE'; summary: string;
  criteria: Array<{ criterion: string; outcome: 'SATISFIED' | 'UNSATISFIED' | 'UNCHANGED'; note?: string }>;
}
export interface PreparedRunnerAction {
  actionId: string; executorId: string; operation: string; actionClass: string;
  fingerprint: string; publicSummary: string; retrySafety: 'safe' | 'never'; payload: unknown;
}
export interface RunnerExecutionContext { workflowRunId: string; sessionId: string; taskId: string; signal?: AbortSignal }
export type RunnerExecutionStatus = 'succeeded' | 'failed' | 'uncertain' | 'aborted';
export type RunnerSafetyHoldEffectState = 'not_dispatched' | 'applied';
export interface RunnerSafetyHold {
  kind: 'untrusted-content';
  effectState: RunnerSafetyHoldEffectState;
  reasonCode: 'CONTENT_REVIEW_REQUIRED';
  reviewRef: string;
  safeSummary: 'Untrusted content requires user review.';
}
export interface RunnerExecutionResult {
  status: RunnerExecutionStatus; summary: string; resultRef?: string; evidenceRefs?: string[];
  errorCode?: string; errorDetail?: string;
  safetyHold?: RunnerSafetyHold;
}
export interface RunnerActionExecutor {
  id: string;
  /** Side-effect free validation, normalization, classification and fingerprinting only. */
  prepare(proposal: RunnerActionProposal): Promise<PreparedRunnerAction>;
  /** Called at most once per prepared action. Do not automatically retry side effects. */
  execute(action: PreparedRunnerAction, context: RunnerExecutionContext): Promise<RunnerExecutionResult>;
}
export interface RunnerExecutorRegistry { get(executorId: string): RunnerActionExecutor | undefined }
export interface RunnerPendingActionRecord {
  workflowRunId: string;
  sessionId: string;
  taskId: string;
  action: PreparedRunnerAction;
}
export interface RunnerPendingActionStore {
  get(workflowRunId: string, actionId: string): RunnerPendingActionRecord | undefined;
  put(record: RunnerPendingActionRecord): void;
  delete(workflowRunId: string, actionId: string): void;
}
export interface RunnerPendingApproval { actionId: string; fingerprint: string; actionClass: string; approvalRef: string; summary: string }
export interface RunnerEvidence { kind: string; content: unknown; createdAt: number }
export interface RunnerEvidenceStore { put(evidence: RunnerEvidence): Promise<string>; get(ref: string): Promise<RunnerEvidence | undefined> }
/** Node-free contract; implementations live only in the durable server entry point. */
export interface RunnerDurableExecution {
  readonly store: CoordinationRunnerStore;
  readonly pendingActions: RunnerPendingActionStore;
  readonly evidenceStore: RunnerEvidenceStore;
  readonly executors: RunnerExecutorRegistry;
  assertCanPlan(workflowRunId: string): void;
  validatePreparedAction(input: unknown, executorId: string): PreparedRunnerAction;
  registerAction(record: RunnerPendingActionRecord, expected: CoordinationSnapshot, sessionEvent: CoordinationEvent, taskEvent: CoordinationEvent): RunnerPendingActionRecord;
  dispatch(workflowRunId: string, task: CoordinationTask, signal?: AbortSignal): Promise<RunnerExecutionResult>;
  getResult(workflowRunId: string, task: CoordinationTask): RunnerExecutionResult | undefined;
  finalizeResult(workflowRunId: string, task: CoordinationTask): void;
  getOwnedEvidence(workflowRunId: string, task: CoordinationTask, ref: string): Promise<RunnerEvidence | undefined>;
}
export interface CoordinationRunnerDependencies {
  durableExecution?: RunnerDurableExecution;
  store: CoordinationRunnerStore; supervisorProvider: RunnerSupervisorProvider; executors: RunnerExecutorRegistry;
  pendingActions: RunnerPendingActionStore; evidenceStore: RunnerEvidenceStore;
  clock?: RunnerClock; ids?: RunnerIdGenerator; scheduler?: RequestScheduler;
}
