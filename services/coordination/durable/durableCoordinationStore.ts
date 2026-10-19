import { appendEvent } from '../kernel';
import { validateCoordinationSnapshot } from '../validation';
import type { CoordinationEvent, CoordinationSnapshot } from '../types';
import type { CoordinationRunnerStore } from '../runner/types';
import { DurableDatabase } from './db';
import type { DurableTransaction } from './db';
import { findCheckpoint, writeCheckpoint } from './checkpoint';
import type { WorkflowCheckpoint } from './checkpoint';
import { canonicalJson, digest, DurableStoreError, guarded, jsonCopy, requireIntegrity } from './integrity';
import { nextAnchor, readJournal, validateSeed } from './restore';
import { SCHEMA_VERSION } from './schema';

export interface DurableCoordinationAdministration {
  createWorkflow(snapshot: CoordinationSnapshot): void;
  listWorkflowIds(): string[];
  restoreWorkflow(id: string): CoordinationSnapshot;
  createCheckpoint(id: string): WorkflowCheckpoint;
  loadCheckpoint(id: string): WorkflowCheckpoint | undefined;
}
function insertEvent(tx: DurableTransaction, event: CoordinationEvent): void {
  tx.run('INSERT INTO journal_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    event.workflowRunId, event.sequence, event.eventId, event.type, event.sessionId ?? null,
    event.actorAgentId ?? null, event.timestamp, event.idempotencyKey || null, canonicalJson(event), digest(event));
}

/** Server-only persistence. Construction/restore never creates or invokes a Runner. */
export class SqliteCoordinationRunnerStore implements CoordinationRunnerStore, DurableCoordinationAdministration {
  constructor(private readonly database: DurableDatabase) {}
  createWorkflow(input: CoordinationSnapshot): void {
    const seed = validateSeed(input);
    this.database.write(tx => {
      const id = seed.run.runId;
      if (tx.get('SELECT workflow_run_id FROM workflow_seeds WHERE workflow_run_id = ?', id)) throw new DurableStoreError('WORKFLOW_EXISTS');
      tx.run('INSERT INTO workflow_seeds VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', id, SCHEMA_VERSION,
        canonicalJson(seed), canonicalJson(seed.policy), digest(seed), digest(seed.policy), seed.run.createdAt,
        1, nextAnchor('', seed.events[0]));
      insertEvent(tx, seed.events[0]);
    });
  }
  listWorkflowIds(): string[] {
    return this.database.read(tx => tx.all('SELECT workflow_run_id FROM workflow_seeds ORDER BY workflow_run_id').map(row => String(row.workflow_run_id)));
  }
  getSnapshot(id: string): CoordinationSnapshot { return this.restoreWorkflow(id); }
  restoreWorkflow(id: string): CoordinationSnapshot {
    return this.database.read(tx => {
      const journal = readJournal(tx, id);
      const checkpoint = findCheckpoint(tx, journal);
      if (!checkpoint) return journal.snapshot;
      let state = checkpoint.snapshot;
      for (const event of journal.events.slice(checkpoint.lastSequence)) state = guarded('INTEGRITY_ERROR', () => appendEvent(state, event));
      guarded('INTEGRITY_ERROR', () => validateCoordinationSnapshot(state));
      requireIntegrity(canonicalJson(state) === canonicalJson(journal.snapshot));
      return state;
    });
  }
  append(event: CoordinationEvent): CoordinationSnapshot {
    return this.database.write(tx => this.appendInTransaction(tx, event));
  }
  /** Trusted future participants share the writer; result is provisional until write() returns.
   * No independent COMMIT, nested transaction, async work or external effects are permitted.
   */
  appendInTransaction(tx: DurableTransaction, input: CoordinationEvent): CoordinationSnapshot {
    this.database.assertTransaction(tx, true);
    canonicalJson(input.payload); // Undefined payload roots are never silently dropped.
    const event = jsonCopy(input);
    const journal = readJournal(tx, event.workflowRunId);
    const state = journal.snapshot;
    const byId = state.events.find(e => e.eventId === event.eventId);
    const byKey = event.idempotencyKey
      ? state.events.find(e => e.idempotencyKey === event.idempotencyKey)
      : undefined;
    // Resolve identity before semantic comparison: equal content cannot merge distinct committed events.
    if (byId && byKey && byId.eventId !== byKey.eventId) throw new DurableStoreError('EVENT_COLLISION');
    const match = byId ?? byKey;
    if (match) {
      const probe = { ...event, eventId: match.eventId, idempotencyKey: match.idempotencyKey };
      guarded('EVENT_COLLISION', () => appendEvent(state, probe)); // Kernel owns semantic equality.
      return state;
    }
    if (event.sequence !== state.events.length + 1) throw new DurableStoreError('SEQUENCE_CONFLICT');
    const next = guarded('INVALID_EVENT', () => {
      const snapshot = appendEvent(state, event);
      validateCoordinationSnapshot(snapshot);
      return snapshot;
    });
    insertEvent(tx, event);
    tx.run('UPDATE workflow_seeds SET last_sequence = ?, journal_anchor = ? WHERE workflow_run_id = ?',
      event.sequence, nextAnchor(journal.anchors.at(-1)!, event), event.workflowRunId);
    return next;
  }
  createCheckpoint(id: string): WorkflowCheckpoint {
    return this.database.write(tx => writeCheckpoint(tx, readJournal(tx, id)));
  }
  loadCheckpoint(id: string): WorkflowCheckpoint | undefined {
    return this.database.read(tx => findCheckpoint(tx, readJournal(tx, id)));
  }
}
