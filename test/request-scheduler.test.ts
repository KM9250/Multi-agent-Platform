import test from 'node:test';
import assert from 'node:assert/strict';
import { RequestScheduler, isTransientSchedulerError } from '../services/scheduler/index.ts';
import { consumeGenerationStreamAttempt } from '../services/geminiService.ts';
import { GoogleSubAgentProvider } from '../services/subagents/providers/googleProvider.ts';

const deferred = <T = void>() => { let resolve!: (value: T | PromiseLike<T>) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const scheduler = (limit = 2, maxAttempts = 3) => new RequestScheduler({ defaultConcurrencyPerModel: limit, retry: { maxAttempts, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 }, random: () => 0.5 });

test('same provider/model is capped, queued work starts on release, and FIFO is preserved', async () => {
  const subject = scheduler(2); const gates = [deferred(), deferred(), deferred()];
  let running = 0; let maximum = 0; const starts: number[] = [];
  const jobs = gates.map((gate, index) => subject.schedule({ provider: 'google', model: 'flash', kind: 'generation', execute: async () => { starts.push(index); maximum = Math.max(maximum, ++running); await gate.promise; running--; return index; } }));
  await tick(); assert.deepEqual(starts, [0, 1]); assert.equal(maximum, 2);
  gates[0].resolve(); await tick(); assert.deepEqual(starts, [0, 1, 2]);
  gates[1].resolve(); gates[2].resolve(); assert.deepEqual(await Promise.all(jobs), [0, 1, 2]);
});

test('different model keys run independently', async () => {
  const subject = scheduler(1); const gate = deferred(); const starts: string[] = [];
  const first = subject.schedule({ provider: 'google', model: 'flash', kind: 'decision', execute: async () => { starts.push('flash'); await gate.promise; } });
  const second = subject.schedule({ provider: 'google', model: 'pro', kind: 'generation', execute: async () => { starts.push('pro'); } });
  await tick(); assert.deepEqual(starts, ['flash', 'pro']); gate.resolve(); await Promise.all([first, second]);
});

test('decision and subagent share a model concurrency key', async () => {
  const subject = scheduler(1); const gate = deferred(); let subagentStarted = false;
  const first = subject.schedule({ provider: 'google', model: 'flash', kind: 'decision', execute: () => gate.promise });
  const second = subject.schedule({ provider: 'google', model: 'flash', kind: 'subagent', execute: async () => { subagentStarted = true; } });
  await tick(); assert.equal(subagentStarted, false); gate.resolve(); await Promise.all([first, second]); assert.equal(subagentStarted, true);
});

test('queued abort rejects without invoking execute', async () => {
  const subject = scheduler(1); const gate = deferred(); const controller = new AbortController(); let invoked = false;
  const first = subject.schedule({ provider: 'google', model: 'flash', kind: 'generation', execute: () => gate.promise });
  const queued = subject.schedule({ provider: 'google', model: 'flash', kind: 'generation', signal: controller.signal, execute: async () => { invoked = true; } });
  controller.abort(); await assert.rejects(queued, { name: 'AbortError' }); assert.equal(invoked, false); gate.resolve(); await first;
});

test('running work receives the caller signal', async () => {
  const subject = scheduler(1); const controller = new AbortController(); let received: AbortSignal | undefined;
  const result = subject.schedule({ provider: 'google', model: 'flash', kind: 'generation', signal: controller.signal, execute: async () => { received = controller.signal; await new Promise<void>((_, reject) => controller.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))); } });
  await tick(); controller.abort(); await assert.rejects(result, { name: 'AbortError' }); assert.equal(received?.aborted, true);
});

for (const status of [429, 503]) test(`${status} retries`, async () => {
  const subject = scheduler(); let attempts = 0;
  const value = await subject.schedule({ provider: 'google', model: 'flash', kind: 'decision', execute: async () => { if (++attempts < 2) throw Object.assign(new Error(String(status)), { status }); return 'ok'; } });
  assert.equal(value, 'ok'); assert.equal(attempts, 2);
});

test('temporary network errors retry, authentication and abort errors do not', async () => {
  assert.equal(isTransientSchedulerError(new Error('NetworkError: timeout')), true);
  for (const error of [Object.assign(new Error('unauthorized'), { status: 401 }), new DOMException('aborted', 'AbortError')]) {
    let attempts = 0;
    await assert.rejects(scheduler().schedule({ provider: 'google', model: 'flash', kind: 'decision', execute: async () => { attempts++; throw error; } }));
    assert.equal(attempts, 1);
  }
});

test('maxAttempts is total attempts and output-started errors never retry', async () => {
  let attempts = 0;
  await assert.rejects(scheduler(1, 3).schedule({ provider: 'google', model: 'flash', kind: 'decision', execute: async () => { attempts++; throw Object.assign(new Error('unavailable'), { status: 503 }); } }));
  assert.equal(attempts, 3);
  attempts = 0;
  await assert.rejects(scheduler().schedule({ provider: 'google', model: 'flash', kind: 'generation', execute: async context => { attempts++; context.markOutputStarted(); throw Object.assign(new Error('unavailable'), { status: 503 }); } }));
  assert.equal(attempts, 1);
});

test('stream errors before output may retry and diagnostics are bounded and prompt-free', async () => {
  const subject = new RequestScheduler({ defaultConcurrencyPerModel: 1, diagnosticsLimit: 3, retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 } }); let attempts = 0;
  await subject.schedule({ provider: 'google', model: 'flash', kind: 'generation', execute: async () => { if (++attempts === 1) throw Object.assign(new Error('503 private prompt'), { status: 503 }); } });
  assert.equal(attempts, 2); assert.equal(subject.getDiagnostics().length, 3); assert.equal(JSON.stringify(subject.getDiagnostics()).includes('private prompt'), false);
});

test('diagnostic observer failures cannot synchronously break scheduling or retry a completed request', async () => {
  const subject = scheduler(); let executions = 0;
  subject.subscribe(event => {
    if (event.state === 'queued' || event.state === 'completed') throw new Error('observer failed');
  });
  let scheduled: Promise<string> | undefined;
  assert.doesNotThrow(() => {
    scheduled = subject.schedule({ provider: 'google', model: 'flash', kind: 'decision', execute: async () => { executions++; return 'ok'; } });
  });
  assert.equal(await scheduled, 'ok');
  assert.equal(executions, 1);
});

test('invalid scheduler configuration is rejected eagerly', () => {
  for (const value of [NaN, Infinity, 1.5, 0]) {
    assert.throws(() => new RequestScheduler({ defaultConcurrencyPerModel: value }));
    assert.throws(() => new RequestScheduler({ retry: { maxAttempts: value } }));
  }
  assert.throws(() => new RequestScheduler({ retry: { baseDelayMs: -1 } }));
  assert.throws(() => new RequestScheduler({ retry: { baseDelayMs: 10, maxDelayMs: 9 } }));
  assert.throws(() => new RequestScheduler({ retry: { jitterRatio: -0.1 } }));
  assert.throws(() => new RequestScheduler({ retry: { jitterRatio: 1.1 } }));
  for (const value of [NaN, Infinity, 1.5, -1]) assert.throws(() => new RequestScheduler({ diagnosticsLimit: value }));
  assert.doesNotThrow(() => new RequestScheduler({ diagnosticsLimit: 0 }));
});

test('failed stream attempt metadata is discarded before retry', async () => {
  const subject = scheduler(1, 2); let attempt = 0; let finalMetadata = {};
  await subject.schedule({
    provider: 'google', model: 'flash', kind: 'generation',
    execute: async context => {
      attempt++;
      const stream = attempt === 1
        ? (async function* () { yield { finishReason: 'SAFETY' }; throw Object.assign(new Error('503'), { status: 503 }); })()
        : (async function* () { yield { finishReason: 'STOP' }; })();
      finalMetadata = await consumeGenerationStreamAttempt(stream, undefined, context, () => {});
    },
  });
  assert.deepEqual(finalMetadata, { finishReason: 'STOP', finishMessage: undefined, safetyRatings: undefined, promptFeedback: undefined });
});

test('Google SubAgent provider shares scheduler concurrency at the provider boundary', async () => {
  const subject = scheduler(1); const gates = [deferred(), deferred()];
  let running = 0; let maximum = 0; let calls = 0;
  const fakeClient = { models: { generateContent: async () => {
    const index = calls++; maximum = Math.max(maximum, ++running);
    await gates[index].promise; running--;
    return { text: `{ "summary": "${index}" }` };
  } } };
  const provider = new GoogleSubAgentProvider('fake', fakeClient as any, subject);
  const request = { model: 'flash', systemInstruction: 'system', prompt: 'prompt' };
  const first = provider.generate(request); const second = provider.generate(request);
  await tick(); assert.equal(calls, 1); assert.equal(maximum, 1);
  gates[0].resolve(); await tick(); assert.equal(calls, 2); assert.equal(maximum, 1);
  gates[1].resolve(); await Promise.all([first, second]);
});

test('a completed retry wait removes its abort listener', async () => {
  const subject = new RequestScheduler({ defaultConcurrencyPerModel: 1, retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } });
  const controller = new AbortController(); let added = 0; let removed = 0; let attempts = 0;
  const add = controller.signal.addEventListener.bind(controller.signal);
  const remove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = ((...args: Parameters<AbortSignal['addEventListener']>) => { added++; return add(...args); }) as AbortSignal['addEventListener'];
  controller.signal.removeEventListener = ((...args: Parameters<AbortSignal['removeEventListener']>) => { removed++; return remove(...args); }) as AbortSignal['removeEventListener'];
  await subject.schedule({ provider: 'google', model: 'flash', kind: 'decision', signal: controller.signal, execute: async () => {
    if (++attempts === 1) throw Object.assign(new Error('503'), { status: 503 });
  } });
  // One queue listener and one retry-wait listener are both removed normally.
  assert.equal(added, removed);
});
