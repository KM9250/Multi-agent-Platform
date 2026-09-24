import type { MessageReaction, ReactionSemantic } from '../types';

export const upsertMessageReaction = (
  reactions: MessageReaction[],
  input: { messageId: string; agentId: string; semantic: ReactionSemantic; turnId: string; timestamp?: number; id?: string }
): MessageReaction[] => {
  const existing = reactions.find(reaction => reaction.messageId === input.messageId && reaction.agentId === input.agentId);
  const next: MessageReaction = {
    id: existing?.id ?? input.id ?? crypto.randomUUID(),
    messageId: input.messageId,
    agentId: input.agentId,
    semantic: input.semantic,
    timestamp: input.timestamp ?? Date.now(),
    turnId: input.turnId,
  };
  return existing
    ? reactions.map(reaction => reaction.id === existing.id ? next : reaction)
    : [...reactions, next];
};

export const clearMessageReactions = (reactions: MessageReaction[], messageId: string): MessageReaction[] =>
  reactions.filter(reaction => reaction.messageId !== messageId);
