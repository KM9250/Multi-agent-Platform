/** Informational projections only; never an authorization or Runner command. */
export type CoordinationNotificationKind =
  | 'workflow_completed' | 'workflow_cancelled' | 'action_approval_required'
  | 'security_review_required' | 'evidence_review_required' | 'execution_review_required'
  | 'budget_exhausted' | 'workflow_attention_required';

export interface CoordinationNotification {
  schemaVersion: 1;
  notificationId: string;
  workflowRunId: string;
  sourceEventId: string;
  kind: CoordinationNotificationKind;
  occurredAt: number;
  priority: 'normal' | 'high';
  requiresUserAction: boolean;
  safeSummary: string;
}

export type NotificationDeliveryState = 'PENDING' | 'SENDING' | 'DELIVERED' | 'DELIVERY_FAILED';
export interface NotificationOutboxEntry {
  notification: CoordinationNotification;
  state: NotificationDeliveryState;
  attempts: number;
  failureCode?: 'NOTIFICATION_DELIVERY_FAILED';
}
export interface NotificationDeliveryAttempt {
  notification: CoordinationNotification;
  attempt: number;
}
export type NotificationDiagnostic = { code: 'NOTIFICATION_OBSERVER_FAILED' };
export type NotificationDiagnosticSink = (diagnostic: NotificationDiagnostic) => void | Promise<void>;
