// Fault injection only in this child process; production code has no crash hooks.
import { DatabaseSync } from 'node:sqlite';
import { DurableDatabase, SqliteCoordinationRunnerStore, DurableExecutionCoordinator } from '../services/coordination/durable/index.ts';
import { createRunnerEvent } from '../services/coordination/runner/eventFactory.ts';
import { clock } from './durable-execution-fixture.ts';
const [path, operation, boundary, resultRef] = process.argv.slice(2);
const pause = () => { process.send!({ operation, boundary }); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); };
let armed = false;
const originalPrepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function(sql: string) {
  const statement = originalPrepare.call(this, sql), run = statement.run.bind(statement);
  statement.run = (...params: any[]) => {
    const target = operation === 'journal' ? sql.startsWith('INSERT INTO journal_events')
      : operation === 'reserve' ? sql.startsWith("UPDATE execution_ledger SET state = 'DISPATCH_RESERVED'")
      : operation === 'review' ? sql.startsWith("UPDATE execution_ledger SET state = 'REVIEW_REQUIRED'")
      : ['result','finalize'].includes(operation) && sql.startsWith('UPDATE execution_ledger SET state = ?')
        && params[0] === (operation === 'result' ? 'RESULT_RECORDED' : 'FINALIZED');
    if (target && boundary === 'before-update') pause();
    const result = run(...params);
    if (target) { armed = true; if (boundary === 'after-update') pause(); }
    return result;
  };
  return statement;
};
const originalExec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function(sql: string) {
  if (operation === 'migration' && sql.includes('CREATE TABLE runtime_audit_events')) {
    if (boundary === 'before-update') pause();
    if (boundary === 'after-update') { originalExec.call(this, sql.slice(0, sql.indexOf('CREATE TRIGGER journal_audit_insert'))); pause(); }
    armed = true;
  }
  originalExec.call(this, sql);
  if (sql === 'COMMIT' && armed && boundary === 'after-commit') pause();
};
try {
  const db = new DurableDatabase({ path }), store = new SqliteCoordinationRunnerStore(db);
  const coordinator = new DurableExecutionCoordinator(store, { get(id) { return id === 'test' ? { id: 'test', async prepare() { throw Error('Unexpected prepare'); }, async execute() { process.send!({ error: 'UNEXPECTED_EXECUTOR' }); throw Error('Unexpected execute'); } } : undefined; } }, { clock });
  const s = store.getSnapshot('run'), task = s.tasks.task;
  if (operation === 'reserve') coordinator.reserveDispatch('run', task);
  if (operation === 'review') coordinator.requireReview('run', task, 'EXECUTION_UNCERTAIN');
  if (operation === 'result') coordinator.recordResult('run', task, coordinator.inspectExecution('run', 'action')!.attemptId!, { status: 'succeeded', summary: 'done', resultRef });
  if (operation === 'finalize') coordinator.finalizeResult('run', task);
  if (operation === 'journal') store.append(createRunnerEvent(s, 'UsageRecorded', { llmCalls: 1, inputTokens: 0, outputTokens: 0, estimatedCost: 0 }, clock, { nextId: () => 'crash-usage' }));
  throw Error('Expected crash boundary was not reached');
} catch (error) { process.send!({ error: (error as any).code ?? 'CHILD_FAILED' }); process.disconnect(); process.exitCode = 1; }
