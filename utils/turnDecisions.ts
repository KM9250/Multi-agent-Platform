import type { Agent, Message, ResponseDecision } from '../types';
import { fixedDecision } from './decisionDiagnostics';
import { applyInitialUserTurnFallback, type AgentDecisionResult } from './responseFallback';

export interface ResolveTurnDecisionsOptions {
  activeAgents: Agent[];
  history: Message[];
  turnDepth: number;
  memoryRequest: boolean;
  evaluateDecision: (agent: Agent) => Promise<ResponseDecision>;
}

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
    const mentioned = !!lastMessage?.content && normalizedMention(lastMessage.content, agent.name);
    if (!mentioned && recentHistory.filter(message => message.agentId === agent.id).length >= 3) {
      return { agent, decision: fixedDecision('IGNORE', 'turn_limit') };
    }
    if (mentioned) return { agent, decision: fixedDecision('RESPOND', 'mentioned') };
    return { agent, decision: await evaluateDecision(agent) };
  }));

  return applyInitialUserTurnFallback(decisions, history, turnDepth);
};
