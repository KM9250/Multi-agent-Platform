import type { CoordinationEvent, CoordinationEventType, CoordinationSnapshot } from '../types';
import type { RunnerClock, RunnerIdGenerator } from './types';
export const runnerTimestamp = (snapshot: CoordinationSnapshot, clock: RunnerClock): number =>
  Math.max(clock.now(), snapshot.events.at(-1)!.timestamp);
export const createRunnerEvent = (
  snapshot: CoordinationSnapshot, type: CoordinationEventType, payload: unknown,
  clock: RunnerClock, ids: RunnerIdGenerator,
  options: { sessionId?: string; actorAgentId?: string; idempotencyKey?: string } = {},
): CoordinationEvent => ({
  eventId: ids.nextId('event'), sequence: snapshot.events.at(-1)!.sequence + 1,
  workflowRunId: snapshot.run.runId, type, payload, timestamp: runnerTimestamp(snapshot, clock),
  actorAgentId: options.actorAgentId ?? snapshot.run.supervisorAgentId,
  sessionId: options.sessionId, idempotencyKey: options.idempotencyKey,
});
