import type { MacpNotificationPacket } from './macpPacket';
import type { NotificationDeliveryReceipt } from './deliveryError';

export interface NotificationTransport {
  readonly idempotencySupported?: boolean;
  send(packet: MacpNotificationPacket, signal?: AbortSignal): Promise<NotificationDeliveryReceipt | void>;
}
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
// Preserve the COORD-4A import path. All deliveries now require a snapshot reader.
export { deliverCoordinationNotification } from './delivery';
