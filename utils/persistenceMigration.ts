import { Room } from '../types';
import { normalizeAgent } from './contextFiles';
import { MAX_DECISION_EVENTS } from './decisionDiagnostics';

export const normalizeRoom = (room: Room): Room => ({
  ...room,
  agents: (room.agents || []).map(agent => normalizeAgent(agent)),
  messages: (room.messages || []).map(m => m.isStreaming ? { ...m, isStreaming: false } : m),
  decisionEvents: (room.decisionEvents || []).slice(-MAX_DECISION_EVENTS),
});

export const normalizePersistedRooms = (rooms: Room[]): Room[] => rooms.map(normalizeRoom);
