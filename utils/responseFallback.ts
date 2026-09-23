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

export const requiresTextFallback = (message: Message): boolean => {
  if (message.role !== 'user') return false;
  if (!message.content.trim() && (message.attachments?.length ?? 0) > 0) return true;
  return /[?？]|\b(?:what|why|how|when|where|who|please|explain|review|create|write)\b|何|なぜ|どう|どれ|いつ|どこ|誰|教えて|説明|レビュー|作って|書いて|してください|お願いします/i.test(message.content);
};

export const selectFallbackAgent = (candidates: Agent[], history: Message[], decisions: AgentDecisionResult[] = []): Agent | null => {
  if (candidates.length === 0) return null;
  const lastSpeaker = lastSpeakerId(history);
  const order = new Map(candidates.map((agent, index) => [agent.id, index]));
  return candidates.slice().sort((a, b) => {
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
  const candidates = decisions.filter(result => result.decision.outcome === 'IGNORE' || result.decision.outcome === 'STAMP');
  const hasStamp = candidates.some(result => result.decision.outcome === 'STAMP');
  if (hasStamp && !requiresTextFallback(lastMessage)) return decisions;
  const fallbackAgent = selectFallbackAgent(candidates.map(result => result.agent), history, candidates);
  if (!fallbackAgent) return decisions;

  return decisions.map(result => result.agent.id === fallbackAgent.id ? {
    ...result,
    decision: {
      outcome: 'RESPOND',
      source: 'fallback',
      latencyMs: 0,
      rawDecision: `${result.decision.outcome}:${result.decision.source}`,
      errorDetail: 'This agent was selected to guarantee a textual response to the user.'
    }
  } : result);
};
