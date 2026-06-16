import type { Agent, Message, ResponseDecision } from '../types';

export interface AgentDecisionResult {
  agent: Agent;
  decision: ResponseDecision;
}

const lastSpeakerId = (history: Message[]): string | undefined => {
  const lastModel = history.slice().reverse().find(message => message.role === 'model' && message.agentId);
  return lastModel?.agentId;
};

const countAgentMessages = (history: Message[], agentId: string): number =>
  history.filter(message => message.role === 'model' && message.agentId === agentId).length;

const lastSpokenDistance = (history: Message[], agentId: string): number => {
  const idx = history.map(message => message.agentId).lastIndexOf(agentId);
  return idx === -1 ? Number.POSITIVE_INFINITY : history.length - idx;
};

const sourcePriority = (source: string): number => {
  if (source === 'llm_decision') return 0;
  if (source === 'turn_limit') return 2;
  return 1;
};

export const selectFallbackAgent = (candidates: Agent[], history: Message[], decisions: AgentDecisionResult[] = []): Agent | null => {
  if (candidates.length === 0) return null;
  const lastSpeaker = lastSpeakerId(history);
  const order = new Map(candidates.map((agent, index) => [agent.id, index]));
  const decisionByAgent = new Map(decisions.map(result => [result.agent.id, result.decision]));

  return candidates.slice().sort((a, b) => {
    const sourceDelta = sourcePriority(decisionByAgent.get(a.id)?.source || '') - sourcePriority(decisionByAgent.get(b.id)?.source || '');
    if (sourceDelta !== 0) return sourceDelta;
    const lastSpeakerDelta = (a.id === lastSpeaker ? 1 : 0) - (b.id === lastSpeaker ? 1 : 0);
    if (lastSpeakerDelta !== 0) return lastSpeakerDelta;
    const countDelta = countAgentMessages(history, a.id) - countAgentMessages(history, b.id);
    if (countDelta !== 0) return countDelta;
    const distanceDelta = lastSpokenDistance(history, b.id) - lastSpokenDistance(history, a.id);
    if (distanceDelta !== 0) return distanceDelta;
    return (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0);
  })[0] || null;
};

export const applyInitialUserTurnFallback = (
  decisions: AgentDecisionResult[],
  history: Message[],
  turnDepth: number
): AgentDecisionResult[] => {
  const lastMessage = history[history.length - 1];
  if (turnDepth !== 0 || lastMessage?.role !== 'user') return decisions;
  if (decisions.some(result => result.decision.outcome === 'RESPOND')) return decisions;
  const ignoreCandidates = decisions.filter(result => result.decision.outcome === 'IGNORE');
  const fallbackAgent = selectFallbackAgent(ignoreCandidates.map(result => result.agent), history, ignoreCandidates);
  if (!fallbackAgent) return decisions;

  return decisions.map(result => result.agent.id === fallbackAgent.id ? {
    ...result,
    decision: {
      outcome: 'RESPOND',
      source: 'fallback',
      latencyMs: 0,
      rawDecision: `IGNORE:${result.decision.source}`,
      errorDetail: 'All enabled agents returned IGNORE. This agent was selected to guarantee a response to the user.'
    }
  } : result);
};
