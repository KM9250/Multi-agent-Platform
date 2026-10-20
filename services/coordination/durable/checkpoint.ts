import { randomUUID } from 'node:crypto';
import type { CoordinationSnapshot } from '../types';
import { validateCoordinationSnapshot } from '../validation';
import type { DurableTransaction } from './db';
import { canonicalJson, digest, parseJson, requireIntegrity } from './integrity';
import { replay } from './restore';
import type { JournalState } from './restore';
import { JOURNAL_SCHEMA_VERSION } from './schema';

export interface WorkflowCheckpoint {
  checkpointId: string; workflowRunId: string; schemaVersion: number; lastSequence: number;
  snapshot: CoordinationSnapshot; snapshotDigest: string; journalAnchor: string; createdAt: number;
}
export function writeCheckpoint(tx: DurableTransaction, journal: JournalState): WorkflowCheckpoint {
  const snapshot = journal.snapshot;
  validateCoordinationSnapshot(snapshot);
  const checkpoint: WorkflowCheckpoint = {
    checkpointId: randomUUID(), workflowRunId: snapshot.run.runId, schemaVersion: JOURNAL_SCHEMA_VERSION,
    lastSequence: snapshot.events.length, snapshot, snapshotDigest: digest(snapshot),
    journalAnchor: journal.anchors.at(-1)!, createdAt: Date.now(),
  };
  requireIntegrity(canonicalJson(snapshot.events) === canonicalJson(journal.events));
  tx.run('INSERT INTO workflow_checkpoints VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    checkpoint.checkpointId, checkpoint.workflowRunId, checkpoint.schemaVersion, checkpoint.lastSequence,
    canonicalJson(snapshot), checkpoint.snapshotDigest, checkpoint.journalAnchor, checkpoint.createdAt);
  return checkpoint;
}
/** Journal is fully validated BEFORE trying any derived checkpoint, including old prefixes. */
export function findCheckpoint(tx: DurableTransaction, journal: JournalState): WorkflowCheckpoint | undefined {
  const id = journal.seed.run.runId;
  const rows = tx.all('SELECT * FROM workflow_checkpoints WHERE workflow_run_id = ? ORDER BY last_sequence DESC, created_at DESC, checkpoint_id', id);
  for (const row of rows) {
    try {
      const n = Number(row.last_sequence);
      requireIntegrity(row.schema_version === JOURNAL_SCHEMA_VERSION && row.workflow_run_id === id && Number.isSafeInteger(n) && n >= 1 && n <= journal.events.length);
      const snapshot = parseJson<CoordinationSnapshot>(row.snapshot_payload);
      requireIntegrity(snapshot.run.runId === id && snapshot.events.length === n && digest(snapshot) === row.snapshot_digest);
      requireIntegrity(row.journal_anchor === journal.anchors[n - 1]);
      validateCoordinationSnapshot(snapshot);
      // Digest is not authentication: prove the projection against its committed prefix.
      requireIntegrity(canonicalJson(snapshot) === canonicalJson(replay(journal.seed, journal.events.slice(0, n))));
      requireIntegrity(typeof row.checkpoint_id === 'string' && !!row.checkpoint_id && Number.isSafeInteger(row.created_at) && Number(row.created_at) >= 0);
      return { checkpointId: row.checkpoint_id, workflowRunId: id, schemaVersion: JOURNAL_SCHEMA_VERSION,
        lastSequence: n, snapshot, snapshotDigest: String(row.snapshot_digest), journalAnchor: String(row.journal_anchor), createdAt: Number(row.created_at) };
    } catch { /* Derived data only. Try older checkpoints; never change the Journal. */ }
  }
  return undefined;
}
