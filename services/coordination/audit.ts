import type { CoordinationAuditView, CoordinationSnapshot, ProgressRecordedPayload } from './types';
import { findExhaustedBudget } from './policy';
import { validateCoordinationSnapshot } from './validation';

const counts = <T extends string>(keys: readonly T[], values: readonly T[]): Record<T, number> =>
  Object.fromEntries(keys.map(key => [key, values.filter(value => value === key).length])) as Record<T, number>;
const clone = <T>(value: T): T => structuredClone(value);

/** Builds a deterministic, read-only-by-isolation view over validated authoritative state. */
export const buildCoordinationAuditView = (snapshot: CoordinationSnapshot, now: number): CoordinationAuditView => {
  validateCoordinationSnapshot(snapshot);
  if (!Number.isFinite(now)) throw new Error('Audit time must be finite.');
  const { run } = snapshot; const last = snapshot.events.at(-1)!;
  const elapsedEnd = ['RESOLVED', 'CANCELLED', 'FAILED'].includes(run.status) ? run.updatedAt : now;
  const exhaustedBudget = findExhaustedBudget(run.budget, run.usage, Math.max(0, elapsedEnd - run.createdAt));
  const progressEvent = [...snapshot.events].reverse().find(event => event.type === 'ProgressRecorded');
  const satisfied = new Set(run.satisfiedCriteria);
  return {
    workflow: { runId: run.runId, status: run.status, ...(run.statusReason === undefined ? {} : { statusReason: run.statusReason }),
      executionMode: run.executionMode, supervisorAgentId: run.supervisorAgentId, policyId: run.policyId,
      policyVersion: run.policyVersion, createdAt: run.createdAt, updatedAt: run.updatedAt },
    events: { count: snapshot.events.length, lastSequence: last.sequence, lastEventAt: last.timestamp },
    activeSessionIds: Object.values(snapshot.sessions).filter(value => value.state === 'OPEN' || value.state === 'SUSPENDED').map(value => value.sessionId).sort(),
    sessionCounts: counts(['OPEN', 'SUSPENDED', 'RESOLVED', 'CANCELLED', 'EXPIRED'], Object.values(snapshot.sessions).map(value => value.state)),
    taskCounts: counts(['ASSIGNED', 'COMPLETED', 'FAILED', 'CANCELLED'], Object.values(snapshot.tasks).map(value => value.status)),
    decisionCounts: counts(['OPEN', 'RESOLVED', 'CANCELLED'], Object.values(snapshot.decisions).map(value => value.status)),
    quorumCounts: counts(['OPEN', 'RESOLVED', 'CANCELLED'], Object.values(snapshot.quorums).map(value => value.status)),
    evaluationCounts: counts(['PASS', 'FAIL', 'INCONCLUSIVE'], Object.values(snapshot.evaluations).map(value => value.outcome)),
    acceptance: { total: run.acceptanceCriteria.length, satisfiedCriteria: run.acceptanceCriteria.filter(value => satisfied.has(value)), missingCriteria: run.acceptanceCriteria.filter(value => !satisfied.has(value)) },
    usage: clone(run.usage), budget: clone(run.budget),
    ...(exhaustedBudget ? { exhaustedBudget } : {}),
    ...(progressEvent ? { progress: { outcome: (progressEvent.payload as ProgressRecordedPayload).outcome, summary: (progressEvent.payload as ProgressRecordedPayload).summary.trim(), eventId: progressEvent.eventId, sequence: progressEvent.sequence, timestamp: progressEvent.timestamp } } : {}),
    ...(snapshot.commitment ? { commitment: clone(snapshot.commitment) } : {}),
    trail: snapshot.events.map(event => ({ sequence: event.sequence, eventId: event.eventId, type: event.type, timestamp: event.timestamp,
      scope: event.sessionId === undefined ? 'workflow' : 'session', ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
      ...(event.actorAgentId === undefined ? {} : { actorAgentId: event.actorAgentId }) })),
  };
};
