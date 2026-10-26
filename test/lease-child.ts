// Independent Runtime with retained, non-serializable authority. Fault hooks are test-only.
import { DatabaseSync } from 'node:sqlite';
import { DurableDatabase, SqliteCoordinationRunnerStore, createRuntimeLeaseManager } from '../services/coordination/durable/index.ts';
import type { WorkflowLease } from '../services/coordination/durable/index.ts';
import { usage } from './durable-fixture.ts';
const [path, ttlArg = '1000'] = process.argv.slice(2);
const db = new DurableDatabase({ path, busyTimeoutMs: 25 });
const manager = createRuntimeLeaseManager(db, { ttlMs: Number(ttlArg) });
let lease: WorkflowLease | undefined, raw: DatabaseSync | undefined, fault = '', changed = false;
const pause = () => { process.send!({ stage: fault }); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); };
const originalPrepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function(sql: string) {
  const statement = originalPrepare.call(this, sql), run = statement.run.bind(statement);
  statement.run = (...params: any[]) => {
    const result = run(...params);
    if (/^(INSERT INTO|UPDATE) runtime_leases/.test(sql)) {
      changed = true;
      if (fault.endsWith('-before')) pause();
    }
    return result;
  };
  return statement;
};
const originalExec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function(sql: string) {
  originalExec.call(this, sql);
  if (sql === 'COMMIT' && changed && fault.endsWith('-after')) pause();
};
process.on('message', (message: any) => {
  const { requestId, command, workflow = 'run', crash = '' } = message;
  fault = crash; changed = false;
  try {
    let value: unknown;
    if (command === 'acquire') value = lease = manager.acquire(workflow);
    else if (command === 'renew') value = manager.renew(lease!);
    else if (command === 'release') manager.release(lease!);
    else if (command === 'inspect') value = manager.inspect(workflow);
    else if (command === 'append') {
      const store = new SqliteCoordinationRunnerStore(db, lease);
      value = store.append(usage(store.getSnapshot(workflow), message.eventId ?? 'child-usage')).events.length;
    } else if (command === 'lock') { raw = new DatabaseSync(path); raw.exec('BEGIN IMMEDIATE'); }
    else if (command === 'unlock') { raw!.exec('ROLLBACK'); raw!.close(); raw = undefined; }
    else if (command === 'close') { db.close(); process.send!({ requestId, value: true }); process.disconnect(); return; }
    else throw Error('Unknown test command');
    process.send!({ requestId, value });
  } catch (error) { process.send!({ requestId, code: (error as any).code ?? 'CHILD_FAILED' }); }
});
process.send!({ ready: true, runtimeInstanceId: manager.runtimeInstanceId });
