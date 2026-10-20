import { appendEvent } from '../kernel';
import { validateCoordinationSnapshot } from '../validation';
import { emptyWorkflowUsage } from '../usage';
import type { CoordinationEvent, CoordinationSnapshot } from '../types';
import type { DurableTransaction, Row } from './db';
import { canonicalJson, digest, DurableStoreError, guarded, jsonCopy, parseJson, requireIntegrity } from './integrity';
import { JOURNAL_SCHEMA_VERSION } from './schema';

export const nextAnchor = (previous: string, event: CoordinationEvent): string => digest([previous, digest(event)]);
export function validateSeed(input: CoordinationSnapshot): CoordinationSnapshot {
  return guarded('INVALID_SEED', () => {
    const seed = jsonCopy(input);
    validateCoordinationSnapshot(seed);
    requireIntegrity(seed.events.length === 1 && !!seed.run.runId.trim());
    const { run, policy } = seed;
    // Re-apply the SAVED creation event to a canonical empty projection. No new IDs/time.
    const canonical = appendEvent({
      run: { runId: run.runId, roomId: run.roomId, goal: run.goal, acceptanceCriteria: run.acceptanceCriteria,
        satisfiedCriteria: [], supervisorAgentId: run.supervisorAgentId, participantAgentIds: run.participantAgentIds,
        executionMode: run.executionMode, policyId: run.policyId, policyVersion: run.policyVersion,
        status: 'RUNNING', budget: policy.budgets, usage: emptyWorkflowUsage(), createdAt: run.createdAt, updatedAt: run.createdAt },
      policy, sessions: {}, tasks: {}, decisions: {}, quorums: {}, evaluations: {}, events: [],
    }, seed.events[0]);
    requireIntegrity(canonicalJson(canonical) === canonicalJson(seed));
    return seed;
  });
}
export function decodeEvent(row: Row, id: string, sequence: number): CoordinationEvent {
  const event = parseJson<CoordinationEvent>(row.payload);
  requireIntegrity(event && event.workflowRunId === id && row.workflow_run_id === id
    && event.sequence === sequence && row.sequence === sequence && row.event_id === event.eventId
    && row.event_type === event.type && row.session_id === (event.sessionId ?? null)
    && row.actor_agent_id === (event.actorAgentId ?? null) && row.event_timestamp === event.timestamp
    && row.idempotency_key === (event.idempotencyKey || null) && row.payload_digest === digest(event));
  return event;
}
export interface JournalState { seed: CoordinationSnapshot; events: CoordinationEvent[]; anchors: string[]; snapshot: CoordinationSnapshot }
export function replay(seed: CoordinationSnapshot, events: CoordinationEvent[]): CoordinationSnapshot {
  return guarded('INTEGRITY_ERROR', () => {
    requireIntegrity(events.length >= 1 && canonicalJson(seed.events[0]) === canonicalJson(events[0]));
    let state = seed;
    const ids = new Set([events[0].eventId]);
    const keys = new Set(events[0].idempotencyKey ? [events[0].idempotencyKey] : []);
    for (let i = 1; i < events.length; i++) {
      const event = events[i];
      requireIntegrity(event.sequence === i + 1 && !ids.has(event.eventId));
      requireIntegrity(!event.idempotencyKey || !keys.has(event.idempotencyKey));
      ids.add(event.eventId); if (event.idempotencyKey) keys.add(event.idempotencyKey);
      state = appendEvent(state, event);
      requireIntegrity(state.events.length === i + 1);
    }
    validateCoordinationSnapshot(state);
    return state;
  });
}
export function readJournal(tx: DurableTransaction, id: string): JournalState {
  return guarded('INTEGRITY_ERROR', () => {
    const row = tx.get('SELECT * FROM workflow_seeds WHERE workflow_run_id = ?', id);
    if (!row) throw new DurableStoreError('WORKFLOW_NOT_FOUND');
    if (row.schema_version !== JOURNAL_SCHEMA_VERSION) throw new DurableStoreError('SCHEMA_UNSUPPORTED');
    const seed = validateSeed(parseJson<CoordinationSnapshot>(row.seed_payload));
    requireIntegrity(seed.run.runId === id && seed.run.createdAt === row.created_at && digest(seed) === row.seed_digest);
    requireIntegrity(canonicalJson(seed.policy) === canonicalJson(parseJson(row.policy_payload)) && digest(seed.policy) === row.policy_digest);
    const events = tx.all('SELECT * FROM journal_events WHERE workflow_run_id = ? ORDER BY sequence', id)
      .map((event, i) => decodeEvent(event, id, i + 1));
    requireIntegrity(events.length === row.last_sequence);
    let anchor = '';
    const anchors = events.map(event => (anchor = nextAnchor(anchor, event)));
    requireIntegrity(anchor === row.journal_anchor);
    return { seed, events, anchors, snapshot: replay(seed, events) };
  });
}
