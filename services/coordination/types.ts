/** UI-independent, adapter-ready coordination domain types. */
export type ExecutionMode = 'interactive' | 'supervised_autonomous';
export type WorkflowStatus = 'RUNNING' | 'SUSPENDED' | 'RESOLVED' | 'CANCELLED' | 'FAILED' | 'BLOCKED';
export type SessionState = 'OPEN' | 'SUSPENDED' | 'RESOLVED' | 'CANCELLED' | 'EXPIRED';
export type CoordinationMode = 'map.coord.task.v1' | 'map.coord.decision.v1' | 'map.coord.quorum.v1';
export type RiskDecision = 'ALLOW' | 'NEEDS_USER' | 'DENY';
export type SessionOutcome = 'SUCCEEDED' | 'FAILED';
export type CoordinationTaskStatus = 'ASSIGNED' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
export type CoordinationDecisionStatus = 'OPEN' | 'RESOLVED' | 'CANCELLED';
export type QuorumVote = 'APPROVE' | 'REJECT' | 'ABSTAIN';
export type QuorumThreshold = { kind: 'all' } | { kind: 'majority' } | { kind: 'count'; count: number };
export type QuorumOutcome = 'APPROVED' | 'REJECTED';
export type CoordinationQuorumStatus = 'OPEN' | 'RESOLVED' | 'CANCELLED';
export type EvaluationOutcome = 'PASS' | 'FAIL' | 'INCONCLUSIVE';
export type AcceptanceCriterionOutcome = 'SATISFIED' | 'UNSATISFIED';
export type EvaluationTarget = { type: 'task'; id: string } | { type: 'decision'; id: string }
  | { type: 'quorum'; id: string } | { type: 'artifact'; ref: string };

export interface SessionResolution {
  outcome: SessionOutcome;
  summary?: string;
  evidenceRefs?: string[];
}

export interface WorkflowBudget {
  maxWallTimeMs: number;
  maxRounds: number;
  maxLlmCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxEstimatedCost: number;
  maxConsecutiveErrors: number;
  maxNoProgressCycles: number;
}

export interface WorkflowUsage {
  rounds: number;
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
  consecutiveErrors: number;
  noProgressCycles: number;
}
export type WorkflowProgressOutcome = 'PROGRESS' | 'NO_PROGRESS' | 'ERROR';
export interface UsageRecordedPayload { llmCalls: number; inputTokens: number; outputTokens: number; estimatedCost: number; sourceRef?: string }
export interface ProgressRecordedPayload { outcome: WorkflowProgressOutcome; summary: string; evidenceEventIds?: string[] }

export interface CoordinationPolicy {
  policyId: string;
  version: string;
  schemaVersion: 1;
  budgets: WorkflowBudget;
  riskRules: Readonly<Record<string, RiskDecision>>;
  completionRules: { commitAuthority: 'supervisor'; requireAllAcceptanceCriteria: boolean };
  schedulerRules: { sameModelConcurrency: number };
  retryRules: { maxAttempts: number; baseDelayMs: number; maxDelayMs: number };
}

export interface WorkflowRun {
  runId: string;
  roomId: string;
  goal: string;
  acceptanceCriteria: string[];
  satisfiedCriteria: string[];
  supervisorAgentId: string;
  participantAgentIds: string[];
  executionMode: ExecutionMode;
  policyId: string;
  policyVersion: string;
  status: WorkflowStatus;
  statusReason?: string;
  budget: WorkflowBudget;
  usage: WorkflowUsage;
  currentSessionId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CoordinationTask {
  taskId: string;
  workflowRunId: string;
  sessionId: string;
  title: string;
  goal: string;
  assigneeAgentId: string;
  assignedByAgentId: string;
  inputRefs?: string[];
  status: CoordinationTaskStatus;
  resultRef?: string;
  evidenceRefs?: string[];
  failureReason?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CoordinationDecision {
  decisionId: string; workflowRunId: string; sessionId: string; question: string;
  authorityAgentId: string; options?: string[]; status: CoordinationDecisionStatus;
  value?: string; rationaleRef?: string; evidenceRefs?: string[];
  createdAt: number; updatedAt: number;
}
export interface DecisionResolvedPayload { decisionId: string; value: string; rationaleRef?: string; evidenceRefs?: string[] }

export interface CoordinationQuorum {
  quorumId: string; workflowRunId: string; sessionId: string; question: string;
  eligibleAgentIds: string[]; threshold: QuorumThreshold; votes: Record<string, QuorumVote>;
  status: CoordinationQuorumStatus; outcome?: QuorumOutcome; createdAt: number; updatedAt: number;
}
export interface QuorumVoteCastPayload { quorumId: string; vote: QuorumVote }
export interface QuorumResolvedPayload { quorumId: string; outcome: QuorumOutcome }

export interface CoordinationEvaluation {
  evaluationId: string; workflowRunId: string; sessionId: string; evaluatorAgentId: string;
  target: EvaluationTarget; outcome: EvaluationOutcome; summary?: string; evidenceRefs?: string[]; createdAt: number;
}

export interface TaskCompletedPayload { resultRef?: string; evidenceRefs?: string[] }
export interface TaskFailedPayload { failureReason: string; evidenceRefs?: string[] }
export interface WorkflowBlockedPayload { reason: string }
export interface WorkflowResumePayload {
  authorization: { type: 'user'; reference?: string };
  reason?: string;
}

export interface AcceptanceCriterionEvaluatedPayload {
  criterion: string;
  outcome: AcceptanceCriterionOutcome;
  evidenceEventIds: string[];
  note?: string;
}

export interface CommitmentGateResult {
  allowed: boolean;
  activeSessionIds: string[];
  missingCriteria: string[];
  exhaustedBudget?: keyof WorkflowBudget;
  reasons: string[];
}
export interface CommitmentPolicyEvaluationPayload { scope: 'commitment'; result: CommitmentGateResult }
export interface CommitmentRequestedPayload { commitmentId: string; summary?: string; evidenceRefs?: string[] }
export interface CommitmentAcceptedPayload { commitmentId: string }
export interface CommitmentRejectedPayload { commitmentId: string; reason: string }
export type WorkflowCommitmentStatus = 'REQUESTED' | 'ACCEPTED' | 'REJECTED' | 'CANCELLED';
export interface WorkflowCommitmentState {
  commitmentId: string;
  status: WorkflowCommitmentStatus;
  requestedByAgentId: string;
  requestedAt: number;
  summary?: string;
  evidenceRefs?: string[];
  decidedByAgentId?: string;
  decidedAt?: number;
  rejectionReason?: string;
}

export interface CoordinationSession {
  sessionId: string;
  workflowRunId: string;
  mode: CoordinationMode;
  participants: string[];
  initiator: string;
  supervisor: string;
  state: SessionState;
  policyId: string;
  policyVersion: string;
  goal: string;
  contextRef?: string;
  createdAt: number;
  updatedAt: number;
  resolution?: SessionResolution;
}

export type CoordinationEventType =
  | 'WorkflowRunCreated' | 'SessionStarted' | 'SessionSuspended' | 'SessionResumed'
  | 'SessionResolved' | 'SessionCancelled' | 'SessionExpired'
  | 'TaskAssigned' | 'TaskCompleted' | 'TaskFailed' | 'TaskCancelled'
  | 'DecisionOpened' | 'DecisionResolved' | 'DecisionCancelled'
  | 'QuorumOpened' | 'QuorumVoteCast' | 'QuorumResolved' | 'QuorumCancelled'
  | 'EvaluationAdded' | 'PolicyEvaluated' | 'WorkflowSuspended' | 'WorkflowBlocked' | 'WorkflowResumed'
  | 'AcceptanceCriterionEvaluated' | 'CommitmentRequested' | 'CommitmentAccepted' | 'CommitmentRejected'
  | 'UsageRecorded' | 'ProgressRecorded'
  | 'WorkflowCancelled' | 'ErrorRecorded';

/** Runtime allowlist for journal input crossing the TypeScript boundary. */
export const COORDINATION_EVENT_TYPES: ReadonlySet<CoordinationEventType> = new Set([
  'WorkflowRunCreated', 'SessionStarted', 'SessionSuspended', 'SessionResumed', 'SessionResolved',
  'SessionCancelled', 'SessionExpired', 'TaskAssigned', 'TaskCompleted', 'TaskFailed', 'TaskCancelled',
  'DecisionOpened', 'DecisionResolved', 'DecisionCancelled', 'QuorumOpened', 'QuorumVoteCast',
  'QuorumResolved', 'QuorumCancelled', 'EvaluationAdded', 'AcceptanceCriterionEvaluated',
  'UsageRecorded', 'ProgressRecorded', 'PolicyEvaluated', 'CommitmentRequested', 'CommitmentAccepted',
  'CommitmentRejected', 'WorkflowSuspended', 'WorkflowBlocked', 'WorkflowResumed',
  'WorkflowCancelled', 'ErrorRecorded',
]);
export const TERMINAL_WORKFLOW_STATUSES: ReadonlySet<WorkflowStatus> = new Set(['RESOLVED', 'CANCELLED', 'FAILED']);
export const STOPPED_WORKFLOW_STATUSES: ReadonlySet<WorkflowStatus> = new Set(['SUSPENDED', 'BLOCKED']);
export const ALLOWED_WHILE_STOPPED: ReadonlySet<CoordinationEventType> = new Set([
  'WorkflowResumed', 'WorkflowCancelled', 'ErrorRecorded', 'UsageRecorded',
]);

export interface CoordinationEvent<T = unknown> {
  eventId: string;
  sequence: number;
  type: CoordinationEventType;
  workflowRunId: string;
  sessionId?: string;
  actorAgentId?: string;
  timestamp: number;
  idempotencyKey?: string;
  payload: T;
}

export interface CoordinationSnapshot {
  run: WorkflowRun;
  policy: CoordinationPolicy;
  sessions: Record<string, CoordinationSession>;
  tasks: Record<string, CoordinationTask>;
  decisions: Record<string, CoordinationDecision>;
  quorums: Record<string, CoordinationQuorum>;
  evaluations: Record<string, CoordinationEvaluation>;
  commitment?: WorkflowCommitmentState;
  events: CoordinationEvent[];
}

export interface CoordinationAuditEntry {
  sequence: number; eventId: string; type: CoordinationEventType; timestamp: number;
  scope: 'workflow' | 'session'; sessionId?: string; actorAgentId?: string;
}
export interface CoordinationAuditView {
  workflow: Pick<WorkflowRun, 'runId' | 'status' | 'statusReason' | 'executionMode' | 'supervisorAgentId' | 'policyId' | 'policyVersion' | 'createdAt' | 'updatedAt'>;
  events: { count: number; lastSequence: number; lastEventAt: number };
  activeSessionIds: string[];
  sessionCounts: Record<SessionState, number>;
  taskCounts: Record<CoordinationTaskStatus, number>;
  decisionCounts: Record<CoordinationDecisionStatus, number>;
  quorumCounts: Record<CoordinationQuorumStatus, number>;
  evaluationCounts: Record<EvaluationOutcome, number>;
  acceptance: { total: number; satisfiedCriteria: string[]; missingCriteria: string[] };
  usage: WorkflowUsage; budget: WorkflowBudget; exhaustedBudget?: keyof WorkflowBudget;
  progress?: { outcome: WorkflowProgressOutcome; summary: string; eventId: string; sequence: number; timestamp: number };
  commitment?: WorkflowCommitmentState; trail: CoordinationAuditEntry[];
}
