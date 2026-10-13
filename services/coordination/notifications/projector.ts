import type { CoordinationSnapshot } from '../types';
import { validateCoordinationSnapshot } from '../validation';
import { classifyCoordinationEvent } from './classify';
import { notificationIdentity } from './identity';
import { notificationPresentation, sanitizeCoordinationNotification } from './sanitize';
import type { CoordinationNotification } from './types';

/** Validated, committed Journal in sequence order is the only source of facts. */
export function projectCoordinationNotifications(snapshot: CoordinationSnapshot): CoordinationNotification[] {
  validateCoordinationSnapshot(snapshot);
  const notifications = new Map<string, CoordinationNotification>();
  for (const event of snapshot.events) {
    const classified = classifyCoordinationEvent(event);
    if (!classified) continue;
    const { kind, reference } = classified;
    const notificationId = notificationIdentity(event.workflowRunId, kind, reference === undefined ? 'event' : 'reference', reference ?? event.eventId);
    // Keep the first canonical event/time when the same review is blocked again.
    if (notifications.has(notificationId)) continue;
    notifications.set(notificationId, sanitizeCoordinationNotification({
      schemaVersion: 1, notificationId, workflowRunId: event.workflowRunId,
      sourceEventId: event.eventId, occurredAt: event.timestamp, kind, ...notificationPresentation(kind),
    }));
  }
  return [...notifications.values()];
}
