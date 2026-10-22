import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DurableDatabase, RecoveryReader } from '../services/coordination/durable/index.ts';
import { executionFixture, clock } from './durable-execution-fixture.ts';
import { contents } from './recovery-fixture.ts';
import { historicalDatabase } from './recovery-migration-fixture.ts';

async function killAt(t: TestContext, path: string, operation: string, boundary: string, resultRef = '') {
  const child = fork(fileURLToPath(new URL('./recovery-crash-child.ts', import.meta.url)), [path, operation, boundary, resultRef], {
    execArgv: ['--experimental-transform-types','--loader',fileURLToPath(new URL('./ts-loader.mjs', import.meta.url))], stdio: ['ignore','ignore','ignore','ipc'],
  });
  const closed = new Promise<{ code: number | null; signal: string | null }>(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  let timer: ReturnType<typeof setTimeout>;
  const boundaryReached = new Promise<any>((resolve, reject) => {
    timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error('Crash child timeout')); }, 15000);
    child.once('error', reject); child.once('message', resolve);
    child.once('exit', () => reject(Error('Crash child exited before boundary')));
  });
  t.after(async () => { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed; });
  const message = await boundaryReached; clearTimeout(timer); assert.deepEqual(message, { operation, boundary });
  child.kill('SIGKILL'); const exit = await closed; assert.equal(exit.signal, 'SIGKILL');
}
for (const operation of ['reserve','result','review','finalize','journal'] as const) for (const boundary of ['before-update','after-update','after-commit'] as const)
  test(`real SIGKILL ${operation}/${boundary}: state and audit commit atomically`, async t => {
    const f = executionFixture(t), task = f.register(); let resultRef = '';
    if (operation === 'result' || operation === 'review') f.coordinator.reserveDispatch('run', task);
    if (operation === 'result') resultRef = await f.coordinator.evidenceStore.withOwner({ workflowRunId: 'run', sessionId: 'session', taskId: 'task', actionId: 'action' },
      () => f.coordinator.evidenceStore.put({ kind: 'runner.execution', content: { status: 'succeeded' }, createdAt: 10 }));
    if (operation === 'finalize') await f.coordinator.dispatch('run', task);
    const before = contents(f), calls = { ...f.calls }; f.db.close();
    await killAt(t, f.path, operation, boundary, resultRef);
    const reopened = f.open(), after = reopened.db.read(tx => Object.fromEntries(Object.keys(before).map(table => [table, tx.all(`SELECT * FROM ${table} ORDER BY rowid`)])));
    if (boundary !== 'after-commit') assert.deepEqual(after, before);
    else {
      assert.equal(after.journal_events.length - before.journal_events.length, ['journal','finalize'].includes(operation) ? 1 : 0);
      assert.equal(after.runtime_audit_events.length - before.runtime_audit_events.length, operation === 'finalize' ? 2 : 1);
      assert.equal(after.execution_ledger[0].state, operation === 'reserve' ? 'DISPATCH_RESERVED' : operation === 'result' ? 'RESULT_RECORDED' : operation === 'review' ? 'REVIEW_REQUIRED' : operation === 'finalize' ? 'FINALIZED' : 'PREPARED');
    }
    const r = new RecoveryReader(reopened.db, clock); r.inspect('run'); r.inspect('run'); r.getWorkflowTimeline('run');
    assert.deepEqual(reopened.db.read(tx => tx.all('SELECT * FROM runtime_audit_events ORDER BY rowid')), after.runtime_audit_events);
    assert.deepEqual(f.calls, calls); assert.notEqual(r.inspect('run').disposition, 'RECOVERY_FAILED');
  });
for (const boundary of ['before-update','after-update','after-commit'] as const) test(`real SIGKILL Migration 003/${boundary}: DDL, triggers and migration ledger recover together`, async t => {
  const f = executionFixture(t), task = f.register(); await f.coordinator.dispatch('run', task); f.coordinator.finalizeResult('run', task); f.store.createCheckpoint('run');
  const path = join(f.dir, 'migration-crash.sqlite'), before = historicalDatabase(f, path, 2);
  await killAt(t, path, 'migration', boundary);
  const raw = new DatabaseSync(path); t.after(() => raw.close()); const committed = boundary === 'after-commit';
  assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version, committed ? 3 : 2);
  assert.equal(raw.prepare('SELECT count(*) AS n FROM schema_migrations').get()!.n, committed ? 3 : 2);
  assert.equal(raw.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name IN ('journal_audit_insert','ledger_audit_insert','ledger_audit_update')").get()!.n, committed ? 3 : 0);
  for (const [table, rows] of Object.entries(before)) assert.deepEqual(raw.prepare(`SELECT * FROM ${table}`).all(), rows);
  const db = new DurableDatabase({ path });
  try { assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version, 3); assert.equal(new RecoveryReader(db, clock).inspect('run').executionStates[0].state, 'FINALIZED'); }
  finally { db.close(); }
});
