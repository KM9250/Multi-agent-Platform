import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { MIGRATIONS, SCHEMA_VERSION } from '../services/coordination/durable/schema.ts';
import { NOTIFICATION_COLUMNS } from '../services/coordination/durable/notificationSchema.ts';
import { digest, parseJson } from '../services/coordination/durable/integrity.ts';
import { notificationFixture } from './notification-outbox-fixture.ts';
import { event } from './notification-fixture.ts';

const historicalHashes = [
 '1081504f04e79db1588340ba0302991aeb42e3373b0edd9ba57810278e249566',
 'e260ee0f529e194487c363a3f13c965846165cfc0fba7577b8e221b331698189',
 '6586d8c14f895edf62d23612c4b4a67793a511e7c0f0eb064a944728cda7b94a',
 'e2ef99a787649bb2bc2e0107db24513c6189e98ee73b029bca53bfa80b5ef114',
 'a25bf6eba0319ee028c37c8b6406d96789384a54d8e052ff24c79c0eb0b787c8',
 'a05b168f32fa5f4bbe0402d5e25918b816fa7e32368819ec714365103a779b97',
 '1cbfc30fbe2ca6503482011f8c93e79e88683b342312496f95dce9652d04a526',
 'e5dce90128045fea17ac4a074fd75b28208312b96f788f88e38662a64f2fb724',
 'ce474da204af7f9b065f726847f20ab53ae8d2c5e42988a96e399df5fa5c39a4',
 'a5240937de47521e07a4c8ac716cf8db232f05a90ef9279b53b134076b42d3a2',
];

test('MI-01: schema11 is additive and every generated Migration001–010 SQL hash matches c89b5cd', () => {
 assert.equal(SCHEMA_VERSION,11);
 assert.equal(MIGRATIONS.at(-1)!.id,'011_durable_notification_outbox');
 assert.deepEqual(MIGRATIONS.slice(0,10).map(m=>createHash('sha256').update(m.sql).digest('hex')),historicalHashes);
});

test('AU-D09: each notification table is STRICT, guarded, append histories immutable, and scope vectors match schema', () => {
 const raw=new DatabaseSync(':memory:');
 try {
  raw.function('map_reconciliation_digest',value=>digest(parseJson(value)));
  for(const migration of MIGRATIONS)raw.exec(migration.sql);
  for(const [table,columns] of Object.entries(NOTIFICATION_COLUMNS)) {
   assert.equal(raw.prepare('SELECT strict FROM pragma_table_list WHERE name=?').get(table)!.strict,1,table);
   assert.deepEqual(raw.prepare(`PRAGMA table_info(${table})`).all().map(r=>r.name),columns,table);
   const guards=raw.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name=? ORDER BY name").all(table).map(r=>String(r.name));
   assert.ok(guards.includes(`${table}_scope_INSERT`),table);
   assert.ok(guards.includes(`${table}_no_delete`),table);
   assert.ok(guards.includes(`${table}_scope_UPDATE`)||guards.includes(`${table}_no_update`),table);
  }
  assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.equal(raw.prepare('PRAGMA integrity_check').get()!.integrity_check,'ok');
 } finally {raw.close();}
});

test('SO-02/INV-D15: source audit storage failure rolls back business, source, and every table before any HTTP', t => {
 const f=notificationFixture(t),w=f.create(),before=f.allTables();
 f.raw.exec("CREATE TRIGGER injected_notification_audit_failure BEFORE INSERT ON notification_delivery_audit BEGIN SELECT RAISE(ABORT,'TEST_NOTIFICATION_AUDIT_FAILURE'); END");
 assert.throws(()=>w.append('WorkflowCancelled',{reason:'fault-test'}));
 assert.deepEqual(f.allTables(),before);
 assert.equal(f.packets.length,0);
 f.raw.exec('DROP TRIGGER injected_notification_audit_failure');
 w.append('WorkflowCancelled',{reason:'positive-control'});
 assert.equal(f.raw.prepare('SELECT count(*) n FROM notification_sources').get()!.n,1);
 assert.equal(f.raw.prepare('SELECT count(*) n FROM notification_delivery_audit').get()!.n,1);
 assert.equal(f.packets.length,0);
});

test('AU-D10/RT-D11: querying notification scope predicate cannot grant capture power and caught denial aborts the enclosing business transaction', t => {
 const f=notificationFixture(t),w=f.create(),before=f.allTables();
 const cancellation=event(w.store.getSnapshot('run'),'WorkflowCancelled',{reason:'should-rollback'});
 assert.throws(()=>f.db.writeWithLease(w.lease,'run',tx=>{
  assert.equal(tx.get("SELECT map_notification_write('notification_sources',NULL,'[]') AS allowed")!.allowed,0);
  w.store.appendInTransaction(tx,cancellation);
 }));
 assert.deepEqual(f.allTables(),before);
 assert.equal(f.packets.length,0);
});
