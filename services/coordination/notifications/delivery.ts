import type { CoordinationRunnerStore } from '../runner/types';
import type { InMemoryNotificationOutbox } from './notificationOutbox';
import type { NotificationTransport } from './transport';
import { DeliveryError } from './deliveryError';
import { notificationDisposition, projectCoordinationNotifications } from './projector';

export type NotificationSnapshotReader = Pick<CoordinationRunnerStore, 'getSnapshot'>;
export type NotificationDeliveryResult = 'delivered' | 'failed' | 'skipped' | 'suppressed' | 'deferred';
export interface NotificationDeliveryOptions {
  signal?: AbortSignal;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  random?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}
const locks = new WeakMap<InMemoryNotificationOutbox, Set<string>>();
const finished = (state: string) => state === 'DELIVERED' || state === 'SUPPRESSED';

/** One workflow at a time per outbox, including backoff. No Kernel/Runner lock. */
export async function deliverCoordinationNotification(outbox: InMemoryNotificationOutbox, notificationId: string,
  transport: NotificationTransport, store: NotificationSnapshotReader, options: NotificationDeliveryOptions = {}): Promise<NotificationDeliveryResult> {
  const entry = outbox.get(notificationId);
  if (!entry || entry.state !== 'PENDING') return 'skipped';
  const maxAttempts = options.maxAttempts ?? 3, baseDelay = options.baseDelayMs ?? 250, maxDelay = options.maxDelayMs ?? 5000;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10
    || !Number.isFinite(baseDelay) || baseDelay < 0 || !Number.isFinite(maxDelay) || maxDelay < baseDelay || maxDelay > 60000) {
    throw new DeliveryError('INVALID_CONFIGURATION');
  }
  const workflowRunId = entry.notification.workflowRunId;
  const busy = locks.get(outbox) ?? new Set<string>(); locks.set(outbox, busy);
  if (busy.has(workflowRunId)) return 'skipped';
  busy.add(workflowRunId);
  try {
    while (true) {
      if (options.signal?.aborted) return 'deferred';
      try {
        // Synchronous read + check + claim: no async gap before transport.send.
        // Repeat after every backoff; never send from the enqueue-time snapshot.
        const snapshot = store.getSnapshot(workflowRunId);
        const disposition = notificationDisposition(snapshot, entry.notification);
        if (disposition === 'suppress') return outbox.suppress(notificationId) ? 'suppressed' : 'skipped';
        if (disposition === 'defer') return 'deferred';
        const order = projectCoordinationNotifications(snapshot);
        const index = order.findIndex(n => n.notificationId === notificationId);
        if (order.slice(0, index).some(n => {
          const previous = outbox.get(n.notificationId);
          return previous && !finished(previous.state);
        })) return 'skipped';
      } catch {
        outbox.recordPreflightFailure(notificationId);
        return 'failed';
      }
      const claim = outbox.startDelivery(notificationId);
      if (!claim) return 'skipped';
      try {
        const receipt = await transport.send(claim.packet, options.signal);
        outbox.recordDelivered(notificationId, claim.attempt, receipt || undefined);
        return 'delivered';
      } catch (raw) {
        const error = raw instanceof DeliveryError ? raw : new DeliveryError('NOTIFICATION_DELIVERY_FAILED');
        outbox.recordDeliveryFailed(notificationId, claim.attempt, error);
        if (!transport.idempotencySupported || !error.retryable || claim.attempt >= maxAttempts || options.signal?.aborted) return 'failed';
        const random = (options.random ?? Math.random)();
        if (!Number.isFinite(random) || random < 0 || random > 1) return 'failed';
        const delay = Math.min(maxDelay, baseDelay * 2 ** (claim.attempt - 1)) * (0.5 + random * 0.5);
        try { await (options.sleep ?? sleep)(delay, options.signal); }
        catch { return 'failed'; }
        if (options.signal?.aborted || !outbox.prepareRetry(notificationId)) return 'failed';
      }
    }
  } finally { busy.delete(workflowRunId); }
}

/** Drain each workflow in Journal order; workflows progress independently. */
export async function deliverPendingCoordinationNotifications(outbox: InMemoryNotificationOutbox,
  transport: NotificationTransport, store: NotificationSnapshotReader, options: NotificationDeliveryOptions = {}): Promise<void> {
  const workflows = new Set(outbox.pending().map(n => n.workflowRunId));
  await Promise.all([...workflows].map(async workflowRunId => {
    let ids: string[];
    try { ids = projectCoordinationNotifications(store.getSnapshot(workflowRunId)).map(n => n.notificationId); }
    catch {
      for (const n of outbox.pending().filter(n => n.workflowRunId === workflowRunId)) outbox.recordPreflightFailure(n.notificationId);
      return;
    }
    for (const id of ids) {
      if (finished(outbox.get(id)?.state ?? '') || !outbox.get(id)) continue;
      const result = await deliverCoordinationNotification(outbox, id, transport, store, options);
      if (result !== 'delivered' && result !== 'suppressed') break;
    }
  }));
}
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new DeliveryError('ABORTED')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
