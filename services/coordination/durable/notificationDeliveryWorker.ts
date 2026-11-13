import type { NotificationRuntime } from './notificationDeliveryCoordinator';
import { notificationId, notificationInput } from './notificationDeliveryAuthority';
import { DurableStoreError } from './integrity';

export interface NotificationWorkerOptions { workflowRunIds: readonly string[]; pollIntervalMs?: number; cursor?: number; }
export interface NotificationWorkerCycle { completed: number; failed: number; nextCursor: number; }

/** Explicit Node host lifecycle. Construction and readers never start this worker. */
export class DurableNotificationWorker {
  readonly #runtime: NotificationRuntime;
  readonly #credential: unknown;
  readonly #workflows: readonly string[];
  readonly #poll: number;
  #started = false;
  #halted = false;
  #generation = 0;
  #cursor = 0;
  #timer?: ReturnType<typeof setTimeout>;
  #cycle?: Promise<NotificationWorkerCycle>;
  #abort?: AbortController;
  constructor(runtime: NotificationRuntime, credential: unknown, options: NotificationWorkerOptions) {
    const clean = notificationInput(options, 1024 * 1024);
    if (Object.keys(clean).some(key => !['workflowRunIds', 'pollIntervalMs', 'cursor'].includes(key))
      || !Array.isArray(clean.workflowRunIds) || clean.workflowRunIds.length > 10000
      || !clean.workflowRunIds.every(notificationId) || new Set(clean.workflowRunIds).size !== clean.workflowRunIds.length)
      throw new DurableStoreError('NOTIFICATION_INVALID_CONFIGURATION');
    if (clean.cursor !== undefined && (!Number.isSafeInteger(clean.cursor) || clean.cursor < 0
      || clean.cursor >= Math.max(clean.workflowRunIds.length, 1))) throw new DurableStoreError('NOTIFICATION_INVALID_CONFIGURATION');
    const poll = clean.pollIntervalMs ?? runtime.limits.pollIntervalMs;
    if (!Number.isSafeInteger(poll) || poll < 100 || poll > 60000) throw new DurableStoreError('NOTIFICATION_INVALID_CONFIGURATION');
    this.#runtime = runtime; this.#credential = credential; this.#workflows = Object.freeze([...clean.workflowRunIds]); this.#poll = poll;
    this.#cursor = clean.cursor ?? 0;
  }
  runOnce(): Promise<NotificationWorkerCycle> {
    if (this.#cycle) return this.#cycle;
    if (this.#halted) return Promise.resolve({ completed: 0, failed: 0, nextCursor: this.#cursor });
    const abort = new AbortController(); this.#abort = abort;
    const result: NotificationWorkerCycle = { completed: 0, failed: 0, nextCursor: this.#cursor };
    const batch = Math.min(this.#runtime.limits.batchSize, this.#workflows.length);
    let scanned = 0;
    const lane = async () => {
      while (!this.#halted && !abort.signal.aborted && scanned < batch) {
        const workflowRunId = this.#workflows[this.#cursor]; scanned++;
        this.#cursor = (this.#cursor + 1) % this.#workflows.length; result.nextCursor = this.#cursor;
        try { await this.#runtime.runOnce(this.#credential, { workflowRunId, signal: abort.signal }); result.completed++; }
        catch { result.failed++; } // Detailed fixed reasons remain in the authorized runtime reader.
      }
    };
    // Publish the cycle promise before callbacks can re-enter this worker.
    const cycle = Promise.resolve().then(() => Promise.all(Array.from({ length: Math.min(this.#runtime.limits.concurrency, this.#workflows.length) }, lane)))
      .then(() => result).finally(() => { if (this.#cycle === cycle) { this.#cycle = undefined; this.#abort = undefined; } });
    this.#cycle = cycle;
    return cycle;
  }
  start(): void {
    if (this.#started) return;
    this.#started = true; this.#halted = false;
    const generation = ++this.#generation;
    const poll = async () => {
      await this.runOnce();
      if (this.#started && generation === this.#generation) this.#timer = setTimeout(poll, this.#poll);
    };
    void poll();
  }
  async stop(graceMs = this.#runtime.limits.httpTimeoutMs + 1000): Promise<{ drained: boolean }> {
    if (!Number.isSafeInteger(graceMs) || graceMs < 0 || graceMs > 181000) throw new DurableStoreError('NOTIFICATION_INVALID_CONFIGURATION');
    this.#started = false; this.#halted = true; this.#generation++;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined; this.#abort?.abort();
    const cycle = this.#cycle;
    if (!cycle) return { drained: true };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([cycle.then(() => ({ drained: true })), new Promise<{ drained: boolean }>(resolve => {
        timer = setTimeout(() => resolve({ drained: false }), graceMs);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
}
