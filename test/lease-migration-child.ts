import { DatabaseSync } from 'node:sqlite';
import { DurableDatabase } from '../services/coordination/durable/index.ts';
const [path, boundary] = process.argv.slice(2);
const exec = DatabaseSync.prototype.exec;
let armed = false;
const pause = () => { process.send!({ stage: boundary }); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); };
DatabaseSync.prototype.exec = function(sql: string) {
  if (sql.includes('CREATE TABLE runtime_leases')) {
    if (boundary === 'before-ddl') pause();
    armed = true;
  }
  exec.call(this, sql);
  if (armed && (boundary === 'after-ddl' || sql === 'COMMIT' && boundary === 'after-commit')) pause();
};
try { new DurableDatabase({ path }); process.send!({ code: 'BOUNDARY_MISSING' }); }
catch (error) { process.send!({ code: (error as any).code ?? 'CHILD_FAILED' }); }
process.disconnect();
