import type { Agent, Message, ResponseDecision } from '../types';
import { fixedDecision } from './decisionDiagnostics';
import { applyInitialUserTurnFallback, type AgentDecisionResult } from './responseFallback';

export interface ResolveTurnDecisionsOptions {
  activeAgents: Agent[];
  history: Message[];
  turnDepth: number;
  memoryRequest: boolean;
  evaluateDecision: (agent: Agent, context: ParticipationDecisionContext) => Promise<ResponseDecision>;
}

export interface ParticipationDecisionContext {
  recentMessageCount: number;
  lastSpokenDistance?: number;
}

export const partitionTurnDecisions = (decisions: AgentDecisionResult[]) => ({
  responding: decisions.filter(result => result.decision.outcome === 'RESPOND'),
  stamping: decisions.filter(result => result.decision.outcome === 'STAMP'),
});

const normalizedMention = (content: string, agentName: string): boolean => {
  const normalize = (value: string) => value.toLowerCase().replace(/\s/g, '');
  return normalize(content).includes(`@${normalize(agentName)}`);
};

export const resolveTurnDecisions = async ({
  activeAgents,
  history,
  turnDepth,
  memoryRequest,
  evaluateDecision,
}: ResolveTurnDecisionsOptions): Promise<AgentDecisionResult[]> => {
  if (memoryRequest) {
    return activeAgents.map(agent => ({ agent, decision: fixedDecision('RESPOND', 'broadcast') }));
  }

  const lastMessage = history[history.length - 1];
  const recentHistory = history.slice(-8);
  const decisions = await Promise.all(activeAgents.map(async agent => {
    const structured = lastMessage?.recipientTarget;
    if (structured && structured.type !== 'auto' && structured.agentIds.includes(agent.id)) {
      return { agent, decision: fixedDecision('RESPOND', 'recipient_target') };
    }
    const mentioned = !structured && !!lastMessage?.content && normalizedMention(lastMessage.content, agent.name);
    if (mentioned) return { agent, decision: fixedDecision('RESPOND', 'mentioned') };
    const lastIndex = history.map(message => message.agentId).lastIndexOf(agent.id);
    return { agent, decision: await evaluateDecision(agent, {
      recentMessageCount: recentHistory.filter(message => message.agentId === agent.id).length,
      lastSpokenDistance: lastIndex < 0 ? undefined : history.length - lastIndex,
    }) };
  }));

  return applyInitialUserTurnFallback(decisions, history, turnDepth);
};
