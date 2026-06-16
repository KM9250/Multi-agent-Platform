import assert from 'node:assert/strict';
import { normalizeAgent, normalizeContextFileOrder, buildAdditionalContext, normalizeModelId } from '../utils/contextFiles';
import { appendDecisionEvents, createDecisionEvent, fixedDecision, MAX_DECISION_EVENTS, parseDecisionText } from '../utils/decisionDiagnostics';
import { normalizePersistedRooms, normalizeRoom } from '../utils/persistenceMigration';
import { classifyStreamCompletion } from '../utils/streamCompletion';
import { isSameGenerationSession, shouldAcceptStreamChunk } from '../utils/generationSession';
import { normalizeGenerationHistory } from '../utils/geminiHistory';
import { classifyGenerationResult } from '../utils/generationResult';
import { canRetryGeneration } from '../utils/retryPolicy';
import { applyInitialUserTurnFallback, selectFallbackAgent } from '../utils/responseFallback';
import { createDecisionError, getCombinedSystemInstruction } from '../services/geminiService';
import type { Agent, AgentContextFile, Room } from '../types';

const baseAgent: Agent = {
  id: 'a1',
  name: 'Agent',
  description: 'desc',
  systemInstruction: 'manual',
  model: 'gemini-2.5-flash',
  framework: 'standard',
  color: 'bg',
  avatar: '🤖',
  isEnabled: true,
  thinkingBudget: 0,
};

// Decision parsing: production parser, exact match only.
assert.equal(parseDecisionText('RESPOND').outcome, 'RESPOND');
assert.equal(parseDecisionText('respond').outcome, 'RESPOND');
assert.equal(parseDecisionText('  RESPOND\n').outcome, 'RESPOND');
assert.equal(parseDecisionText('IGNORE').outcome, 'IGNORE');
assert.deepEqual([parseDecisionText('DO NOT RESPOND').outcome, parseDecisionText('DO NOT RESPOND').source], ['ERROR', 'invalid_decision']);
assert.deepEqual([parseDecisionText('').outcome, parseDecisionText('').source], ['ERROR', 'invalid_decision']);
assert.deepEqual([parseDecisionText(undefined).outcome, parseDecisionText(undefined).source], ['ERROR', 'invalid_decision']);
assert.deepEqual(createDecisionError(new Error('429 QuotaExceeded'), 123, 'gemini-2.5-flash'), {
  outcome: 'ERROR',
  source: 'api_error',
  latencyMs: 123,
  decisionModel: 'gemini-2.5-flash',
  errorCode: 'QUOTA_EXCEEDED',
  errorDetail: 'The API quota has been exhausted. Try again later or upgrade your plan.',
});

// Context migration: empty new-format arrays are authoritative and do not resurrect legacy context.
const legacyOnly = normalizeAgent({
  ...baseAgent,
  importedSystemInstruction: 'legacy content',
  importedSystemInstructionFileName: 'old.md',
  additionalContextFiles: undefined,
}, 123);
assert.equal(legacyOnly.additionalContextFiles?.length, 1);
assert.equal(legacyOnly.additionalContextFiles?.[0].name, 'old.md');
assert.equal(legacyOnly.additionalContextFiles?.[0].content, 'legacy content');

const emptyNewFormat = normalizeAgent({
  ...baseAgent,
  importedSystemInstruction: 'legacy content',
  importedSystemInstructionFileName: 'old.md',
  additionalContextFiles: [],
});
assert.deepEqual(emptyNewFormat.additionalContextFiles, []);

const oneFile: AgentContextFile = { id: 'new', name: 'new.md', content: 'new content', mimeType: 'text/markdown', charCount: 11, sizeBytes: 11, order: 0, addedAt: 1 };
const existingNew = normalizeAgent({ ...baseAgent, importedSystemInstruction: 'legacy content', additionalContextFiles: [oneFile] });
assert.equal(existingNew.additionalContextFiles?.length, 1);
assert.equal(existingNew.additionalContextFiles?.[0].content, 'new content');
assert.deepEqual(normalizeAgent(baseAgent).additionalContextFiles, []);
assert.equal(normalizeAgent(normalizeAgent(legacyOnly, 456), 789).additionalContextFiles?.length, 1);
assert.equal(normalizeAgent(normalizeAgent(legacyOnly, 456), 789).additionalContextFiles?.[0].content, 'legacy content');

// Context prompt: production prompt builder must not mutate order or fallback to legacy when [] is present.
const files: AgentContextFile[] = [
  { id: '3', name: 'c.txt', content: 'C', mimeType: 'text/plain', charCount: 1, sizeBytes: 1, order: 2, addedAt: 1 },
  { id: '1', name: 'a.md', content: 'A', mimeType: 'text/markdown', charCount: 1, sizeBytes: 1, order: 0, addedAt: 1 },
  { id: '2', name: 'b.md', content: 'B', mimeType: 'text/markdown', charCount: 1, sizeBytes: 1, order: 1, addedAt: 1 },
];
const beforeOrder = files.map(file => file.id).join(',');
const joined = buildAdditionalContext(files);
assert.equal(files.map(file => file.id).join(','), beforeOrder);
assert.ok(joined.indexOf('a.md') < joined.indexOf('b.md'));
assert.ok(joined.indexOf('b.md') < joined.indexOf('c.txt'));
assert.ok(joined.includes('--- ADDITIONAL CONTEXT 1: a.md ---'));
assert.ok(joined.includes('--- END CONTEXT: c.txt ---'));
assert.deepEqual(normalizeContextFileOrder(files).map(file => file.order), [0, 1, 2]);
const noResurrectionPrompt = getCombinedSystemInstruction({ ...baseAgent, importedSystemInstruction: 'legacy content', additionalContextFiles: [] });
assert.equal(noResurrectionPrompt.includes('legacy content'), false);
const legacyFallbackPrompt = getCombinedSystemInstruction({ ...baseAgent, importedSystemInstruction: 'legacy content', additionalContextFiles: undefined });
assert.equal(legacyFallbackPrompt.includes('legacy content'), true);

// Diagnostics utilities and persistence normalization.
const room: Room = { id: 'r', title: 'r', description: '', type: 'Sandbox', agents: [baseAgent], messages: [], updatedAt: 1 };
let updated = appendDecisionEvents(room, [
  createDecisionEvent('t1', baseAgent, fixedDecision('RESPOND', 'mentioned'), 1),
  createDecisionEvent('t1', baseAgent, fixedDecision('IGNORE', 'turn_limit'), 2),
  createDecisionEvent('t1', baseAgent, { outcome: 'IGNORE', source: 'llm_decision', latencyMs: 3, decisionModel: 'm', rawDecision: 'IGNORE' }, 3),
  createDecisionEvent('t1', baseAgent, { outcome: 'ERROR', source: 'api_error', latencyMs: 4, errorCode: 'QUOTA_EXCEEDED' }, 4),
]);
assert.equal(updated.messages.length, 0);
assert.deepEqual(updated.decisionEvents?.map(event => event.source), ['mentioned', 'turn_limit', 'llm_decision', 'api_error']);
for (let i = 0; i < MAX_DECISION_EVENTS + 5; i++) {
  updated = appendDecisionEvents(updated, [createDecisionEvent(`overflow-${i}`, baseAgent, fixedDecision('IGNORE', 'fallback'), i)]);
}
assert.equal(updated.decisionEvents?.length, MAX_DECISION_EVENTS);
assert.equal(normalizeRoom({ ...updated, messages: [{ id: 'm', role: 'model', content: 'x', timestamp: 1, isStreaming: true }] }).messages[0].isStreaming, false);
assert.equal(normalizePersistedRooms([updated]).length, 1);

// Stream completion classification.
assert.equal(classifyStreamCompletion('', false), 'empty_response');
assert.equal(classifyStreamCompletion(' \n\t', false), 'empty_response');
assert.equal(classifyStreamCompletion('hello', false), 'complete');
assert.equal(classifyStreamCompletion('', true), 'aborted_empty');
assert.equal(classifyStreamCompletion('partial', true), 'aborted_partial');



// Generation session identity and chunk acceptance.
const sessionA = { sessionId: 'session-a', turnId: 'turn-a', roomId: 'room-1' };
const sessionB = { sessionId: 'session-b', turnId: 'turn-a', roomId: 'room-1' };
assert.equal(isSameGenerationSession(sessionA, { sessionId: 'session-a', turnId: 'turn-a', roomId: 'room-1' }), true);
assert.equal(isSameGenerationSession(sessionA, { sessionId: 'session-b', turnId: 'turn-a', roomId: 'room-1' }), false);
assert.equal(isSameGenerationSession(sessionA, { sessionId: 'session-a', turnId: 'turn-b', roomId: 'room-1' }), false);
assert.equal(isSameGenerationSession(sessionA, { sessionId: 'session-a', turnId: 'turn-a', roomId: 'room-2' }), false);
assert.equal(isSameGenerationSession(null, { sessionId: 'session-a', turnId: 'turn-a', roomId: 'room-1' }), false);
assert.equal(isSameGenerationSession(sessionA, sessionA), true);
assert.equal(isSameGenerationSession(sessionA, sessionB), false);
assert.equal(isSameGenerationSession(sessionB, sessionB), true);
assert.equal(shouldAcceptStreamChunk(true, false), true);
assert.equal(shouldAcceptStreamChunk(true, true), false);
assert.equal(shouldAcceptStreamChunk(false, false), false);
assert.equal(shouldAcceptStreamChunk(false, true), false);


// Gemini generation history normalization.
assert.deepEqual(normalizeGenerationHistory([{ role: 'user', parts: [{ text: 'u' }] }, { role: 'model', parts: [{ text: 'm' }] }], 'Curren Chan').contents.map(c => c.role), ['user', 'model', 'user']);
assert.deepEqual(normalizeGenerationHistory([{ role: 'user', parts: [{ text: 'u1' }] }, { role: 'user', parts: [{ text: 'u2' }] }, { role: 'model', parts: [{ text: 'm' }] }], 'Curren Chan').contents.map(c => c.role), ['user', 'model', 'user']);
assert.deepEqual(normalizeGenerationHistory([{ role: 'user', parts: [{ text: 'u' }] }, { role: 'model', parts: [{ text: 'm' }] }, { role: 'user', parts: [{ text: 'u2' }] }], 'Curren Chan').contents.map(c => c.role), ['user', 'model', 'user']);
['Curren Chan', 'Admire Vega'].forEach(name => {
  assert.equal(normalizeGenerationHistory([{ role: 'user', parts: [{ text: 'User' }] }, { role: 'model', parts: [{ text: name }] }], name).contents.at(-1)?.role, 'user');
});
assert.equal(normalizeGenerationHistory([{ role: 'user', parts: [{ text: 'User' }] }, { role: 'model', parts: [{ text: 'Curren' }] }, { role: 'user', parts: [{ text: 'Admire' }] }], 'Admire Vega').contents.at(-1)?.role, 'user');
assert.equal(normalizeGenerationHistory([{ role: 'user', parts: [{ text: 'User' }] }, { role: 'model', parts: [{ text: 'Curren' }] }, { role: 'user', parts: [{ text: 'Admire' }] }, { role: 'model', parts: [{ text: 'Admire 2' }] }], 'Admire Vega').contents.at(-1)?.role, 'user');

// Model migration and generation error classification.
assert.equal(normalizeModelId('gemini-3.1-pro'), 'gemini-3.1-pro-preview');
assert.equal(normalizeModelId('gemini-3-pro-preview'), 'gemini-3.1-pro-preview');
assert.equal(normalizeModelId('gemini-3.1-pro-preview'), 'gemini-3.1-pro-preview');
assert.equal(normalizeModelId('gemini-3-flash'), 'gemini-3-flash-preview');
assert.equal(normalizeModelId('gemini-3.0-flash'), 'gemini-3-flash-preview');
assert.equal(normalizeModelId('gemini-3-flash-preview'), 'gemini-3-flash-preview');
assert.equal(normalizeAgent(normalizeAgent({ ...baseAgent, model: 'gemini-3.1-pro' })).model, 'gemini-3.1-pro-preview');
assert.equal(classifyGenerationResult('', { finishReason: 'SAFETY' }, false).errorCode, 'CONTENT_BLOCKED');
assert.equal(classifyGenerationResult('partial', { finishReason: 'MAX_TOKENS' }, false).errorCode, 'PARTIAL_RESPONSE');
assert.equal(classifyGenerationResult('', { finishReason: 'STOP' }, false).errorCode, 'EMPTY_RESPONSE');
assert.equal(canRetryGeneration('EMPTY_RESPONSE'), true);
assert.equal(canRetryGeneration('NETWORK_ERROR'), true);
assert.equal(canRetryGeneration('MODEL_OVERLOADED'), true);
assert.equal(canRetryGeneration('AUTH_ERROR'), false);
assert.equal(canRetryGeneration('MODEL_NOT_FOUND'), false);
assert.equal(canRetryGeneration('CONTENT_BLOCKED'), false);



// Initial user-turn response fallback.
const curren = { ...baseAgent, id: 'curren', name: 'Curren Chan' };
const admire = { ...baseAgent, id: 'admire', name: 'Admire Vega' };
const userOnlyHistory = [{ id: 'u1', role: 'user' as const, content: 'hello', timestamp: 1 }];
const ignoreDecisions = [
  { agent: curren, decision: { outcome: 'IGNORE' as const, source: 'llm_decision' as const, latencyMs: 1 } },
  { agent: admire, decision: { outcome: 'IGNORE' as const, source: 'llm_decision' as const, latencyMs: 1 } },
];
assert.equal(applyInitialUserTurnFallback(ignoreDecisions, userOnlyHistory, 0).filter(result => result.decision.outcome === 'RESPOND' && result.decision.source === 'fallback').length, 1);
assert.equal(applyInitialUserTurnFallback([{ agent: curren, decision: { outcome: 'RESPOND' as const, source: 'llm_decision' as const, latencyMs: 1 } }, ignoreDecisions[1]], userOnlyHistory, 0).filter(result => result.decision.outcome === 'RESPOND').length, 1);
assert.equal(applyInitialUserTurnFallback([{ agent: curren, decision: { outcome: 'ERROR' as const, source: 'api_error' as const, latencyMs: 1 } }, ignoreDecisions[1]], userOnlyHistory, 0).find(result => result.agent.id === 'admire')?.decision.source, 'fallback');
assert.equal(applyInitialUserTurnFallback([{ agent: curren, decision: { outcome: 'ERROR' as const, source: 'api_error' as const, latencyMs: 1 } }, { agent: admire, decision: { outcome: 'ERROR' as const, source: 'api_error' as const, latencyMs: 1 } }], userOnlyHistory, 0).filter(result => result.decision.outcome === 'RESPOND').length, 0);
assert.equal(applyInitialUserTurnFallback(ignoreDecisions, userOnlyHistory, 1).filter(result => result.decision.outcome === 'RESPOND').length, 0);
assert.equal(selectFallbackAgent([curren, admire], [...userOnlyHistory, { id: 'm1', role: 'model' as const, agentId: 'curren', content: 'x', timestamp: 2 }])?.id, 'admire');
assert.equal(selectFallbackAgent([curren], userOnlyHistory)?.id, 'curren');
const turnLimitOnly = [
  { agent: curren, decision: { outcome: 'IGNORE' as const, source: 'turn_limit' as const, latencyMs: 0 } },
  { agent: admire, decision: { outcome: 'IGNORE' as const, source: 'turn_limit' as const, latencyMs: 0 } },
];
assert.equal(applyInitialUserTurnFallback(turnLimitOnly, userOnlyHistory, 0).filter(result => result.decision.source === 'fallback').length, 1);
assert.equal(applyInitialUserTurnFallback(turnLimitOnly, userOnlyHistory, 1).filter(result => result.decision.source === 'fallback').length, 0);

console.log('All production-module diagnostics/context tests passed');
