import { randomUUID } from 'node:crypto';
import type { DurableDatabase } from './db';

// Process identity, never derived from an Agent, restored snapshot or external payload.
export const runtimeInstanceId = randomUUID();
export const DEFAULT_LEASE_TTL_MS = 30_000;
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;

/** Public metadata. Only the original in-process object is an authority handle. */
export interface WorkflowLease {
  readonly workflowRunId: string;
  readonly runtimeInstanceId: string;
  readonly generation: number;
  readonly acquiredAt: number;
  readonly expiresAt: number;
}
export interface LeaseInspection {
  workflowRunId: string;
  runtimeInstanceId: string;
  generation: number;
  acquiredAt: number;
  heartbeatAt: number;
  expiresAt: number;
  state: 'ACTIVE' | 'EXPIRED' | 'RELEASED';
  inspectedAt: number;
  executionAllowed: false;
}
export interface RuntimeLeaseOptions { ttlMs?: number; heartbeatIntervalMs?: number }
export interface RuntimeLeaseManager {
  readonly runtimeInstanceId: string;
  acquire(workflowRunId: string): WorkflowLease;
  renew(lease: WorkflowLease): WorkflowLease;
  assertCurrent(lease: WorkflowLease): void;
  release(lease: WorkflowLease): void;
  inspect(workflowRunId: string): LeaseInspection | undefined;
  /** Explicit lifecycle. Failure permanently invalidates this handle; no recovery/retry. */
  startHeartbeat(lease: WorkflowLease, onLost: (code: string) => void): () => void;
}
export function createRuntimeLeaseManager(database: DurableDatabase, options: RuntimeLeaseOptions = {}): RuntimeLeaseManager {
  return database.createLeaseManager(options);
}
