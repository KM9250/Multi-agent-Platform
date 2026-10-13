import { sanitizeCoordinationNotification } from './sanitize';
import type { CoordinationNotification, CoordinationNotificationKind } from './types';

/** MACP 0.1.0 protocol.md §3/§8. Unknown task_type/metadata are permitted. */
export interface MacpNotificationPacket {
  protocol: 'macp'; version: '0.1.0'; task_id: string; task_type: 'coordination';
  from: { agent_id: 'map-coordination' }; to: { type: 'user' };
  intent: 'notify_user' | 'need_review'; status: 'done' | 'need_review' | 'blocked';
  priority: 'normal' | 'high'; summary: string;
  evaluation: { requires_user_action: boolean };
  metadata: { notification_kind: CoordinationNotificationKind };
  created_at: string;
}
export function toMacpNotificationPacket(notification: CoordinationNotification): MacpNotificationPacket {
  const n = sanitizeCoordinationNotification(notification);
  const review = n.requiresUserAction && n.kind !== 'budget_exhausted';
  return { protocol: 'macp', version: '0.1.0', task_id: n.notificationId, task_type: 'coordination',
    from: { agent_id: 'map-coordination' }, to: { type: 'user' },
    intent: review ? 'need_review' : 'notify_user',
    status: n.kind === 'budget_exhausted' ? 'blocked' : review ? 'need_review' : 'done',
    priority: n.priority, summary: n.safeSummary, evaluation: { requires_user_action: n.requiresUserAction },
    metadata: { notification_kind: n.kind }, created_at: new Date(n.occurredAt).toISOString() };
}
