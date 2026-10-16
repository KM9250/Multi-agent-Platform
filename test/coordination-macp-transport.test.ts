import assert from 'node:assert/strict';
import test from 'node:test';
import { MacpHttpNotificationTransport } from '../services/coordination/notifications/macpTransport.ts';
import { DeliveryError, InMemoryNotificationOutbox, InMemoryCoordinationRunnerStore, toMacpNotificationPacket,
  deliverCoordinationNotification, deliverPendingCoordinationNotifications, projectCoordinationNotifications } from '../services/coordination/index.ts';
import { cancelled, notification, block, resume, approvalRef, fresh, deferred } from './notification-fixture.ts';
import type { MacpHttpNotificationTransportOptions } from '../services/coordination/notifications/macpTransport.ts';
const endpoint = 'https://macp.example/api/notify';
const packet = () => toMacpNotificationPacket(notification());
const response = (status = 201, fields: object = {}) => Response.json({ ok: true, task_id: packet().task_id, event_id: 1, idempotent_replay: status === 200, ...fields }, { status });
const adapter = (fetch: typeof globalThis.fetch, options: Partial<MacpHttpNotificationTransportOptions> = {}) => new MacpHttpNotificationTransport({ endpoint, fetch, ...options });
const errorIs = (code: string, retryable = false, status?: number) => (error: unknown) => {
  assert.ok(error instanceof DeliveryError); assert.equal(error.code, code); assert.equal(error.retryable, retryable);
  assert.equal(error.httpStatus, status); assert.equal(error.message, code); assert.equal(error.cause, undefined); return true;
};
for (const url of ['http://macp.example/api/notify', 'http://127.0.0.1/api/notify', 'ftp://localhost/api/notify',
  'https://user:password@macp.example/api/notify', 'https://macp.example/api/notify?token=secret',
  'https://macp.example/api/notify#secret', 'https://macp.example/api/tasks', 'not a url']) test(`reject untrusted endpoint configuration ${url}`, () => {
  assert.throws(() => new MacpHttpNotificationTransport({ endpoint: url }), errorIs('INVALID_CONFIGURATION'));
});
for (const host of ['localhost', '127.0.0.1', '[::1]']) test(`explicit development loopback ${host}`, () => {
  assert.ok(new MacpHttpNotificationTransport({ endpoint: `http://${host}:8765/api/notify`, allowDevelopmentLoopback: true }));
});
for (const options of [{ timeoutMs: 0 }, { timeoutMs: Infinity }, { token: 'secret\nheader' }, { token: '' }]) test('invalid config has sanitized errors', () => {
  assert.throws(() => new MacpHttpNotificationTransport({ endpoint, ...options }), errorIs('INVALID_CONFIGURATION'));
});
test('browser context rejects HTTP adapter construction even without a token', () => {
  Object.defineProperty(globalThis, 'window', { value: {}, configurable: true });
  try { assert.throws(() => new MacpHttpNotificationTransport({ endpoint }), errorIs('INVALID_CONFIGURATION')); }
  finally { delete (globalThis as any).window; }
});
for (const status of [200, 201]) test(`valid ${status} response and exact stable request with server-only auth`, async () => {
  const requests: RequestInit[] = [];
  const transport = adapter(async (url, init) => { assert.equal(url, endpoint); requests.push(init!); return response(status); }, { token: 'private-token', idempotencyConfirmed: true });
  for (let i = 0; i < 2; i++) assert.deepEqual(await transport.send(packet()), { taskId: packet().task_id, eventId: 1, idempotentReplay: status === 200, httpStatus: status });
  assert.equal(requests[0].body, requests[1].body);
  const sent = JSON.parse(requests[0].body as string);
  assert.equal(sent.producer_id, 'map-coordination'); assert.equal(sent.producer_event_id, sent.task_id);
  assert.equal(requests[0].redirect, 'error'); assert.equal(requests[0].credentials, 'omit');
  assert.deepEqual(requests[0].headers, { 'Content-Type': 'application/json', Authorization: 'Bearer private-token' });
  assert.doesNotMatch(JSON.stringify([transport, sent]), /private-token/);
});
for (const status of [400, 401, 403, 409, 422, 429, 500, 502, 503, 504, 302]) test(`HTTP ${status} normalizes retry policy without reading raw body`, async () => {
  await assert.rejects(adapter(async () => new Response('private-token exception', { status })).send(packet()), errorIs('HTTP_ERROR', [429, 502, 503, 504].includes(status), status));
});
for (const fields of [{ ok: false }, { ok: 'true' }, { task_id: 'foreign' }, { event_id: 0 }, { event_id: -1 },
  { event_id: 1.5 }, { event_id: '1' }, { event_id: Number.MAX_SAFE_INTEGER + 1 }, { idempotent_replay: true }, { idempotent_replay: undefined }]) test(`malformed success is rejected: ${JSON.stringify(fields)}`, async () => {
  await assert.rejects(adapter(async () => response(201, fields)).send(packet()), errorIs('INVALID_RESPONSE', false, 201));
});
test('200 requires an explicit replay acknowledgement; arbitrary 2xx is not success', async () => {
  await assert.rejects(adapter(async () => response(200, { idempotent_replay: false })).send(packet()), errorIs('INVALID_RESPONSE', false, 200));
  await assert.rejects(adapter(async () => new Response(null, { status: 204 })).send(packet()), errorIs('HTTP_ERROR', false, 204));
});
for (const body of ['raw-private-exception', 'x'.repeat(65537), 'null', '[]']) test('invalid/oversize response fails without retaining body', async () => {
  await assert.rejects(adapter(async () => new Response(body, { status: 201 })).send(packet()), errorIs('INVALID_RESPONSE', false, 201));
});
test('timeout, network loss and cancellation are distinct sanitized failures', async () => {
  await assert.rejects(adapter(async () => { throw new Error('private-token'); }).send(packet()), errorIs('NETWORK_ERROR', true));
  await assert.rejects(adapter(async () => new Promise<Response>(() => {}), { timeoutMs: 10 }).send(packet()), errorIs('TIMEOUT', true));
  const controller = new AbortController(); controller.abort('private');
  let calls = 0;
  await assert.rejects(adapter(async () => { calls++; return response(); }).send(packet(), controller.signal), errorIs('ABORTED'));
  assert.equal(calls, 0);
  await assert.rejects(adapter(async () => new Response(new ReadableStream({ start() {} }), { status: 201 }), { timeoutMs: 10 }).send(packet()), errorIs('TIMEOUT', true));
});
function setup() {
  const outbox = new InMemoryNotificationOutbox(), n = notification(), store = new InMemoryCoordinationRunnerStore([cancelled()]);
  outbox.enqueue(n); return { outbox, store, id: n.notificationId };
}
test('response loss converges via bounded identical retries; receipt and each HTTP attempt are audited safely', async () => {
  const f = setup(), bodies: string[] = [], delays: number[] = [];
  const transport = adapter(async (_, init) => {
    bodies.push(init!.body as string);
    if (bodies.length === 1) throw new Error('private-token');
    if (bodies.length === 2) return new Response('raw', { status: 503 });
    return response(200);
  }, { idempotencyConfirmed: true });
  assert.equal(await deliverCoordinationNotification(f.outbox, f.id, transport, f.store, {
    random: () => 0.5, baseDelayMs: 100, maxDelayMs: 150, sleep: async ms => { delays.push(ms); },
  }), 'delivered');
  assert.equal(new Set(bodies).size, 1); assert.deepEqual(delays, [75, 112.5]);
  const entry = f.outbox.get(f.id)!;
  assert.equal(entry.attempts, 3); assert.equal(entry.receipt!.eventId, 1);
  assert.deepEqual(entry.history.map(h => [h.state, h.errorCode, h.httpStatus]), [
    ['DELIVERY_FAILED', 'NETWORK_ERROR', undefined], ['DELIVERY_FAILED', 'HTTP_ERROR', 503], ['DELIVERED', undefined, 200],
  ]);
  assert.doesNotMatch(JSON.stringify(entry), /private-token|raw/);
  assert.deepEqual(f.store.getSnapshot('run'), cancelled());
});
for (const [confirmed, status, attempts] of [[false, 503, 1], [true, 503, 3], [true, 429, 3], [true, 401, 1], [true, 409, 1], [true, 422, 1]] as const) test(`retry cap: confirmed=${confirmed}, status=${status}`, async () => {
  const f = setup(); let calls = 0;
  const transport = adapter(async () => { calls++; return new Response('', { status }); }, { idempotencyConfirmed: confirmed });
  assert.equal(await deliverCoordinationNotification(f.outbox, f.id, transport, f.store, { sleep: async () => {} }), 'failed');
  assert.equal(calls, attempts); assert.equal(f.outbox.get(f.id)!.attempts, attempts);
});
test('resume during backoff suppresses retry before the next HTTP request', async () => {
  const initial = block(`RUNNER_NEEDS_USER:${approvalRef()}`), outbox = new InMemoryNotificationOutbox();
  const [n] = projectCoordinationNotifications(initial); outbox.enqueue(n); let current = initial, calls = 0;
  const transport = adapter(async () => { calls++; return new Response('', { status: 503 }); }, { idempotencyConfirmed: true });
  assert.equal(await deliverCoordinationNotification(outbox, n.notificationId, transport, { getSnapshot: () => current }, {
    sleep: async () => { current = resume(current, approvalRef()); },
  }), 'suppressed');
  assert.equal(calls, 1); assert.equal(outbox.get(n.notificationId)!.attempts, 1); assert.equal(outbox.prepareRetry(n.notificationId), false);
});
test('workflow lock spans retry backoff, other workflows continue, and duplicate workers cannot send the same ID', async () => {
  const f = setup(), gate = deferred(); let calls = 0;
  const transport = adapter(async () => { calls++; return calls === 1 ? new Response('', { status: 503 }) : response(); }, { idempotencyConfirmed: true });
  const first = deliverCoordinationNotification(f.outbox, f.id, transport, f.store, { sleep: () => gate.promise });
  // Let the first transport settle into backoff.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.outbox.get(f.id)!.state, 'DELIVERY_FAILED');
  f.outbox.prepareRetry(f.id);
  assert.equal(await deliverCoordinationNotification(f.outbox, f.id, transport, f.store), 'skipped');
  gate.resolve(); assert.equal(await first, 'failed'); // external prepareRetry cannot cause an unclaimed second send
  assert.equal(calls, 1);
  const another = block('other', fresh('other'));
  const otherStore = new InMemoryCoordinationRunnerStore([another]);
  const [n] = projectCoordinationNotifications(another); f.outbox.enqueue(n);
  await deliverPendingCoordinationNotifications(f.outbox, { async send() {} }, {
    getSnapshot: id => id === 'other' ? otherStore.getSnapshot(id) : f.store.getSnapshot(id),
  });
  assert.equal(f.outbox.get(n.notificationId)!.state, 'DELIVERED');
});

test('abort during a live request is not retried and abort during backoff prevents the next send', async () => {
  const f = setup(), controller = new AbortController(), started = deferred();
  let sends = 0;
  const transport = adapter(async () => { sends++; started.resolve(); return new Promise<Response>(() => {}); }, { idempotencyConfirmed: true });
  const delivery = deliverCoordinationNotification(f.outbox, f.id, transport, f.store, { signal: controller.signal });
  await started.promise; controller.abort('private-reason');
  assert.equal(await delivery, 'failed'); assert.equal(sends, 1); assert.equal(f.outbox.get(f.id)!.failureCode, 'ABORTED');
  const g = setup(), backoffAbort = new AbortController(); let retries = 0;
  const failing = adapter(async () => { retries++; return new Response('', { status: 503 }); }, { idempotencyConfirmed: true });
  assert.equal(await deliverCoordinationNotification(g.outbox, g.id, failing, g.store, {
    signal: backoffAbort.signal, sleep: async () => { backoffAbort.abort(); },
  }), 'failed');
  assert.equal(retries, 1); assert.equal(g.outbox.get(g.id)!.state, 'DELIVERY_FAILED');
});
