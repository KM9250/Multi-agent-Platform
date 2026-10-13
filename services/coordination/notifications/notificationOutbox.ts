import { sanitizeCoordinationNotification } from './sanitize';
import type { CoordinationNotification, NotificationDeliveryAttempt, NotificationOutboxEntry } from './types';

/** Ephemeral delivery bookkeeping. The Journal remains authoritative. */
export class InMemoryNotificationOutbox {
  private readonly entries = new Map<string, NotificationOutboxEntry>();
  enqueue(notification: CoordinationNotification): boolean {
    const safe = sanitizeCoordinationNotification(notification);
    if (this.entries.has(safe.notificationId)) return false;
    this.entries.set(safe.notificationId, { notification: safe, state: 'PENDING', attempts: 0 });
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
    return { notification: structuredClone(entry.notification), attempt: entry.attempts };
  }
  recordDelivered(notificationId: string, attempt: number): boolean { return this.finish(notificationId, attempt, true); }
  recordDeliveryFailed(notificationId: string, attempt: number): boolean { return this.finish(notificationId, attempt, false); }
  private finish(notificationId: string, attempt: number, delivered: boolean): boolean {
    const entry = this.entries.get(notificationId);
    if (!entry || entry.state !== 'SENDING' || entry.attempts !== attempt) return false;
    entry.state = delivered ? 'DELIVERED' : 'DELIVERY_FAILED';
    if (!delivered) entry.failureCode = 'NOTIFICATION_DELIVERY_FAILED';
    return true;
  }
  prepareRetry(notificationId: string): boolean {
    const entry = this.entries.get(notificationId);
    if (!entry || entry.state !== 'DELIVERY_FAILED') return false;
    entry.state = 'PENDING'; delete entry.failureCode;
    return true;
  }
}
