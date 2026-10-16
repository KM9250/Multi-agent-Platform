import { toMacpNotificationPacket } from './macpPacket';
import { DeliveryError } from './deliveryError';
import type { NotificationDeliveryReceipt } from './deliveryError';
import { sanitizeCoordinationNotification } from './sanitize';
import type { CoordinationNotification, NotificationDeliveryAttempt, NotificationOutboxEntry } from './types';

/** Ephemeral delivery bookkeeping. The Journal remains authoritative. */
export class InMemoryNotificationOutbox {
  private readonly entries = new Map<string, NotificationOutboxEntry>();
  enqueue(notification: CoordinationNotification): boolean {
    const safe = sanitizeCoordinationNotification(notification);
    if (this.entries.has(safe.notificationId)) return false;
    this.entries.set(safe.notificationId, { notification: safe, state: 'PENDING', attempts: 0, packet: toMacpNotificationPacket(safe), history: [] });
    return true;
  }
  get(notificationId: string): NotificationOutboxEntry | undefined {
    const entry = this.entries.get(notificationId);
    return entry && structuredClone(entry);
  }
  list(): NotificationOutboxEntry[] { return structuredClone([...this.entries.values()]); }
  pending(): CoordinationNotification[] {
    return this.list().filter(entry => entry.state === 'PENDING').map(entry => entry.notification);
  }
  /** Synchronous claim before any await prevents concurrent sends of one ID. */
  startDelivery(notificationId: string): NotificationDeliveryAttempt | undefined {
    const entry = this.entries.get(notificationId);
    if (!entry || entry.state !== 'PENDING') return;
    entry.state = 'SENDING'; entry.attempts++;
    entry.history.push({ attempt: entry.attempts, state: 'SENDING' });
    return { notification: structuredClone(entry.notification), packet: structuredClone(entry.packet), attempt: entry.attempts };
  }
  suppress(notificationId: string): boolean {
    const entry = this.entries.get(notificationId);
    if (!entry || entry.state !== 'PENDING' || !entry.notification.requiresUserAction) return false;
    entry.state = 'SUPPRESSED';
    return true;
  }
  recordPreflightFailure(notificationId: string): void {
    const entry = this.entries.get(notificationId);
    if (entry?.state === 'PENDING') {
      entry.state = 'DELIVERY_FAILED'; entry.failureCode = 'SNAPSHOT_UNAVAILABLE';
    }
  }
  recordDelivered(notificationId: string, attempt: number, receipt?: NotificationDeliveryReceipt): boolean {
    return this.finish(notificationId, attempt, undefined, receipt);
  }
  recordDeliveryFailed(notificationId: string, attempt: number, error = new DeliveryError('NOTIFICATION_DELIVERY_FAILED')): boolean {
    return this.finish(notificationId, attempt, error);
  }
  private finish(notificationId: string, attempt: number, error?: DeliveryError, receipt?: NotificationDeliveryReceipt): boolean {
    const entry = this.entries.get(notificationId);
    if (!entry || entry.state !== 'SENDING' || entry.attempts !== attempt) return false;
    entry.state = error ? 'DELIVERY_FAILED' : 'DELIVERED';
    const record = entry.history.at(-1)!;
    record.state = entry.state;
    if (error) {
      entry.failureCode = error.code; record.errorCode = error.code;
      if (error.httpStatus !== undefined) record.httpStatus = error.httpStatus;
    }
    if (receipt) {
      // Select only allowed audit fields, never transport-specific extras.
      entry.receipt = { taskId: receipt.taskId, eventId: receipt.eventId,
        idempotentReplay: receipt.idempotentReplay, httpStatus: receipt.httpStatus };
      record.receipt = structuredClone(entry.receipt); record.httpStatus = receipt.httpStatus;
    }
    return true;
  }
  prepareRetry(notificationId: string): boolean {
    const entry = this.entries.get(notificationId);
    if (!entry || entry.state !== 'DELIVERY_FAILED') return false;
    entry.state = 'PENDING'; delete entry.failureCode;
    return true;
  }
}
