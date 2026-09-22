export type SchedulerJobKind = 'decision' | 'generation' | 'subagent';

export interface SchedulerExecutionContext {
  /** One-based attempt number. */
  attempt: number;
  markOutputStarted(): void;
}

export interface SchedulerJob<T> {
  provider: string;
  model: string;
  kind: SchedulerJobKind;
  signal?: AbortSignal;
  execute(context: SchedulerExecutionContext): Promise<T>;
}

export interface SchedulerRetryConfig {
  /** Total attempts, including the initial attempt. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
}

export interface RequestSchedulerConfig {
  defaultConcurrencyPerModel: number;
  retry: SchedulerRetryConfig;
  diagnosticsLimit?: number;
  random?: () => number;
}

export type SchedulerDiagnosticState = 'queued' | 'started' | 'retrying' | 'completed' | 'cancelled' | 'failed';
export interface SchedulerDiagnosticEvent {
  id: string;
  timestamp: number;
  kind: SchedulerJobKind;
  provider: string;
  model: string;
  state: SchedulerDiagnosticState;
  attempt: number;
  queueWaitMs?: number;
  errorCode?: string;
}
