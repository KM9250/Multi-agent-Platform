import assert from 'node:assert/strict';
import test from 'node:test';
import type { Agent, SubAgentDefinition } from '../types';
import { normalizeAgent } from '../utils/contextFiles';
import { buildSubAgentPrompt } from '../services/subagents/subAgentPrompt';
import { createSubAgentRun, executeSubAgentTask } from '../services/subagents/subAgentRunner';
import { SubAgentProviderRegistry, ProviderNotConfiguredError } from '../services/subagents/providers/providerRegistry';
import type { SubAgentProvider } from '../services/subagents/providers/types';
import type { SubAgentTaskContract } from '../services/subagents/types';

const definition: SubAgentDefinition = { id: 'worker', name: 'Worker', provider: 'fake', model: 'small', systemInstruction: 'Work precisely.', isEnabled: true };
const task: SubAgentTaskContract = { taskId: 'task-1', parentAgentId: 'parent', subAgentId: 'worker', taskType: 'review', goal: 'Review input', inputs: [{ name: 'candidate', content: 'safe explicit input' }] };
const response = (overrides = {}) => JSON.stringify({ taskId: task.taskId, subAgentId: task.subAgentId, status: 'completed', summary: 'done', result: { ok: true }, ...overrides });

test('registry selects exact providers and never falls back', () => {
  const registry = new SubAgentProviderRegistry();
  const fake: SubAgentProvider = { id: 'fake', async generate(req) { return { text: response(), provider: 'fake', model: req.model, latencyMs: 1 }; } };
  registry.registerProvider(fake);
  assert.equal(registry.getProvider('fake'), fake);
  assert.throws(() => registry.getProvider('openai'), (error: unknown) => error instanceof ProviderNotConfiguredError && error.code === 'PROVIDER_NOT_CONFIGURED');
});

test('runner accepts explicit contract and preserves identifiers and metadata', async () => {
  const fake: SubAgentProvider = { id: 'fake', async generate(req) { return { text: response(), provider: 'fake', model: req.model, latencyMs: 7 }; } };
  const result = await executeSubAgentTask(definition, task, { provider: fake });
  assert.equal(result.status, 'completed');
  assert.equal(result.taskId, task.taskId);
  assert.equal(result.subAgentId, task.subAgentId);
  assert.deepEqual(result.metadata, { provider: 'fake', model: 'small', latencyMs: 7 });
});

test('runner fails closed for missing provider and malformed or mismatched output', async () => {
  const missing = await executeSubAgentTask({ ...definition, provider: 'missing' }, task, { registry: new SubAgentProviderRegistry() });
  assert.equal(missing.errorCode, 'PROVIDER_NOT_CONFIGURED');
  const invalid: SubAgentProvider = { id: 'fake', async generate() { return { text: 'raw text', provider: 'fake', model: 'small', latencyMs: 0 }; } };
  assert.equal((await executeSubAgentTask(definition, task, { provider: invalid })).errorCode, 'INVALID_TASK_RESULT');
  const mismatch: SubAgentProvider = { id: 'fake', async generate() { return { text: response({ taskId: 'other' }), provider: 'fake', model: 'small', latencyMs: 0 }; } };
  assert.equal((await executeSubAgentTask(definition, task, { provider: mismatch })).status, 'failed');
});

test('prompt contains only the contract, not ambient Room or internal state', () => {
  const prompt = buildSubAgentPrompt(task);
  assert.match(prompt, /safe explicit input/);
  for (const secret of ['unshared room line', 'private_state secret', 'debug_thoughts secret', 'gm_log secret', 'memory_export secret']) assert.doesNotMatch(prompt, new RegExp(secret));
});

test('private execution cannot mutate conversation state', async () => {
  const room = { messages: [{ id: 'm', role: 'user', content: 'unshared room line', timestamp: 1 }], decisionEvents: [{ id: 'd' }], agents: [{ id: 'parent' }] };
  const before = structuredClone(room);
  const fake: SubAgentProvider = { id: 'fake', async generate(req) { assert.doesNotMatch(req.prompt, /unshared room line/); return { text: response(), provider: 'fake', model: req.model, latencyMs: 0 }; } };
  await executeSubAgentTask(definition, task, { provider: fake });
  assert.deepEqual(room, before);
});

test('independent runs are unique and one failure does not damage another', async () => {
  const ok: SubAgentProvider = { id: 'fake', async generate(req) { await new Promise(resolve => setTimeout(resolve, 5)); return { text: response(), provider: 'fake', model: req.model, latencyMs: 5 }; } };
  const bad: SubAgentProvider = { id: 'fake', async generate() { throw new Error('isolated failure'); } };
  const first = createSubAgentRun(definition, task, { provider: ok });
  const secondTask = { ...task, taskId: 'task-2' };
  const second = createSubAgentRun(definition, secondTask, { provider: bad });
  assert.notEqual(first.run.runId, second.run.runId);
  const [a, b] = await Promise.all([first.execute(), second.execute()]);
  assert.equal(a.status, 'completed');
  assert.equal(b.status, 'failed');
  assert.equal(first.run.status, 'completed');
  assert.equal(second.run.status, 'failed');
});

test('parent abort reaches provider and produces aborted lifecycle', async () => {
  const parent = new AbortController();
  let observedSignal: AbortSignal | undefined;
  const provider: SubAgentProvider = { id: 'fake', generate(req) { observedSignal = req.signal; return new Promise((_resolve, reject) => req.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })); } };
  const handle = createSubAgentRun(definition, task, { provider, signal: parent.signal });
  const pending = handle.execute();
  parent.abort();
  const result = await pending;
  assert.equal(observedSignal?.aborted, true);
  assert.equal(result.status, 'aborted');
  assert.equal(handle.run.status, 'aborted');
});

test('legacy normalization and edits preserve SubAgent settings', () => {
  const base = { id: 'parent', name: 'Parent', description: '', systemInstruction: '', model: 'small', framework: 'standard', color: '', avatar: '', isEnabled: true, thinkingBudget: 0 } as Agent;
  assert.deepEqual(normalizeAgent(base).subAgents, []);
  const configured = { ...base, subAgents: [definition] };
  assert.deepEqual(normalizeAgent(configured).subAgents, [definition]);
});
