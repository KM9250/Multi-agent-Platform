import type { InternalStateSettings, Message, MessageSegment } from '../types';

export const DEFAULT_INTERNAL_STATE_SETTINGS: InternalStateSettings = {
  enabled: false,
  showPrivateState: false,
  showDebugThoughts: false,
  showGmLog: false,
  showMemoryExport: false,
};

const legacyBlocks = /\[(THOUGHT|ACTION)\]([\s\S]*?)\[\/\1\]/gi;

export const deriveLegacySegments = (message: Message): MessageSegment[] => {
  if (message.segments !== undefined) return message.segments;
  const debug: string[] = [];
  const publicContent = message.content.replace(legacyBlocks, (_all, _tag, body) => {
    if (body.trim()) debug.push(body.trim());
    return '';
  }).replace(/^\s*Final Response:\s*/i, '').trim();
  const segments: MessageSegment[] = [];
  if (publicContent) segments.push({ id: `${message.id}-public`, channel: 'public_message', visibility: 'public', content: publicContent });
  debug.forEach((content, index) => segments.push({ id: `${message.id}-legacy-debug-${index}`, channel: 'debug_thoughts', visibility: 'developer_only', content }));
  return segments;
};

export const getPublicMessageContent = (message: Message, enabled = true): string => {
  if (!enabled || message.role === 'user') return message.content;
  return deriveLegacySegments(message).filter(s => s.channel === 'public_message' && s.visibility === 'public').map(s => s.content).join('\n');
};

export const getSegmentsVisibleToAgent = (message: Message, targetAgentId: string): MessageSegment[] =>
  deriveLegacySegments(message).filter(segment => {
    if (segment.channel === 'public_message' && segment.visibility === 'public') return true;
    if (segment.channel === 'shared_summary' && segment.visibility === 'public') return true;
    const own = message.agentId === targetAgentId;
    if (!own) return false;
    if (segment.channel === 'private_state') return segment.visibility === 'self_only' || segment.visibility === 'self_and_gm';
    if (segment.channel === 'memory_export') return segment.visibility === 'self_only' || segment.visibility === 'self_and_gm';
    return false;
  });

export const buildVisibleHistoryForAgent = (messages: Message[], targetAgentId: string, settings?: InternalStateSettings): Message[] => {
  if (!settings?.enabled) return messages;
  return messages.map(message => {
    if (message.role === 'user') return { ...message };
    const segments = getSegmentsVisibleToAgent(message, targetAgentId);
    return { ...message, content: segments.map(s => s.content).join('\n'), segments };
  }).filter(message => !!message.content || !!message.attachments?.length);
};

export const replaceStructuredMessage = (message: Message, content: string, segments: MessageSegment[]): Message => ({
  ...message, content, segments, separationVersion: 1, isStreaming: false,
  error: false, errorCode: undefined, errorDetail: undefined,
});
