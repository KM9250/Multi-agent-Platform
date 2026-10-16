// Server-only entry point. Deliberately NOT exported from the browser barrel.
import { DeliveryError } from './deliveryError';
import type { NotificationDeliveryReceipt } from './deliveryError';
import type { MacpNotificationPacket } from './macpPacket';
import type { NotificationTransport } from './transport';

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
      this.#endpoint = url.href; this.#token = options.token; this.#timeoutMs = timeout;
      this.#fetch = options.fetch ?? globalThis.fetch;
      if (typeof this.#fetch !== 'function') throw 0;
      this.idempotencySupported = options.idempotencyConfirmed === true;
    } catch { throw new DeliveryError('INVALID_CONFIGURATION'); }
  }
  async send(packet: MacpNotificationPacket, signal?: AbortSignal): Promise<NotificationDeliveryReceipt> {
    if (signal?.aborted) throw new DeliveryError('ABORTED');
    const controller = new AbortController();
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
    try {
      if (controller.signal.aborted) throw new DeliveryError('ABORTED');
      response = await Promise.race([this.#fetch(this.#endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(this.#token ? { Authorization: `Bearer ${this.#token}` } : {}) },
        body: JSON.stringify(packet), signal: controller.signal, redirect: 'error', credentials: 'omit', cache: 'no-store',
      }), aborted]);
      const status = response.status;
      if (status !== 200 && status !== 201) throw new DeliveryError('HTTP_ERROR', [429, 502, 503, 504].includes(status), status);
      const value = await Promise.race([readResponse(response), aborted]);
      if (!value || value.ok !== true || value.task_id !== packet.task_id
        || !Number.isSafeInteger(value.event_id) || value.event_id <= 0
        || value.idempotent_replay !== (status === 200)) throw new DeliveryError('INVALID_RESPONSE', false, status);
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
async function readResponse(response: Response): Promise<Record<string, any>> {
  const reader = response.body?.getReader();
  if (!reader) throw new DeliveryError('INVALID_RESPONSE', false, response.status);
  let length = 0, text = '';
  const decoder = new TextDecoder();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > 65536) throw new DeliveryError('INVALID_RESPONSE', false, response.status);
      text += decoder.decode(chunk.value, { stream: true });
    }
    try { return JSON.parse(text + decoder.decode()); }
    catch { throw new DeliveryError('INVALID_RESPONSE', false, response.status); }
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}
