import { RecoveryReader } from '../services/coordination/durable/index.ts';
import { clock } from './durable-execution-fixture.ts';
import type { executionFixture } from './durable-execution-fixture.ts';
import { createRunnerEvent } from '../services/coordination/runner/eventFactory.ts';
export const reader = (f: ReturnType<typeof executionFixture>) => new RecoveryReader(f.db, clock);
export const tables = ['workflow_seeds','journal_events','workflow_checkpoints','pending_actions','execution_ledger','execution_results','runner_evidence','runtime_audit_events','runtime_leases','runtime_fencing_boundary'];
export function contents(f: ReturnType<typeof executionFixture>) {
  return f.db.read(tx => Object.fromEntries(tables.map(table => [table, tx.all(`SELECT * FROM ${table} ORDER BY rowid`)])));
}
/** Reader-only fixture for pre-v6 history. Deliberately bypass ONLY the new
 * resume prohibition, then restore it. Never used to exercise an execution path. */
export function appendPreV6History(f: ReturnType<typeof executionFixture>, type: 'WorkflowResumed' | 'WorkflowSuspended', payload: unknown) {
  const raw=f.raw(), sql=String(raw.prepare("SELECT sql FROM sqlite_master WHERE name='recovery_resume_disabled'").get()!.sql);
  raw.exec('DROP TRIGGER recovery_resume_disabled');
  try {
    const event=createRunnerEvent(f.snapshot(),type,payload,clock,{nextId:()=>`pre-v6-${f.snapshot().events.length}`});
    f.store.writeWorkflow('run',tx=>f.store.appendInTransaction(tx,event));
  } finally {raw.exec(sql);}
}
