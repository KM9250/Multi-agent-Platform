import { DatabaseSync } from 'node:sqlite';
import { DurableDatabase } from '../services/coordination/durable/db.ts';
import { SqliteCoordinationRunnerStore } from '../services/coordination/durable/durableCoordinationStore.ts';
import { MacpHttpNotificationTransport } from '../services/coordination/notifications/macpTransport.ts';
import type { NotificationOptions } from '../services/coordination/durable/notificationTypes.ts';
import type { NotificationTransport } from '../services/coordination/notifications/transport.ts';
import { fresh, event } from './notification-fixture.ts';

/** Test-only process-local identities; reopening a file never restores credentials. */
export function notificationProcessHost(path: string, endpoint = 'http://127.0.0.1:9911/api/notify', hooks: {
  send?: NotificationTransport['send']; beforeSend?: () => void; afterSend?: () => void; ownerSubject?: string;
} = {}) {
  const ownerSubject = hooks.ownerSubject ?? 'owner';
  const service = Object.freeze({}), human = Object.freeze({});
  const http = new MacpHttpNotificationTransport({ endpoint, token: 'local-notification-test', allowDevelopmentLoopback: true,
    idempotencyConfirmed: true, timeoutMs: 500 });
  const transport: NotificationTransport = {
    idempotencySupported: true,
    async send(packet, signal) {
      hooks.beforeSend?.();
      const result = await (hooks.send ? hooks.send(packet, signal) : http.send(packet, signal));
      hooks.afterSend?.(); return result;
    },
  };
  const options: NotificationOptions = {
    enabled: true,
    identityVerifier: { verify(c) { return c === service ? { subjectId: 'notification-service', kind: 'SERVICE' }
      : c === human ? { subjectId: ownerSubject, kind: 'HUMAN' } : undefined; } },
    authorize: access => access.actor.subjectId === ownerSubject && access.actor.kind === 'HUMAN'
      || access.actor.subjectId === 'notification-service' && access.actor.kind === 'SERVICE'
      && ['MATERIALIZE_NOTIFICATION','CLAIM_NOTIFICATION_DELIVERY','SEND_NOTIFICATION','COLLECT_NOTIFICATION_RECEIPT'].includes(access.permission),
    output: () => true,
    registry: { resolve: () => ({ destinationId: 'process-macp', bindingVersion: '1', implementationDigest: 'process-macp-v1',
      receiverRealm: 'process-macp-realm', recipientSubject: ownerSubject, audience: 'local-test', endpoint,
      authenticated: true, allowDevelopmentLoopback: true, transportContract: 'macp/0.1.0', idempotencyConfirmed: true, transport }) },
    // Leave a bounded allowance for a fresh Node loader under concurrent full-suite load.
    // The Claim remains short enough for actual database-clock expiry tests.
    limits: { httpTimeoutMs: 500, claimTtlMs: 10000, backoffBaseMs: 0, backoffMaxMs: 0 },
  };
  const db = new DurableDatabase({ path, notifications: options }), raw = new DatabaseSync(path);
  const create = (workflowRunId = 'run') => {
    const base = new SqliteCoordinationRunnerStore(db); base.createWorkflow(fresh(workflowRunId));
    const manager = db.createLeaseManager(), lease = manager.acquire(workflowRunId), store = base.withLease(lease);
    return { store, lease, manager, cancel() { store.append(event(store.getSnapshot(workflowRunId), 'WorkflowCancelled', { reason: 'test cancellation' })); },
      block() { store.append(event(store.getSnapshot(workflowRunId), 'WorkflowBlocked', { reason: 'USER_ATTENTION_REQUIRED' })); },
      release() { manager.release(lease); } };
  };
  return { db, raw, service, human, options, create, close() { raw.close(); db.close(); } };
}
