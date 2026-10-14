import { toMacpNotificationPacket } from './macpPacket';
import type { MacpNotificationPacket } from './macpPacket';
import type { InMemoryNotificationOutbox } from './notificationOutbox';

export interface NotificationTransport { send(packet: MacpNotificationPacket): Promise<void> }
/** No networking, timers, workflow references, or executor dependencies. */
export class InMemoryNotificationTransport implements NotificationTransport {
  private readonly delivered: MacpNotificationPacket[] = [];
  private failures = 0;
  failNext(): void { this.failures++; }
  async send(packet: MacpNotificationPacket): Promise<void> {
    if (this.failures > 0) { this.failures--; throw new Error('Mock delivery failed.'); }
    this.delivered.push(structuredClone(packet));
  }
  packets(): MacpNotificationPacket[] { return structuredClone(this.delivered); }
}
export async function deliverCoordinationNotification(outbox: InMemoryNotificationOutbox, notificationId: string,
  transport: NotificationTransport): Promise<'delivered' | 'failed' | 'skipped'> {
  const claim = outbox.startDelivery(notificationId);
  if (!claim) return 'skipped';
  try {
    await transport.send(toMacpNotificationPacket(claim.notification));
    outbox.recordDelivered(notificationId, claim.attempt);
    return 'delivered';
  } catch {
    outbox.recordDeliveryFailed(notificationId, claim.attempt);
    return 'failed';
  }
}
