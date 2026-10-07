import { appendEvent } from '../kernel';
import { validateCoordinationSnapshot } from '../validation';
import type { CoordinationEvent, CoordinationSnapshot } from '../types';
import type { CoordinationRunnerStore, PreparedRunnerAction, RunnerEvidence, RunnerEvidenceStore, RunnerIdGenerator, RunnerPendingActionStore } from './types';

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
  private readonly actions = new Map<string, PreparedRunnerAction>();
  get(id: string): PreparedRunnerAction | undefined { const action = this.actions.get(id); return action && structuredClone(action); }
  put(action: PreparedRunnerAction): void {
    if (this.actions.has(action.actionId)) throw new Error('Pending action ID already exists.');
    this.actions.set(action.actionId, structuredClone(action));
  }
  delete(id: string): void { this.actions.delete(id); }
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
