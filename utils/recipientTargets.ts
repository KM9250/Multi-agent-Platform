import type { Agent, MessageRecipientTarget } from '../types';

export type RecipientSelection = 'auto' | 'all' | `agent:${string}` | `group:${string}`;

export const createRecipientSnapshot = (selection: RecipientSelection, agents: Agent[]): MessageRecipientTarget => {
  if (selection === 'all') return { type: 'all', agentIds: agents.map(agent => agent.id) };
  if (selection.startsWith('agent:')) return { type: 'agent', agentIds: [selection.slice(6)] };
  if (selection.startsWith('group:')) {
    const groupId = selection.slice(6);
    return { type: 'group', groupId, agentIds: agents.filter(agent => agent.groups?.includes(groupId)).map(agent => agent.id) };
  }
  return { type: 'auto' };
};

export const recipientLabel = (target: MessageRecipientTarget | undefined, agents: Agent[]): string | undefined => {
  if (!target || target.type === 'auto') return undefined;
  if (target.type === 'all') return 'All';
  if (target.type === 'group') return target.groupId;
  return target.agentIds.map(id => agents.find(agent => agent.id === id)?.name ?? id).join(', ');
};
