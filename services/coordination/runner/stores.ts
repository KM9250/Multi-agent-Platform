import { appendEvent } from '../kernel';
import { validateCoordinationSnapshot } from '../validation';
import type { CoordinationEvent, CoordinationSnapshot } from '../types';
import type { CoordinationRunnerStore, RunnerPendingActionRecord, RunnerEvidence, RunnerEvidenceStore, RunnerIdGenerator, RunnerPendingActionStore } from './types';

export const defaultRunnerIds: RunnerIdGenerator = { nextId: kind => `${kind}-${globalThis.crypto.randomUUID()}` };
export class InMemoryCoordinationRunnerStore implements CoordinationRunnerStore {
  private readonly snapshots = new Map<string, CoordinationSnapshot>();
  constructor(snapshots: CoordinationSnapshot[]) {
    for (const snapshot of snapshots) {
      validateCoordinationSnapshot(snapshot);
      if (this.snapshots.has(snapshot.run.runId)) throw new Error('Duplicate workflow.');
      this.snapshots.set(snapshot.run.runId, structuredClone(snapshot));
    }
  }
  getSnapshot(id: string): CoordinationSnapshot {
    const snapshot = this.snapshots.get(id);
    if (!snapshot) throw new Error(`Unknown workflow: ${id}`);
    return structuredClone(snapshot);
  }
  append(event: CoordinationEvent): CoordinationSnapshot {
    const next = appendEvent(this.getSnapshot(event.workflowRunId), event);
    this.snapshots.set(event.workflowRunId, structuredClone(next));
    return structuredClone(next);
  }
}
export class InMemoryRunnerPendingActionStore implements RunnerPendingActionStore {
  private readonly actions = new Map<string, Map<string, RunnerPendingActionRecord>>();
  get(workflowRunId: string, actionId: string): RunnerPendingActionRecord | undefined {
    const record = this.actions.get(workflowRunId)?.get(actionId);
    return record && structuredClone(record);
  }
  put(record: RunnerPendingActionRecord): void {
    for (const id of [record.workflowRunId, record.sessionId, record.taskId, record.action.actionId]) {
      if (typeof id !== 'string' || !id.trim()) throw new Error('Pending action ownership IDs are required.');
    }
    const actions = this.actions.get(record.workflowRunId) ?? new Map<string, RunnerPendingActionRecord>();
    if (actions.has(record.action.actionId)) throw new Error('Pending action ID already exists in workflow.');
    actions.set(record.action.actionId, structuredClone(record));
    this.actions.set(record.workflowRunId, actions);
  }
  delete(workflowRunId: string, actionId: string): void {
    const actions = this.actions.get(workflowRunId);
    actions?.delete(actionId);
    if (!actions?.size) this.actions.delete(workflowRunId);
  }
}
export class InMemoryRunnerEvidenceStore implements RunnerEvidenceStore {
  private readonly evidence = new Map<string, RunnerEvidence>();
  private readonly ids: RunnerIdGenerator;
  constructor(ids: RunnerIdGenerator = defaultRunnerIds) { this.ids = ids; }
  async put(evidence: RunnerEvidence): Promise<string> {
    const ref = `map.runner.evidence.v1:${this.ids.nextId('evidence')}`;
    if (this.evidence.has(ref)) throw new Error('Evidence ID already exists.');
    this.evidence.set(ref, structuredClone(evidence)); return ref;
  }
  async get(ref: string): Promise<RunnerEvidence | undefined> {
    const evidence = this.evidence.get(ref); return evidence && structuredClone(evidence);
  }
}
