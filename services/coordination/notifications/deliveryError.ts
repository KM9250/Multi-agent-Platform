export type DeliveryErrorCode = 'NOTIFICATION_DELIVERY_FAILED' | 'INVALID_CONFIGURATION' | 'INVALID_RESPONSE'
  | 'SNAPSHOT_UNAVAILABLE' | 'NETWORK_ERROR' | 'TIMEOUT' | 'ABORTED' | 'HTTP_ERROR';

/** No raw exception, URL, token, response text or cause is retained. */
export class DeliveryError extends Error {
  constructor(readonly code: DeliveryErrorCode, readonly retryable = false, readonly httpStatus?: number) {
    super(code);
    this.name = 'DeliveryError';
  }
}
export interface NotificationDeliveryReceipt {
  taskId: string;
  eventId: number;
  idempotentReplay: boolean;
  httpStatus: number;
}
