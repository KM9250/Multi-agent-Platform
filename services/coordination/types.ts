/** UI-independent, adapter-ready coordination domain types. */
export type ExecutionMode = 'interactive' | 'supervised_autonomous';
export type WorkflowStatus = 'RUNNING' | 'SUSPENDED' | 'RESOLVED' | 'CANCELLED' | 'FAILED' | 'BLOCKED';
export type SessionState = 'OPEN' | 'SUSPENDED' | 'RESOLVED' | 'CANCELLED' | 'EXPIRED';
export type CoordinationMode = 'map.coord.task.v1' | 'map.coord.decision.v1' | 'map.coord.quorum.v1';
export type RiskDecision = 'ALLOW' | 'NEEDS_USER' | 'DENY';

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
}

export type CoordinationEventType =
  | 'WorkflowRunCreated' | 'SessionStarted' | 'TaskAssigned' | 'TaskCompleted'
  | 'EvaluationAdded' | 'PolicyEvaluated' | 'WorkflowSuspended'
  | 'CommitmentRequested' | 'CommitmentAccepted' | 'WorkflowCancelled' | 'ErrorRecorded';

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
  sessions: Record<string, CoordinationSession>;
  events: CoordinationEvent[];
}
