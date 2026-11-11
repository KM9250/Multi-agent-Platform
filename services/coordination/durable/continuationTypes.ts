import type { RunnerSupervisorProvider, RunnerModelUsage } from '../runner/types';
import type { ModelBudgetQuote } from './modelCallLedger';
import type { RecoveryRole, VerifiedRecoveryIdentity } from './recoveryDecisionTypes';

export const BOUNDED_CONTRACT = 'COORD-5C-4B2B:BOUNDED_EXECUTION:1' as const;
export type PlanningMode = 'THINK_ONLY' | 'PLAN_READ_ONLY';
export type BoundedOperation =
  | { operation: 'PLANNING_ONLY'; mode: PlanningMode; origin: 'USER_REQUEST' | 'RECOVERY' }
  | { operation: 'BOUNDED_CONTINUATION'; mode: 'BOUNDED_EXECUTE'; origin: 'RECOVERY' | 'USER_REQUEST' }
  | { operation: 'RELEASE_RECOVERY_HOLD'; mode?: never; origin: 'RECOVERY' };
export interface InvocationLimits {
  maxRounds: number; maxModelCalls: number; maxActionDispatches: number; maxReadCalls: number;
  maxInputTokens: number; maxOutputTokens: number; maxCostMicros: number;
}
export interface InvocationTiming {
  startTtlMs: number; admissionMs: number; modelTimeoutMs: number; actionTimeoutMs: number;
  readTimeoutMs: number; collectionGraceMs: number; finalizationMs: number;
}
export const DEFAULT_INVOCATION_TIMING: Readonly<InvocationTiming> = Object.freeze({
  startTtlMs: 600_000, admissionMs: 300_000, modelTimeoutMs: 120_000, actionTimeoutMs: 30_000,
  readTimeoutMs: 5_000, collectionGraceMs: 30_000, finalizationMs: 30_000,
});
export interface InputSnapshot {
  id: string; revision: string; digest: string; observedAt: number;
  /** An explicitly supplied snapshot is data, never an execution capability. */
  sourceWorkflowId?: string;
}
export interface ArtifactRef { artifactId: string; version: number; contentDigest: string }
export type ContinuationPlanInput = BoundedOperation & {
  workflowRunId: string; requestId: string; limits: InvocationLimits;
  start?: 'NEW_ROUND' | 'RESUME_PREPARED' | 'VERIFY_FINALIZED_RESULT'; taskId?: string; actionId?: string;
  providerId?: string; modelId?: string; requestSummary?: boolean; reasoning?: Record<string, string | number | boolean>;
  input?: { text: string; snapshots: InputSnapshot[]; dataClass: string; destination: string };
  actions?: Array<{executorId:string;operation:string;actionClass:string;payloadDigest:string}>;
  resources?: string[]; artifact?: ArtifactRef; previousArtifact?: ArtifactRef;
  resume?: import('../types').WorkflowResumePayload;
};
export type ContinuationPlan = ContinuationPlanInput & {
  planId: string; contract: typeof BOUNDED_CONTRACT; planDigest: string; createdBy: string;
  createdAt: number; expiresAt: number; timing: InvocationTiming; binding: Record<string, unknown>;
};
export interface ContinuationPolicy {
  /** Host maps existing verified roles explicitly; absent policy disables normal planning. */
  planningRoles: RecoveryRole[];
  recoveryApprovals: { minimumApprovers: number; forbidSelfApproval: boolean };
  releaseApprovals: { minimumApprovers: number; forbidSelfApproval: boolean };
  canAccess(identity: VerifiedRecoveryIdentity, workflowRunId: string, operation: 'VIEW' | 'PLAN' | 'EXECUTE'): boolean;
  canSend(identity: VerifiedRecoveryIdentity, snapshot: InputSnapshot, destination: string, dataClass: string): boolean;
  /** Required to adopt a non-local immutable snapshot for execution. Absent means unsupported. */
  isSnapshotCurrent?(snapshot:InputSnapshot):boolean;
  storeReasoningSummary: boolean;
  /** Additional host-specific secret/data classification filter. */
  inspectContent(text: string, dataClass: string): boolean;
  version: string;
}
export interface ProviderCapabilities {
  providerId: string; modelId: string; adapterVersion: string; implementationDigest: string;
  purposes: Array<'DRAFT_PLAN' | 'PLAN' | 'VERIFY'>; reasoningKeys: string[]; reasoningValues?:Record<string,Array<string|number|boolean>>;
  summary: boolean; completeUsage: boolean; outputIncludesReasoning: boolean;
  retry: 'disabled'; tools: 'disabled'; dataClasses: string[]; destinations: string[];
  quote: Omit<ModelBudgetQuote, 'requestDigest' | 'maxAttempts'>;
}
export interface PlanContent {
  objective: string; conclusion: string; steps: string[]; rationale: string; assumptions: string[];
  alternatives: string[]; risks: string[]; unknowns: string[]; requiredApprovals: string[];
  changeTargets: string[]; impact: string; validation: string[]; notPerformed: string[];
}
export interface PlanningReadRequest { resourceId: string; digest: string }
export type PlanDraftResponse =
  | { kind: 'plan'; artifact: PlanContent }
  | { kind: 'read_requests'; requests: PlanningReadRequest[] }
  | { kind: 'needs_input'; questions: string[] };
export type SummaryState = 'AVAILABLE' | 'NOT_REQUESTED' | 'NOT_SUPPORTED' | 'NOT_RETURNED' | 'NOT_STORED';
export interface PlanningProviderResponse {
  value: PlanDraftResponse; usage?: RunnerModelUsage; completeness: 'COMPLETE' | 'PARTIAL' | 'UNKNOWN';
  summary?: string;
}
export interface PlanningProviderRequest {
  mode: PlanningMode; input: string; reasoning: Record<string, string | number | boolean>;
  references: InputSnapshot[]; reads: Array<{ resourceId: string; digest: string; text: string }>;
  remainingModelCalls: number; remainingReadCalls: number; signal: AbortSignal;
}
export interface BoundedProvider {
  capabilities: ProviderCapabilities;
  draftPlan?(request: PlanningProviderRequest): Promise<PlanningProviderResponse>;
  runner?: RunnerSupervisorProvider;
}
export interface BoundedProviderRegistry { get(providerId: string, modelId: string): BoundedProvider | undefined }
export interface PlanArtifact extends ArtifactRef {
  schemaVersion: 1; workflowRunId: string; ownerId: string; requestId: string; invocationId: string;
  modelCallId: string; mode: PlanningMode; previousArtifact?: ArtifactRef; content: PlanContent;
  providerId: string; modelId: string; adapterVersion: string; reasoning: Record<string, string | number | boolean>;
  snapshots: InputSnapshot[]; summary: { state: SummaryState; text?: string; source: 'PROVIDER_SUMMARY' };
  completeness: 'COMPLETE'; dataClass: string; createdAt: number; basisDigest: string;
}
export type InvocationStatus = 'ACTIVE' | 'DRAINING' | 'COMPLETED' | 'STOPPED' | 'REVIEW_REQUIRED';
export interface ContinuationInspection {
  plan: ContinuationPlan; invocation?: { invocationId: string; status: InvocationStatus; outcome: string | null };
  artifact?: PlanArtifact; control: { holdState: string; holdEpoch: number; revision: number; planningReviewPending: boolean };
  counts: { rounds: number; modelCalls: number; actionDispatches: number; readCalls: number };
  usage: { committed: { inputTokens: number; outputTokens: number; costMicros: number }; outstanding: { inputTokens: number; outputTokens: number; costMicros: number } };
  remaining: { rounds:number;modelCalls:number;actionDispatches:number;readCalls:number };
  performed: { businessActionDispatches:number;localReadCalls:number;modelCalls:number;internalPersistence:true };
  review: { state:'UNREVIEWED'|'ACCEPTED_FOR_SCOPE'|'REJECTED'|'SUPERSEDED'|'STALE';executionAuthorizationRequired:true };
  executionAllowed: false;
}
export type ContinuationCommand =
  | { kind: 'CREATE_PLAN'; input: ContinuationPlanInput }
  | { kind: 'AUTHORIZE'; planId: string; planDigest: string }
  | { kind: 'REVOKE'; grantId: string }
  | { kind: 'INSPECT'; planId: string }
  | { kind: 'STOP'; planId: string }
  | { kind: 'REVIEW'; artifact: ArtifactRef; decision: 'ACCEPTED_FOR_SCOPE' | 'REJECTED' | 'SUPERSEDED' };
