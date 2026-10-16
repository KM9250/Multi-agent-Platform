import type { CoordinationSnapshot, WorkflowResumePayload } from '../types';
import { TERMINAL_WORKFLOW_STATUSES } from '../types';
import { validateCoordinationSnapshot } from '../validation';
import { classifyCoordinationEvent } from './classify';
import { notificationIdentity } from './identity';
import { notificationPresentation, sanitizeCoordinationNotification } from './sanitize';
import type { CoordinationNotification } from './types';

/** Internal correlation never crosses the MACP boundary. It is not authorization. */
interface NotificationOccurrence {
  notification: CoordinationNotification;
  correlationId: string;
  blockEventId?: string;
  resolved: boolean;
}

/** Replay committed facts only. A bare/mismatched resume does not resolve a review.
 * Matching mirrors Runner's exact reference check; execution eligibility and the
 * pending-action/task/evidence checks remain exclusively the Runner's job. */
export function projectNotificationOccurrences(snapshot: CoordinationSnapshot): NotificationOccurrence[] {
  validateCoordinationSnapshot(snapshot);
  const occurrences: NotificationOccurrence[] = [];
  const latest = new Map<string, NotificationOccurrence>();
  let current: NotificationOccurrence | undefined;
  let requiredReference: string | undefined;
  for (const event of snapshot.events) {
    if (event.type === 'WorkflowResumed' && current) {
      const auth = (event.payload as WorkflowResumePayload).authorization;
      if (auth.type === 'user' && (requiredReference === undefined || auth.reference === requiredReference)) {
        current.resolved = true;
        current = undefined;
      } else if (current.notification.kind !== 'action_approval_required') {
        // Security/Evidence preflight only accepts the first resume after a block.
        current = undefined;
      }
      // Action approval checks the latest resume: keep an unmatched occurrence
      // available for a later matching resume, including across suspension.
      continue;
    }
    const classified = classifyCoordinationEvent(event);
    if (!classified) continue;
    const { kind, reference } = classified;
    const correlationId = notificationIdentity(event.workflowRunId, kind, reference === undefined ? 'event' : 'reference', reference ?? event.eventId);
    const previous = latest.get(correlationId);
    let occurrence = previous && !previous.resolved ? previous : undefined;
    if (!occurrence) {
      // Preserve COORD-4A IDs for the first occurrence. Subsequent, legitimately
      // resumed occurrences have deterministic IDs bound to their canonical event.
      const notificationId = previous
        ? notificationIdentity(event.workflowRunId, kind, 'event', JSON.stringify([correlationId, event.eventId]))
        : correlationId;
      occurrence = { correlationId, resolved: false, notification: sanitizeCoordinationNotification({
        schemaVersion: 1, notificationId, workflowRunId: event.workflowRunId,
        sourceEventId: event.eventId, occurredAt: event.timestamp, kind, ...notificationPresentation(kind),
      }) };
      latest.set(correlationId, occurrence);
      occurrences.push(occurrence);
    }
    if (event.type === 'WorkflowBlocked') {
      occurrence.blockEventId = event.eventId;
      current = occurrence;
      requiredReference = ['action_approval_required', 'security_review_required', 'evidence_review_required'].includes(kind)
        ? reference : undefined;
    }
  }
  if (TERMINAL_WORKFLOW_STATUSES.has(snapshot.run.status)) {
    for (const occurrence of occurrences) if (occurrence.blockEventId) occurrence.resolved = true;
  }
  return occurrences;
}

/** History remains complete after resume, completion, cancellation or suppression. */
export function projectCoordinationNotifications(snapshot: CoordinationSnapshot): CoordinationNotification[] {
  return projectNotificationOccurrences(snapshot).map(occurrence => occurrence.notification);
}

export function notificationDisposition(snapshot: CoordinationSnapshot, notification: CoordinationNotification): 'send' | 'suppress' | 'defer' {
  const occurrences = projectNotificationOccurrences(snapshot);
  const occurrence = occurrences.find(item => item.notification.notificationId === notification.notificationId);
  if (snapshot.run.runId !== notification.workflowRunId || !occurrence
    || JSON.stringify(occurrence.notification) !== JSON.stringify(sanitizeCoordinationNotification(notification))) {
    throw new Error('Notification is not in the committed Journal.');
  }
  if (!occurrence.blockEventId) return 'send';
  if (occurrence.resolved) return 'suppress';
  const latestBlock = [...snapshot.events].reverse().find(event => event.type === 'WorkflowBlocked');
  if (latestBlock?.eventId !== occurrence.blockEventId) return 'suppress';
  // A mismatched resume is not evidence of resolution. Wait for Runner's
  // re-block or a valid resolution; never deliver a review while RUNNING.
  return snapshot.run.status === 'BLOCKED' ? 'send' : 'defer';
}
