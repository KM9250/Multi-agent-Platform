// Real process-boundary fault injection. No fault hooks ship in the production API.
import { DatabaseSync } from 'node:sqlite';
import { DurableDatabase, SqliteCoordinationRunnerStore } from '../services/coordination/durable/index.ts';
const [path, mode] = process.argv.slice(2);
const db = new DurableDatabase({ path }), store = new SqliteCoordinationRunnerStore(db);
const pause = () => { process.send!({ stage: mode }); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); };
if (mode === 'before-commit' || mode === 'checkpoint') {
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function(sql: string) {
    const statement = prepare.call(this, sql);
    const target = mode === 'checkpoint' ? 'INSERT INTO workflow_checkpoints' : 'INSERT INTO journal_events';
    if (sql.startsWith(target)) {
      const run = statement.run.bind(statement);
      statement.run = (...params: any[]) => { const result = run(...params); pause(); return result; };
    }
    return statement;
  };
}
if (mode === 'after-commit') {
  const exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function(sql: string) { exec.call(this, sql); if (sql === 'COMMIT') pause(); };
}
process.on('message', (event: any) => {
  try {
    if (mode === 'checkpoint') store.createCheckpoint('run');
    else if (mode === 'read') { const snapshot = store.getSnapshot('run'); db.close(); process.send!({ done: true, snapshot }); process.disconnect(); return; }
    else store.append(event);
    db.close(); process.send!({ done: true });
  } catch (error) { db.close(); process.send!({ done: true, code: (error as any).code }); }
  process.disconnect();
});
process.send!({ ready: true });
