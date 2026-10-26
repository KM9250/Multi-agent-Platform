import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { RunnerEvidence, RunnerEvidenceStore } from '../runner/types';
import { DurableDatabase } from './db';
import type { DurableTransaction } from './db';
import type { WorkflowLease } from './runtimeLease';
import { digest, requireIntegrity } from './integrity';
import { EXECUTION_LIMITS, executionJson, parseExecutionJson } from './executionIntegrity';

export interface EvidenceOwner { workflowRunId: string; sessionId: string; taskId: string; actionId: string }
export class SqliteRunnerEvidenceStore implements RunnerEvidenceStore {
  private readonly owners = new AsyncLocalStorage<{ owner: EvidenceOwner; lease?: WorkflowLease }>();
  constructor(readonly database: DurableDatabase, readonly lease?: WorkflowLease) {}
  /** Trusted Coordinator scope; isolated across concurrent async execution chains. */
  withOwner<T>(owner: EvidenceOwner, fn: () => T, lease = this.lease): T { return this.owners.run({ owner: Object.freeze({ ...owner }), lease }, fn); }
  async put(evidence: RunnerEvidence): Promise<string> {
    const scope = this.owners.getStore(); requireIntegrity(scope);
    const { owner, lease } = scope;
    const json = executionJson(evidence, EXECUTION_LIMITS.evidence);
    executionJson(evidence.content, EXECUTION_LIMITS.evidence);
    requireIntegrity(typeof evidence.kind === 'string' && !!evidence.kind.trim() && Object.hasOwn(evidence, 'content')
      && Number.isFinite(evidence.createdAt) && evidence.createdAt >= 0);
    const ref = `map.runner.evidence.v1:${randomUUID()}`;
    this.database.writeWithLease(lease, owner.workflowRunId, tx => {
      const ledger = tx.get('SELECT * FROM execution_ledger WHERE workflow_run_id = ? AND action_id = ?', owner.workflowRunId, owner.actionId);
      requireIntegrity(ledger?.task_id === owner.taskId && ledger.session_id === owner.sessionId && ledger.state === 'DISPATCH_RESERVED');
      tx.run('INSERT INTO runner_evidence VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', ref, owner.workflowRunId, owner.sessionId, owner.taskId,
        owner.actionId, evidence.kind, json, digest(evidence), evidence.createdAt, 1);
    });
    return ref;
  }
  async get(ref: string): Promise<RunnerEvidence | undefined> {
    const scope = this.owners.getStore(); requireIntegrity(scope);
    const { owner, lease } = scope;
    return this.database.read(tx => this.getOwnedInTransaction(tx, owner, ref));
  }
  getOwnedEvidence(owner: EvidenceOwner, ref: string): RunnerEvidence | undefined {
    return this.database.read(tx => this.getOwnedInTransaction(tx, owner, ref));
  }
  getOwnedInTransaction(tx: DurableTransaction, owner: EvidenceOwner, ref: string): RunnerEvidence | undefined {
    this.database.assertTransaction(tx);
    const row = tx.get('SELECT * FROM runner_evidence WHERE evidence_ref = ?', ref);
    if (!row) return;
    requireIntegrity(row.workflow_run_id === owner.workflowRunId && row.task_id === owner.taskId
      && row.action_id === owner.actionId && row.session_id === owner.sessionId && row.schema_version === 1);
    const item = parseExecutionJson<RunnerEvidence>(row.content_json, EXECUTION_LIMITS.evidence);
    requireIntegrity(item && row.content_digest === digest(item) && row.kind === item.kind && row.created_at === item.createdAt
      && typeof item.kind === 'string' && !!item.kind.trim() && Object.hasOwn(item, 'content')
      && Number.isFinite(item.createdAt) && item.createdAt >= 0);
    return item;
  }
}
