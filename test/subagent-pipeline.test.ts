import assert from 'node:assert/strict';
import test from 'node:test';
import type { Agent, Message, SubAgentDefinition } from '../types';
import type { SubAgentProvider } from '../services/subagents/providers/types';
import { SubAgentProviderRegistry } from '../services/subagents/providers/providerRegistry';
import { GenerationSubAgentCache, runFixedSerialPipeline } from '../services/subagents/fixedSerialPipeline';
import { extractPublicTaskInputs, formatPrivateSubAgentContext, injectPrivateContextIntoContents } from '../services/subagents/privateContext';
import { createCheckerPreset, createTaskAnalystPreset } from '../services/subagents/presets';

const worker = (id: string): SubAgentDefinition => ({ id, name: id, description: `Do ${id}`, provider: 'fake', model: 'fake-model', systemInstruction: 'non-persona', capabilities: [id], isEnabled: true });
const agent: Agent = { id: 'parent', name: 'Parent', description: '', systemInstruction: '', model: 'gemini-2.5-flash', framework: 'standard', color: '', avatar: '', isEnabled: true, thinkingBudget: 0, subAgentPolicy: { mode: 'fixed_serial' }, subAgents: [worker('A'), worker('B')] };
function registry(generate: SubAgentProvider['generate']) { const value = new SubAgentProviderRegistry(); value.registerProvider({ id: 'fake', generate }); return value; }
const contractFromPrompt = (prompt: string) => JSON.parse(prompt.slice(prompt.indexOf('{'), prompt.lastIndexOf('}') + 1));

test('fixed pipeline is serial and chains only normalized prior results', async () => {
  const order: string[] = []; const contracts: any[] = [];
  const outcome = await runFixedSerialPipeline(agent, { sessionId: 's', inputs: [{ name: 'user_request', content: 'public request' }], registry: registry(async req => {
    const contract = contractFromPrompt(req.prompt); contracts.push(contract); order.push(`${contract.subAgentId} starts`); await new Promise(resolve => setTimeout(resolve, 2)); order.push(`${contract.subAgentId} completes`);
    return { text: JSON.stringify({ taskId: contract.taskId, subAgentId: contract.subAgentId, status: 'completed', summary: `validated ${contract.subAgentId}`, result: { safe: true }, unknownRaw: 'discard me' }), provider: 'fake', model: req.model, latencyMs: 2 };
  }) });
  assert.deepEqual(order, ['A starts', 'A completes', 'B starts', 'B completes']); assert.equal(outcome.status, 'completed');
  const prior = contracts[1].inputs.find((input: any) => input.name === 'previous_subagent_result_1').content;
  assert.match(prior, /validated A/); assert.doesNotMatch(prior, /unknownRaw/);
});

test('public extractor selects latest user and safe attachments only', () => {
  const messages: Message[] = [
    { id: 'old', role: 'user', content: 'old request', timestamp: 1, attachments: [{ id: 'old-file', type: 'text', name: 'old.txt', mimeType: 'text/plain', data: 'old secret' }] },
    { id: 'private', role: 'model', agentId: 'other', content: 'another agent message', timestamp: 2, segments: [{ id: 'x', channel: 'private_state', visibility: 'self_only', content: 'private_state secret debug_thoughts secret gm_log secret memory_export secret' }] },
    { id: 'latest', role: 'user', content: 'public latest user request', timestamp: 3, attachments: [{ id: 'text', type: 'text', name: 'requirements.txt', mimeType: 'text/plain', data: 'requirements' }, { id: 'image', type: 'image', name: 'photo.png', mimeType: 'image/png', data: 'data:image/png;base64,SECRET' }] },
  ];
  const serialized = JSON.stringify(extractPublicTaskInputs(messages)); assert.match(serialized, /public latest user request/); assert.match(serialized, /requirements/); assert.match(serialized, /photo.png/);
  for (const forbidden of ['old request', 'old secret', 'another agent message', 'private_state secret', 'base64,SECRET']) assert.doesNotMatch(serialized, new RegExp(forbidden));
});

test('invalid output stops dependents but sanitized fallback permits parent', async () => {
  let calls = 0; const outcome = await runFixedSerialPipeline(agent, { sessionId: 's', inputs: [], registry: registry(async req => { calls++; return { text: 'RAW INVALID SECRET', provider: 'fake', model: req.model, latencyMs: 1 }; }) });
  assert.equal(calls, 1); assert.equal(outcome.status, 'failed'); assert.equal(outcome.reports.length, 0); const context = formatPrivateSubAgentContext(outcome.reports, true)!; assert.match(context, /worker was unavailable/); assert.doesNotMatch(context, /RAW INVALID SECRET/);
});

test('parent abort stops current and next worker', async () => {
  const controller = new AbortController(); let calls = 0;
  const promise = runFixedSerialPipeline(agent, { sessionId: 's', inputs: [], signal: controller.signal, registry: registry(req => new Promise(resolve => { calls++; req.signal?.addEventListener('abort', () => resolve({ text: '', provider: 'fake', model: req.model, latencyMs: 1 })); })) });
  setTimeout(() => controller.abort(), 2); const outcome = await promise; assert.equal(outcome.status, 'aborted'); assert.equal(calls, 1);
});

test('session cache deduplicates same persona but a retry cache reruns', async () => {
  let calls = 0; const singleAgent = { ...agent, subAgents: [worker('A')] }; const fake = registry(async req => { calls++; const c = contractFromPrompt(req.prompt); return { text: JSON.stringify({ taskId: c.taskId, subAgentId: c.subAgentId, status: 'completed', summary: 'ok' }), provider: 'fake', model: req.model, latencyMs: 0 }; });
  const cache = new GenerationSubAgentCache(); const options = { sessionId: 'one', inputs: [], registry: fake }; await Promise.all([cache.prepare(singleAgent, options), cache.prepare(singleAgent, options)]); assert.equal(calls, 1);
  await new GenerationSubAgentCache().prepare(singleAgent, { ...options, sessionId: 'retry' }); assert.equal(calls, 2);
});

test('private injection is immutable and precedes regenerate instruction', () => {
  const contents = [{ role: 'user', parts: [{ text: 'request' }] }]; const before = structuredClone(contents); const injected = injectPrivateContextIntoContents(contents, 'PRIVATE REPORT'); assert.deepEqual(contents, before); assert.match(JSON.stringify(injected), /PRIVATE REPORT/);
  const regenerate = [...injected, { role: 'user', parts: [{ text: 'regenerate instruction' }] }]; assert.match(JSON.stringify(regenerate.at(-1)), /regenerate instruction/);
});

test('generic presets are Google non-persona workers without tool claims', () => {
  for (const preset of [createTaskAnalystPreset(), createCheckerPreset()]) { assert.equal(preset.provider, 'google'); assert.match(preset.model, /^gemini-/); assert.match(preset.systemInstruction, /non-persona/); assert.match(preset.systemInstruction, /Do not claim/); assert.equal(preset.isEnabled, true); }
});
