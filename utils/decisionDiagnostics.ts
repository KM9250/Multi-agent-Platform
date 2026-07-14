import type { Agent, AgentDecisionEvent, DecisionSource, ResponseDecision, Room } from '../types';

export const MAX_DECISION_EVENTS = 50;

export const parseDecisionText = (text: string | undefined, latencyMs = 0, decisionModel?: string): ResponseDecision => {
  const rawDecision = text;
  const normalized = text?.trim().toUpperCase();
  if (normalized === 'RESPOND') return { outcome: 'RESPOND', source: 'llm_decision', latencyMs, decisionModel, rawDecision };
  if (normalized === 'IGNORE') return { outcome: 'IGNORE', source: 'llm_decision', latencyMs, decisionModel, rawDecision };
  return { outcome: 'ERROR', source: 'invalid_decision', latencyMs, decisionModel, rawDecision, errorCode: 'INVALID_DECISION', errorDetail: normalized ? `Unexpected decision: ${normalized}` : 'Decision response was empty.' };
};

export const fixedDecision = (outcome: 'RESPOND' | 'IGNORE', source: DecisionSource): ResponseDecision => ({ outcome, source, latencyMs: 0 });

export const createDecisionEvent = (turnId: string, agent: Agent, decision: ResponseDecision, timestamp = Date.now()): AgentDecisionEvent => ({
  id: crypto.randomUUID(),
  turnId,
  timestamp,
  agentId: agent.id,
  agentName: agent.name,
  ...decision,
});

export const appendDecisionEvents = (room: Room, events: AgentDecisionEvent[]): Room => ({
  ...room,
  decisionEvents: [...(room.decisionEvents || []), ...events].slice(-MAX_DECISION_EVENTS),
});
