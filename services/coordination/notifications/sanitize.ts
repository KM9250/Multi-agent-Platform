import type { CoordinationNotification, CoordinationNotificationKind } from './types';

export const MAX_NOTIFICATION_SUMMARY_LENGTH = 120;
const summaries: Record<CoordinationNotificationKind, string> = {
  workflow_completed: 'MAPの作業が完了しました。',
  workflow_cancelled: 'MAPの作業が取り消されました。',
  action_approval_required: 'MAPの作業に実行承認が必要です。',
  security_review_required: 'MAPの作業が安全確認待ちで停止しました。',
  evidence_review_required: 'MAPの実行証跡を確認できないため停止しました。',
  execution_review_required: 'MAPの実行結果が不確実なため確認が必要です。',
  budget_exhausted: 'MAPの作業が使用量上限に達しました。',
  workflow_attention_required: 'MAPの作業が停止しました。確認が必要です。',
};
export function notificationPresentation(kind: CoordinationNotificationKind): Pick<CoordinationNotification, 'safeSummary' | 'priority' | 'requiresUserAction'> {
  if (typeof kind !== 'string' || !Object.hasOwn(summaries, kind)) throw new Error('Invalid notification kind.');
  const requiresUserAction = kind !== 'workflow_completed' && kind !== 'workflow_cancelled';
  return { safeSummary: summaries[kind].slice(0, MAX_NOTIFICATION_SUMMARY_LENGTH),
    priority: requiresUserAction ? 'high' : 'normal', requiresUserAction };
}

/** Rebuild an allowlisted value; never forward extra fields or caller-supplied prose. */
export function sanitizeCoordinationNotification(value: CoordinationNotification): CoordinationNotification {
  if (!value || value.schemaVersion !== 1 || typeof value.notificationId !== 'string'
    || value.notificationId.length !== 'map.notification.v1:'.length + 64 || !/^map\.notification\.v1:[0-9a-f]{64}$/.test(value.notificationId)
    || typeof value.workflowRunId !== 'string' || !value.workflowRunId.trim()
    || typeof value.sourceEventId !== 'string' || !value.sourceEventId.trim()
    || !Number.isFinite(value.occurredAt) || value.occurredAt < 0 || !Number.isFinite(new Date(value.occurredAt).getTime())) {
    throw new Error('Invalid notification.');
  }
  return { schemaVersion: 1, notificationId: value.notificationId, workflowRunId: value.workflowRunId,
    sourceEventId: value.sourceEventId, kind: value.kind, occurredAt: value.occurredAt,
    ...notificationPresentation(value.kind) };
}
