import { RecoveryReader } from '../services/coordination/durable/index.ts';
import { clock } from './durable-execution-fixture.ts';
import type { executionFixture } from './durable-execution-fixture.ts';
export const reader = (f: ReturnType<typeof executionFixture>) => new RecoveryReader(f.db, clock);
export const tables = ['workflow_seeds','journal_events','workflow_checkpoints','pending_actions','execution_ledger','execution_results','runner_evidence','runtime_audit_events','runtime_leases','runtime_fencing_boundary'];
export function contents(f: ReturnType<typeof executionFixture>) {
  return f.db.read(tx => Object.fromEntries(tables.map(table => [table, tx.all(`SELECT * FROM ${table} ORDER BY rowid`)])));
}
