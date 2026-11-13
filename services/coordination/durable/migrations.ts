import type { DatabaseSync } from 'node:sqlite';
import { canonicalJson, DurableStoreError, parseJson, requireIntegrity } from './integrity';
import { readJournal } from './restore';
import { validateAuditRow } from './recoveryAudit';
import type { DurableTransaction } from './db';
import type { RunnerModelUsage } from '../runner/types';
import { usageAmounts } from './modelBudgetGuard';
import { MIGRATIONS, SCHEMA_VERSION } from './schema';

/** Caller owns BEGIN IMMEDIATE and rollback, including the migration ledger. */
export function migrate(db: DatabaseSync, notificationBaseline?: () => void): void {
  const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
  if (!Number.isSafeInteger(version) || version < 0 || version > SCHEMA_VERSION) throw new DurableStoreError('SCHEMA_UNSUPPORTED');
  const ledgerExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
  if (!ledgerExists) {
    requireIntegrity(version === 0 && db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all().length === 0);
    db.exec('CREATE TABLE schema_migrations (schema_version INTEGER PRIMARY KEY, migration_id TEXT NOT NULL UNIQUE, applied_at INTEGER NOT NULL) STRICT');
  }
  const applied = db.prepare('SELECT * FROM schema_migrations ORDER BY schema_version').all();
  requireIntegrity(applied.length === version);
  applied.forEach((row, i) => requireIntegrity(row.schema_version === MIGRATIONS[i]?.version && row.migration_id === MIGRATIONS[i]?.id));
  for (const migration of MIGRATIONS) {
    if (migration.version <= version) continue;
    if (migration.version === 10) validateNormalUsageBackfill(db);
    db.exec(migration.sql);
    if (migration.version === 11) {
      // The transaction owner installs a private exact-row migration participant.
      // No source, delivery, transport or identity callback runs during migration.
      requireIntegrity(notificationBaseline || !db.prepare('SELECT workflow_run_id FROM workflow_seeds LIMIT 1').get());
      notificationBaseline?.();
    }
    db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(migration.version, migration.id, Date.now());
    db.exec(`PRAGMA user_version = ${migration.version}`);
  }
}

/** Refuse contradictory histories before creating the accounting authority ledger. */
function validateNormalUsageBackfill(db:DatabaseSync):void {
  const tx:DurableTransaction={get:(sql,...args)=>db.prepare(sql).get(...args),all:(sql,...args)=>db.prepare(sql).all(...args),run:()=>{throw new DurableStoreError('INVALID_TRANSACTION');}};
  const journals=new Map<string,ReturnType<typeof readJournal>>();
  const orphan=db.prepare("SELECT j.event_id FROM journal_events j LEFT JOIN model_call_ledger m ON m.workflow_run_id=j.workflow_run_id AND j.event_id=m.usage_event_id WHERE j.event_type='UsageRecorded' AND json_extract(j.payload,'$.payload.sourceRef') LIKE 'map.runner.model.%' AND (m.model_call_id IS NULL OR m.state<>'SETTLED' OR json_extract(j.payload,'$.payload.sourceRef') IS NOT 'map.runner.model.call.v1:'||m.model_call_id) LIMIT 1").get();
  requireIntegrity(!orphan);
  for(const row of db.prepare("SELECT * FROM model_call_ledger WHERE state='SETTLED'").all()) {
    const id=String(row.workflow_run_id);
    let journal=journals.get(id);if(!journal){journal=readJournal(tx,id);journals.set(id,journal);}
    const usage=parseJson<RunnerModelUsage>(row.usage_json),amounts=usageAmounts(usage);
    const event=journal.events.find(e=>e.eventId===row.usage_event_id);
    const attempt=db.prepare('SELECT * FROM model_call_attempts WHERE workflow_run_id=? AND model_call_id=? AND attempt_id=?').get(id,row.model_call_id,row.attempt_id);
    requireIntegrity(attempt && attempt.state==='SETTLED' && attempt.completeness==='COMPLETE'
      && attempt.runtime_instance_id===row.runtime_instance_id && attempt.generation===row.generation
      && row.completeness==='COMPLETE' && row.usage_cost===amounts.costMicros && amounts.llmCalls===1
      && Number.isSafeInteger(row.settled_at) && event?.type==='UsageRecorded');
    const expected={...usage,sourceRef:`map.runner.model.call.v1:${row.model_call_id}`};
    requireIntegrity(canonicalJson(event.payload)===canonicalJson(expected));
    const audit=db.prepare("SELECT * FROM runtime_audit_events WHERE workflow_run_id=? AND model_call_id=? AND attempt_id=? AND next_state='SETTLED' AND event_kind IN ('MODEL_CALL_SETTLED','MODEL_BUDGET_VIOLATION') ORDER BY audit_sequence LIMIT 1").get(id,row.model_call_id,row.attempt_id);
    requireIntegrity(audit && audit.runtime_instance_id===row.runtime_instance_id && audit.runtime_generation===row.generation);
    validateAuditRow(tx,audit);
    for(const a of db.prepare('SELECT * FROM runtime_audit_events WHERE workflow_run_id=? AND model_call_id=? ORDER BY audit_sequence').all(id,row.model_call_id)) validateAuditRow(tx,a);
  }
}
