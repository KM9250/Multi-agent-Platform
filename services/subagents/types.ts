import type { SubAgentDefinition } from '../../types';

export type { SubAgentDefinition };

export interface SubAgentTaskInput {
  name: string;
  content: string;
  mimeType?: string;
}

/** Deliberately contains no Room, Message, Agent, or internal-state object. */
export interface SubAgentTaskContract {
  taskId: string;
  parentAgentId: string;
  subAgentId: string;
  taskType: string;
  goal: string;
  inputs: SubAgentTaskInput[];
  constraints?: string[];
  acceptanceCriteria?: string[];
  metadata?: Record<string, unknown>;
}

export type SubAgentTaskStatus = 'completed' | 'failed' | 'aborted';

export interface SubAgentTaskResult {
  taskId: string;
  subAgentId: string;
  status: SubAgentTaskStatus;
  summary: string;
  result?: unknown;
  evidence?: unknown[];
  unresolved?: string[];
  confidence?: number;
  errorCode?: string;
  errorDetail?: string;
  metadata?: { provider?: string; model?: string; latencyMs?: number };
}

export type SubAgentRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'aborted';

/** Serializable lifecycle data, separate from its AbortController runtime. */
export interface SubAgentRun {
  runId: string;
  parentSessionId?: string;
  parentAgentId: string;
  subAgentId: string;
  taskId: string;
  status: SubAgentRunStatus;
  startedAt?: number;
  completedAt?: number;
}
