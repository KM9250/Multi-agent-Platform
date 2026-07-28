import test from 'node:test';
import assert from 'node:assert/strict';
import type { Message, Room } from '../types.ts';
import { normalizeRoom } from '../utils/persistenceMigration.ts';
import { buildVisibleHistoryForAgent, DEFAULT_INTERNAL_STATE_SETTINGS, deriveLegacySegments, getPublicMessageContent, replaceStructuredMessage } from '../utils/messageVisibility.ts';
import { parseStructuredAgentOutput, StructuredOutputError } from '../utils/structuredAgentOutput.ts';

const settings = { ...DEFAULT_INTERNAL_STATE_SETTINGS, enabled: true };
const ids = () => { let n = 0; return () => `s${++n}`; };

test('legacy room normalization is off, lossless, and idempotent', () => {
  const room = { id: 'r', title: 'r', description: '', type: 'Sandbox', agents: [], messages: [{ id: 'm', role: 'model', content: 'legacy', timestamp: 1 }], updatedAt: 1 } as Room;
  const once = normalizeRoom(room);
  assert.deepEqual(once.internalStateSettings, DEFAULT_INTERNAL_STATE_SETTINGS);
  assert.equal(once.messages[0].content, 'legacy');
  assert.deepEqual(normalizeRoom(once), once);
});

test('legacy tags are derived safely and explicit empty segments stay empty', () => {
  const legacy = { id: 'm', role: 'model', content: 'before [THOUGHT]secret[/THOUGHT] after', timestamp: 1 } as Message;
  assert.equal(getPublicMessageContent(legacy), 'before  after');
  assert.equal(deriveLegacySegments(legacy).find(s => s.channel === 'debug_thoughts')?.content, 'secret');
  const incomplete = { ...legacy, content: 'before [THOUGHT]do not delete' };
  assert.equal(getPublicMessageContent(incomplete), incomplete.content);
  assert.deepEqual(deriveLegacySegments({ ...legacy, segments: [] }), []);
});

test('recipient history is public/shared plus only the speaker own private state and memory', () => {
  const message: Message = { id: 'm', role: 'model', agentId: 'a', timestamp: 1, content: 'public', separationVersion: 1, segments: [
    { id: '1', channel: 'public_message', visibility: 'public', content: 'public' }, { id: '2', channel: 'shared_summary', visibility: 'public', content: 'shared' },
    { id: '3', channel: 'private_state', visibility: 'self_only', content: 'private' }, { id: '4', channel: 'debug_thoughts', visibility: 'developer_only', content: 'debug' },
    { id: '5', channel: 'gm_log', visibility: 'gm_only', content: 'gm' }, { id: '6', channel: 'memory_export', visibility: 'self_only', content: 'memory' },
  ] };
  assert.equal(buildVisibleHistoryForAgent([message], 'b', settings)[0].content, 'public\nshared');
  assert.equal(buildVisibleHistoryForAgent([message], 'a', settings)[0].content, 'public\nshared\nprivate\nmemory');
  assert.equal(buildVisibleHistoryForAgent([message], 'b', DEFAULT_INTERNAL_STATE_SETTINGS)[0], message);
});

test('structured JSON creates non-empty segments and rejects unsafe output', () => {
  const parsed = parseStructuredAgentOutput(JSON.stringify({ public_message: 'hello', private_state: ' secret ', shared_summary: '', debug_thoughts: 'plan', memory_export: [{ visibility: 'self_only', content: 'remember' }] }), false, ids());
  assert.deepEqual(parsed.segments.map(s => s.channel), ['public_message', 'private_state', 'debug_thoughts', 'memory_export']);
  assert.throws(() => parseStructuredAgentOutput('{private raw'), StructuredOutputError);
  assert.throws(() => parseStructuredAgentOutput(JSON.stringify({ public_message: 'x', memory_export: [{ visibility: 'mystery', content: 'x' }] })), StructuredOutputError);
  assert.throws(() => parseStructuredAgentOutput(JSON.stringify({ public_message: 'leak', memory_export: [] }), true), StructuredOutputError);
});

test('structured completion replaces old segments and mirrors public only', () => {
  const original = { id: 'm', role: 'model', content: 'old', timestamp: 1, segments: [{ id: 'old', channel: 'private_state', visibility: 'self_only', content: 'old secret' }] } as Message;
  const parsed = parseStructuredAgentOutput('{"public_message":"new","private_state":"new secret"}', false, ids());
  const replaced = replaceStructuredMessage(original, parsed.publicMessage, parsed.segments);
  assert.equal(replaced.content, 'new');
  assert.equal(replaced.segments?.some(s => s.content === 'old secret'), false);
  assert.equal(buildVisibleHistoryForAgent([replaced], 'other', settings)[0].content, 'new');
});

test('/memory has no public reply and private memory never reaches another agent', () => {
  const parsed = parseStructuredAgentOutput('{"public_message":"","shared_summary":"safe","memory_export":[{"visibility":"self_only","content":"raw memory"},{"visibility":"gm_only","content":"gm note"}]}', true, ids());
  const message = replaceStructuredMessage({ id: 'm', role: 'model', agentId: 'a', content: '', timestamp: 1 }, parsed.publicMessage, parsed.segments);
  assert.equal(message.content, '');
  assert.equal(buildVisibleHistoryForAgent([message], 'b', settings)[0].content, 'safe');
  assert.equal(buildVisibleHistoryForAgent([message], 'a', settings)[0].content, 'safe\nraw memory');
});
