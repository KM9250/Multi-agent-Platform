import type { CoordinationSnapshot } from '../types';
import type { CoordinationRunnerStore } from '../runner/types';
import { projectCoordinationNotifications } from './projector';
import type { CoordinationNotification, NotificationDiagnosticSink } from './types';

export interface CoordinationNotificationObserver {
  observe(snapshot: CoordinationSnapshot): void | Promise<void>;
}
function reportFailure(sink?: NotificationDiagnosticSink): void {
  try { Promise.resolve(sink?.({ code: 'NOTIFICATION_OBSERVER_FAILED' })).catch(() => {}); } catch { /* Diagnostics cannot affect the Journal. */ }
}
export function createCoordinationNotificationObserver(outbox: { enqueue(notification: CoordinationNotification): boolean }): CoordinationNotificationObserver {
  return { observe(snapshot) { for (const notification of projectCoordinationNotifications(snapshot)) outbox.enqueue(notification); } };
}

/** Deliberate recovery entry point; rescans all history after a missed enqueue. */
export async function reconcileCoordinationNotifications(store: CoordinationRunnerStore, workflowRunId: string,
  observer: CoordinationNotificationObserver, diagnostics?: NotificationDiagnosticSink): Promise<boolean> {
  try { await observer.observe(structuredClone(store.getSnapshot(workflowRunId))); return true; }
  catch { reportFailure(diagnostics); return false; }
}

/** Install as dependencies.store when constructing a Runner; no Kernel edits. */
export function createNotifyingCoordinationStore(baseStore: CoordinationRunnerStore,
  observer: CoordinationNotificationObserver, diagnostics?: NotificationDiagnosticSink): CoordinationRunnerStore {
  return {
    getSnapshot: workflowRunId => baseStore.getSnapshot(workflowRunId),
    append(event) {
      // A rejected append propagates normally and never invokes the observer.
      const result = baseStore.append(event);
      try {
        // Read committed state, not event input or the Runner's return value.
        const observed = observer.observe(structuredClone(baseStore.getSnapshot(event.workflowRunId)));
        Promise.resolve(observed).catch(() => reportFailure(diagnostics));
      } catch { reportFailure(diagnostics); }
      return result;
    },
  };
}
