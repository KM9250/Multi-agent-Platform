// Server-only entry point. Deliberately NOT exported from the browser barrel.
import { DeliveryError } from './deliveryError';
import type { NotificationDeliveryReceipt } from './deliveryError';
import type { MacpNotificationPacket } from './macpPacket';
import type { NotificationTransport } from './transport';
import { types } from 'node:util';

export interface MacpHttpNotificationTransportOptions {
  /** Trusted deployment configuration, never model/page input. Full /api/notify URL. */
  endpoint: string;
  token?: string;
  allowDevelopmentLoopback?: boolean;
  /** Operator has verified COORD-4B on this server; enables bounded retries. */
  idempotencyConfirmed?: boolean;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}
export class MacpHttpNotificationTransport implements NotificationTransport {
  readonly idempotencySupported: boolean;
  #endpoint: string;
  #token?: string;
  #timeoutMs: number;
  #fetch: typeof globalThis.fetch;
  constructor(options: MacpHttpNotificationTransportOptions) {
    if (typeof window !== 'undefined' || typeof process === 'undefined' || !process.versions?.node) {
      throw new DeliveryError('INVALID_CONFIGURATION');
    }
    try {
      const url = new URL(options.endpoint);
      const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback && options.allowDevelopmentLoopback === true)) throw 0;
      if (url.username || url.password || url.search || url.hash || url.pathname !== '/api/notify') throw 0;
      const timeout = options.timeoutMs ?? 10000;
      if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 120000) throw 0;
      if (options.token !== undefined && (typeof options.token !== 'string' || !options.token.trim()
        || /[^\x21-\x7e]/.test(options.token) || options.token.length > 8192)) throw 0;
      // An omitted production identity never degrades to anonymous delivery.
      if (!options.token && !(loopback && options.allowDevelopmentLoopback === true)) throw 0;
      this.#endpoint = url.href; this.#token = options.token; this.#timeoutMs = timeout;
      this.#fetch = options.fetch ?? globalThis.fetch;
      if (typeof this.#fetch !== 'function') throw 0;
      this.idempotencySupported = options.idempotencyConfirmed === true;
    } catch { throw new DeliveryError('INVALID_CONFIGURATION'); }
  }
  async send(packet: MacpNotificationPacket, signal?: AbortSignal): Promise<NotificationDeliveryReceipt> {
    if (signal?.aborted) throw new DeliveryError('ABORTED');
    const serialized = serializePacket(packet);
    const controller = new AbortController();
    const deadline = performance.now() + this.#timeoutMs;
    let timedOut = false;
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.#timeoutMs);
    let onAbort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new DeliveryError(timedOut ? 'TIMEOUT' : 'ABORTED', timedOut));
      controller.signal.addEventListener('abort', onAbort, { once: true });
      if (controller.signal.aborted) onAbort();
    });
    let response: Response | undefined;
    const checkDeadline = () => {
      if (performance.now() >= deadline) {
        timedOut = true; controller.abort(); throw new DeliveryError('TIMEOUT', true);
      }
      if (controller.signal.aborted) throw new DeliveryError(timedOut ? 'TIMEOUT' : 'ABORTED', timedOut);
    };
    try {
      checkDeadline();
      const pending = this.#fetch(this.#endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(this.#token ? { Authorization: `Bearer ${this.#token}` } : {}) },
        body: serialized.body, signal: controller.signal, redirect: 'error', credentials: 'omit', cache: 'no-store',
      });
      // The injected HTTP client is host code, but its return is still data until
      // validated. Promise.race must not assimilate an arbitrary thenable.
      if (!types.isPromise(pending) || types.isProxy(pending)
        || Object.getOwnPropertyDescriptor(pending, 'then') || Object.getOwnPropertyDescriptor(pending, 'constructor')
        || Object.getPrototypeOf(pending) !== Promise.prototype) throw new DeliveryError('INVALID_RESPONSE');
      response = await Promise.race([pending, aborted]);
      checkDeadline();
      if (!response || types.isProxy(response) || !(response instanceof Response)) {
        response = undefined; throw new DeliveryError('INVALID_RESPONSE');
      }
      const status = response.status;
      if (status !== 200 && status !== 201) throw new DeliveryError('HTTP_ERROR', [429, 502, 503, 504].includes(status), status);
      const value = await Promise.race([readResponse(response, checkDeadline), aborted]);
      checkDeadline();
      if (!value || value.ok !== true || value.task_id !== serialized.taskId
        || !Number.isSafeInteger(value.event_id) || value.event_id <= 0
        || value.idempotent_replay !== (status === 200)) throw new DeliveryError('INVALID_RESPONSE', false, status);
      checkDeadline();
      return { taskId: value.task_id, eventId: value.event_id, idempotentReplay: value.idempotent_replay, httpStatus: status };
    } catch (error) {
      if (error instanceof DeliveryError) throw error;
      if (controller.signal.aborted) throw new DeliveryError(timedOut ? 'TIMEOUT' : 'ABORTED', timedOut);
      throw new DeliveryError('NETWORK_ERROR', true);
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', onAbort);
      if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
    }
  }
}

/** Bound untrusted response size and parse only the contract fields. */
async function readResponse(response: Response, checkDeadline: () => void): Promise<Record<string, any>> {
  const reader = response.body?.getReader();
  if (!reader) throw new DeliveryError('INVALID_RESPONSE', false, response.status);
  let length = 0, text = '';
  const decoder = new TextDecoder();
  try {
    while (true) {
      checkDeadline();
      const chunk = await reader.read();
      checkDeadline();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > 65536) throw new DeliveryError('INVALID_RESPONSE', false, response.status);
      text += decoder.decode(chunk.value, { stream: true });
    }
    try { return JSON.parse(text + decoder.decode()); }
    catch { throw new DeliveryError('INVALID_RESPONSE', false, response.status); }
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Inspect descriptors before serialization: do not execute packet getters/toJSON/proxies. */
function serializePacket(packet: MacpNotificationPacket): { body: string; taskId: string } {
  try {
    let nodes = 0;
    const seen = new Set<object>();
    const copy = (value: unknown, depth: number): unknown => {
      if (++nodes > 100 || depth > 5) throw 0;
      if (value === null || typeof value === 'boolean') return value;
      if (typeof value === 'string') { if (value.length > 4096) throw 0; return value; }
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (typeof value !== 'object' || !value || types.isProxy(value) || seen.has(value)) throw 0;
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) throw 0;
      seen.add(value);
      const output: Record<string, unknown> = Object.create(null);
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string' || ['__proto__', 'prototype', 'constructor', 'toJSON', 'then'].includes(key)) throw 0;
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        if (!('value' in descriptor) || !descriptor.enumerable) throw 0;
        output[key] = copy(descriptor.value, depth + 1);
      }
      seen.delete(value); return output;
    };
    const safe = copy(packet, 0) as Record<string, unknown>;
    if (typeof safe.task_id !== 'string' || !safe.task_id) throw 0;
    const body = JSON.stringify(safe);
    if (Buffer.byteLength(body, 'utf8') > 4096) throw 0;
    return { body, taskId: safe.task_id };
  } catch { throw new DeliveryError('INVALID_CONFIGURATION'); }
}
