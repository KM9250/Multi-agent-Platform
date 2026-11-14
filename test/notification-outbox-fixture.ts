import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { TestContext } from 'node:test';
import { DurableDatabase } from '../services/coordination/durable/db.ts';
import { SqliteCoordinationRunnerStore } from '../services/coordination/durable/durableCoordinationStore.ts';
import type { NotificationAccess, NotificationDestination, NotificationOptions, NotificationPermission } from '../services/coordination/durable/notificationTypes.ts';
import type { NotificationTransport } from '../services/coordination/notifications/transport.ts';
import type { MacpNotificationPacket } from '../services/coordination/notifications/macpPacket.ts';
import type { CoordinationEventType } from '../services/coordination/types.ts';
import { fresh, event } from './notification-fixture.ts';

/** Synthetic host identity and transport, intentionally confined to test code. */
export function notificationFixture(t: Pick<TestContext, 'after'>, overrides: Partial<NotificationOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'map-notification-')), path = join(dir, 'notifications.sqlite');
  const service = Object.freeze({}), human = Object.freeze({}), stranger = Object.freeze({});
  const packets: MacpNotificationPacket[] = [], calls: NotificationAccess[] = [], outputs: unknown[] = [];
  const denied = new Set<NotificationPermission>();
  const hooks = {
    allowOutput: true,
    allowIdentity: true,
    authorize: (_access: NotificationAccess) => true,
    output: (_access: NotificationAccess, _value: unknown) => true,
    send: undefined as NotificationTransport['send'] | undefined,
  };
  const transport: NotificationTransport = {
    idempotencySupported: true,
    async send(packet, signal) {
      packets.push(structuredClone(packet));
      if (hooks.send) return hooks.send(packet, signal);
      return { taskId: packet.task_id, eventId: 1, idempotentReplay: packets.length > 1, httpStatus: packets.length > 1 ? 200 : 201 };
    },
  };
  let binding: NotificationDestination | undefined = {
    destinationId: 'local-macp', bindingVersion: '1', implementationDigest: 'local-macp-implementation-v1',
    receiverRealm: 'local-macp-realm-v1', recipientSubject: 'owner', audience: 'local-test',
    endpoint: 'http://127.0.0.1:9911/api/notify', authenticated: true, allowDevelopmentLoopback: true,
    transportContract: 'macp/0.1.0', idempotencyConfirmed: true, transport,
  };
  const options: NotificationOptions = {
    enabled: true,
    identityVerifier: { verify(c) {
      if (!hooks.allowIdentity) return undefined;
      return c === service ? { subjectId: 'notification-service', kind: 'SERVICE' as const }
        : c === human ? { subjectId: 'owner', kind: 'HUMAN' as const }
        : c === stranger ? { subjectId: 'stranger', kind: 'HUMAN' as const } : undefined;
    } },
    authorize(access) {
      calls.push(structuredClone(access));
      return access.actor.subjectId !== 'stranger' && !denied.has(access.permission) && hooks.authorize(access);
    },
    output(access, value) { outputs.push(structuredClone(value)); return hooks.allowOutput && hooks.output(access, value); },
    registry: { resolve: () => binding },
    limits: { backoffBaseMs: 0, backoffMaxMs: 0 },
    ...overrides,
  };
  const connections: { close(): void }[] = [];
  const open = (customOptions = options) => {
    const db = new DurableDatabase({ path, notifications: customOptions }); connections.push(db); return db;
  };
  const db = open(), raw = new DatabaseSync(path); connections.push(raw);
  t.after(() => { for (const connection of connections.reverse()) connection.close(); rmSync(dir, { recursive: true, force: true }); });
  const create = (id = 'run') => {
    const base = new SqliteCoordinationRunnerStore(db); base.createWorkflow(fresh(id));
    const manager = db.createLeaseManager(), lease = manager.acquire(id), store = base.withLease(lease);
    return { manager, lease, store, append(type: CoordinationEventType, payload: unknown) {
      return store.append(event(store.getSnapshot(id), type, payload));
    }, release() { manager.release(lease); } };
  };
  const business = () => Object.fromEntries(raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'notification_%' ORDER BY name").all()
    .map(row => [String(row.name), raw.prepare(`SELECT * FROM "${row.name}" ORDER BY rowid`).all()]));
  const allTables = () => Object.fromEntries(raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(row => [String(row.name), raw.prepare(`SELECT * FROM "${row.name}" ORDER BY rowid`).all()]));
  return { dir, path, db, raw, service, human, stranger, packets, calls, outputs, denied, hooks, options, transport, open, create, business, allTables,
    get binding() { return binding; }, set binding(value: NotificationDestination | undefined) { binding = value; } };
}
