import test from 'node:test';
import assert from 'node:assert/strict';
import type { Agent, Message, Room } from '../types.ts';
import { normalizeRoom } from '../utils/persistenceMigration.ts';
import { buildVisibleHistoryForAgent, DEFAULT_INTERNAL_STATE_SETTINGS, deriveLegacySegments, getPublicMessageContent, isMemoryExportRequest, replaceStructuredMessage } from '../utils/messageVisibility.ts';
import { parseStructuredAgentOutput, StructuredOutputError } from '../utils/structuredAgentOutput.ts';
import { finalizeLegacyGeneration, finalizeSeparatedFailure, finalizeSeparatedSuccess, prepareMessageForRegeneration, restoreMessageAfterAbort, SAFE_SEPARATED_ERROR_MESSAGE } from '../utils/generationFinalization.ts';
import { canRetryGeneration } from '../utils/retryPolicy.ts';
import { STRATEGIES } from '../services/agentStrategies.ts';
import { resolveTurnDecisions } from '../utils/turnDecisions.ts';

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
  const other = buildVisibleHistoryForAgent([message], 'b', settings)[0].content;
  const own = buildVisibleHistoryForAgent([message], 'a', settings)[0].content;
  assert.match(other, /\[PUBLIC_MESSAGE\]\npublic/);
  assert.match(other, /\[SHARED_SUMMARY\]\nshared/);
  assert.doesNotMatch(other, /private|MEMORY_EXPORT|debug|gm/);
  assert.match(own, /\[PRIVATE_STATE: SELF_ONLY\][\s\S]*Never repeat[\s\S]*private/);
  assert.match(own, /\[MEMORY_EXPORT: SELF_ONLY\][\s\S]*Do not disclose[\s\S]*memory/);
  assert.doesNotMatch(own, /debug|\ngm$/);
  assert.equal(buildVisibleHistoryForAgent([message], 'b', DEFAULT_INTERNAL_STATE_SETTINGS)[0], message);
});

test('structured JSON creates non-empty segments and rejects unsafe output', () => {
  const parsed = parseStructuredAgentOutput(JSON.stringify({ public_message: 'hello', private_state: ' secret ', shared_summary: '', debug_thoughts: 'plan', memory_export: [{ visibility: 'self_only', content: 'remember' }] }), false, ids());
  assert.deepEqual(parsed.segments.map(s => s.channel), ['public_message', 'private_state', 'debug_thoughts', 'memory_export']);
  assert.throws(() => parseStructuredAgentOutput('{private raw'), StructuredOutputError);
  assert.throws(() => parseStructuredAgentOutput(JSON.stringify({ public_message: 'x', memory_export: [{ visibility: 'mystery', content: 'x' }] })), StructuredOutputError);
  assert.throws(() => parseStructuredAgentOutput(JSON.stringify({ public_message: 'leak', memory_export: [] }), true), StructuredOutputError);
  assert.throws(() => parseStructuredAgentOutput(JSON.stringify({ public_message: 'x', memory_export: [{ visibility: 'public', content: 'unsafe' }] })), StructuredOutputError);
});

test('structured completion replaces old segments and mirrors public only', () => {
  const original = { id: 'm', role: 'model', content: 'old', timestamp: 1, segments: [{ id: 'old', channel: 'private_state', visibility: 'self_only', content: 'old secret' }] } as Message;
  const parsed = parseStructuredAgentOutput('{"public_message":"new","private_state":"new secret"}', false, ids());
  const replaced = replaceStructuredMessage(original, parsed.publicMessage, parsed.segments);
  assert.equal(replaced.content, 'new');
  assert.equal(replaced.segments?.some(s => s.content === 'old secret'), false);
  assert.match(buildVisibleHistoryForAgent([replaced], 'other', settings)[0].content, /\[PUBLIC_MESSAGE\]\nnew/);
});

test('/memory has no public reply and private memory never reaches another agent', () => {
  const parsed = parseStructuredAgentOutput('{"public_message":"","shared_summary":"safe","memory_export":[{"visibility":"self_only","content":"raw memory"},{"visibility":"gm_only","content":"gm note"}]}', true, ids());
  const message = replaceStructuredMessage({ id: 'm', role: 'model', agentId: 'a', content: '', timestamp: 1 }, parsed.publicMessage, parsed.segments);
  assert.equal(message.content, '');
  assert.doesNotMatch(buildVisibleHistoryForAgent([message], 'b', settings)[0].content, /raw memory|gm note/);
  assert.match(buildVisibleHistoryForAgent([message], 'a', settings)[0].content, /raw memory/);
});

test('all separated non-success results fail closed without persisting raw fragments', () => {
  const raw = 'PRIVATE_SECRET_DO_NOT_EXPOSE GM_SECRET_DO_NOT_EXPOSE';
  for (const errorCode of ['PARTIAL_RESPONSE', 'MALFORMED_RESPONSE', 'CONTENT_BLOCKED', 'EMPTY_RESPONSE']) {
    const pending = prepareMessageForRegeneration({ id: errorCode, role: 'model', agentId: 'a', content: 'old', timestamp: 1 }, true);
    const result = { outcome: 'ERROR' as const, text: raw, latencyMs: 1, errorCode, errorDetail: 'Safe provider finish metadata.' };
    const failed = finalizeSeparatedFailure(pending, result);
    assert.equal(failed.content, SAFE_SEPARATED_ERROR_MESSAGE);
    assert.deepEqual(failed.segments, []);
    assert.equal(failed.separationVersion, 1);
    assert.doesNotMatch(JSON.stringify(failed), /SECRET_DO_NOT_EXPOSE/);
    assert.doesNotMatch(buildVisibleHistoryForAgent([failed], 'b', settings).map(m => m.content).join(''), /SECRET_DO_NOT_EXPOSE/);
  }
  for (const mode of ['retry', 'regenerate']) {
    const pending = prepareMessageForRegeneration({ id: mode, role: 'model', content: 'old', timestamp: 1 }, true);
    const failed = finalizeSeparatedFailure(pending, { errorCode: 'PARTIAL_RESPONSE', errorDetail: `Safe ${mode} detail` });
    assert.doesNotMatch(JSON.stringify(failed), /SECRET_DO_NOT_EXPOSE/);
    assert.deepEqual(failed.segments, []);
  }
});

test('abort restores the pre-regeneration safe message without streaming or raw data', () => {
  const original = { id: 'm', role: 'model', content: 'safe public', timestamp: 1, segments: [{ id: 'p', channel: 'public_message', visibility: 'public', content: 'safe public' }], separationVersion: 1 } as Message;
  const pending = prepareMessageForRegeneration(original, true);
  assert.equal(pending.isStreaming, true);
  const restored = restoreMessageAfterAbort(original);
  assert.equal(restored.content, 'safe public');
  assert.equal(restored.isStreaming, false);
  assert.doesNotMatch(JSON.stringify(restored), /PRIVATE_SECRET_DO_NOT_EXPOSE/);
});

test('regeneration mode switches clear stale canonical state in both directions', () => {
  const structured = finalizeSeparatedSuccess({ id: 'm', role: 'model', content: '', timestamp: 1 }, '{"public_message":"A","private_state":"PRIVATE_A"}', false);
  const legacyPending = prepareMessageForRegeneration(structured, false);
  const legacy = finalizeLegacyGeneration(legacyPending, 'B');
  assert.equal(legacy.content, 'B');
  assert.equal(legacy.segments, undefined);
  assert.equal(legacy.separationVersion, undefined);
  assert.equal(getPublicMessageContent(legacy, true), 'B');
  assert.doesNotMatch(JSON.stringify(legacy), /PRIVATE_A/);
  const separatedPending = prepareMessageForRegeneration(legacy, true);
  const separated = finalizeSeparatedSuccess(separatedPending, '{"public_message":"C","private_state":"PRIVATE_C"}', false);
  assert.equal(separated.content, 'C');
  assert.equal(separated.separationVersion, 1);
});

test('parse errors are retryable and successful retry clears the prior error', () => {
  const failed = finalizeSeparatedSuccess({ id: 'm', role: 'model', content: '', timestamp: 1 }, '{raw secret', false);
  assert.equal(failed.errorCode, 'STRUCTURED_OUTPUT_PARSE_ERROR');
  assert.equal(canRetryGeneration(failed.errorCode), true);
  assert.doesNotMatch(JSON.stringify(failed), /raw secret/);
  const retried = finalizeSeparatedSuccess(prepareMessageForRegeneration(failed, true), '{"public_message":"safe","private_state":"new"}', false);
  assert.equal(retried.error, false);
  assert.equal(retried.content, 'safe');
  assert.equal(retried.segments?.some(s => s.content === 'new'), true);
});

test('/memory is special only in separated mode', () => {
  const command = { id: 'u', role: 'user', content: ' /memory ', timestamp: 1 } as Message;
  assert.equal(isMemoryExportRequest(command, false), false);
  assert.equal(isMemoryExportRequest(command, true), true);
});

test('CoT and ReAct retain legacy tags only when separation is off', () => {
  const cotLegacy = STRATEGIES.cot.injectSystemPrompt('base');
  const reactLegacy = STRATEGIES.react.injectSystemPrompt('base');
  assert.match(cotLegacy, /\[THOUGHT\]/);
  assert.match(reactLegacy, /\[ACTION\]/);
  const cotSeparated = STRATEGIES.cot.injectSystemPrompt('base', { separationEnabled: true });
  const reactSeparated = STRATEGIES.react.injectSystemPrompt('base', { separationEnabled: true });
  assert.doesNotMatch(cotSeparated, /Use the format:[\s\S]*\[THOUGHT\]/);
  assert.doesNotMatch(reactSeparated, /following format[\s\S]*\[ACTION\]/);
  assert.match(cotSeparated, /debug_thoughts/);
  assert.match(reactSeparated, /gm_log/);
});

test('/memory broadcasts without calling the decision evaluator', async () => {
  const agents = [
    { id: 'a', name: 'Alpha', isEnabled: true },
    { id: 'b', name: 'Beta', isEnabled: true },
  ] as Agent[];
  let calls = 0;
  const decisions = await resolveTurnDecisions({
    activeAgents: agents,
    history: [{ id: 'u', role: 'user', content: '/memory', timestamp: 1 }],
    turnDepth: 0,
    memoryRequest: true,
    evaluateDecision: async () => {
      calls++;
      return { outcome: 'IGNORE', source: 'llm_decision', latencyMs: 1 };
    },
  });
  assert.equal(calls, 0);
  assert.deepEqual(decisions.map(result => [result.agent.id, result.decision.outcome, result.decision.source]), [
    ['a', 'RESPOND', 'broadcast'],
    ['b', 'RESPOND', 'broadcast'],
  ]);
});

test('ordinary turns retain mention, turn-limit, and evaluator behavior', async () => {
  const mentioned = { id: 'a', name: 'Alpha', isEnabled: true } as Agent;
  const limited = { id: 'b', name: 'Beta', isEnabled: true } as Agent;
  const evaluated = { id: 'c', name: 'Gamma', isEnabled: true } as Agent;
  const history: Message[] = [
    ...Array.from({ length: 3 }, (_, index) => ({ id: `b${index}`, role: 'model' as const, agentId: 'b', content: 'old', timestamp: index })),
    { id: 'u', role: 'user', content: 'hello @Alpha', timestamp: 4 },
  ];
  const calls: string[] = [];
  const decisions = await resolveTurnDecisions({
    activeAgents: [mentioned, limited, evaluated], history, turnDepth: 1, memoryRequest: false,
    evaluateDecision: async agent => {
      calls.push(agent.id);
      return { outcome: 'IGNORE', source: 'llm_decision', latencyMs: 1 };
    },
  });
  assert.deepEqual(calls, ['c']);
  assert.deepEqual(decisions.map(result => result.decision.source), ['mentioned', 'turn_limit', 'llm_decision']);
});
