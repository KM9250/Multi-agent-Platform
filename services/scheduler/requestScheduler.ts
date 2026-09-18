import { isAbortError, isTransientSchedulerError, retryDelayMs, schedulerErrorCode } from './retryPolicy';
import type { RequestSchedulerConfig, SchedulerDiagnosticEvent, SchedulerJob } from './types';

type Queued<T = unknown> = { id: string; enqueuedAt: number; job: SchedulerJob<T>; resolve(value: T): void; reject(error: unknown): void; abort?: () => void };
type KeyState = { running: number; queue: Queued[] };

const abortError = (): DOMException => new DOMException('The operation was aborted', 'AbortError');
const wait = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(abortError());
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(abortError()); }, { once: true });
});

export const DEFAULT_SCHEDULER_CONFIG: RequestSchedulerConfig = {
  defaultConcurrencyPerModel: 2,
  retry: { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 8_000, jitterRatio: 0.2 },
};

export class RequestScheduler {
  private readonly states = new Map<string, KeyState>();
  private readonly events: SchedulerDiagnosticEvent[] = [];
  private readonly listeners = new Set<(event: SchedulerDiagnosticEvent) => void>();
  private sequence = 0;
  private readonly config: RequestSchedulerConfig;

  constructor(config: Partial<RequestSchedulerConfig> & { retry?: Partial<RequestSchedulerConfig['retry']> } = {}) {
    this.config = { ...DEFAULT_SCHEDULER_CONFIG, ...config, retry: { ...DEFAULT_SCHEDULER_CONFIG.retry, ...config.retry } };
    if (this.config.defaultConcurrencyPerModel < 1) throw new Error('Scheduler concurrency must be at least 1');
    if (this.config.retry.maxAttempts < 1) throw new Error('Scheduler maxAttempts must be at least 1');
  }

  schedule<T>(job: SchedulerJob<T>): Promise<T> {
    const id = `scheduler-${++this.sequence}`;
    if (job.signal?.aborted) {
      this.emit(id, job, 'cancelled', 0, undefined, 'ABORTED');
      return Promise.reject(abortError());
    }
    const key = `${job.provider}\0${job.model}`;
    const state = this.states.get(key) ?? { running: 0, queue: [] };
    this.states.set(key, state);
    this.emit(id, job, 'queued', 0);
    return new Promise<T>((resolve, reject) => {
      const item: Queued<T> = { id, enqueuedAt: Date.now(), job, resolve, reject };
      item.abort = () => {
        const index = state.queue.indexOf(item as Queued);
        if (index < 0) return;
        state.queue.splice(index, 1);
        this.emit(id, job, 'cancelled', 0, Date.now() - item.enqueuedAt, 'ABORTED');
        reject(abortError());
      };
      job.signal?.addEventListener('abort', item.abort, { once: true });
      state.queue.push(item as Queued);
      this.drain(key, state);
    });
  }

  getDiagnostics(): readonly SchedulerDiagnosticEvent[] { return [...this.events]; }
  subscribe(listener: (event: SchedulerDiagnosticEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private drain(key: string, state: KeyState): void {
    while (state.running < this.config.defaultConcurrencyPerModel && state.queue.length) {
      const item = state.queue.shift()!;
      item.job.signal?.removeEventListener('abort', item.abort!);
      if (item.job.signal?.aborted) { item.reject(abortError()); continue; }
      state.running++;
      void this.run(item).then(item.resolve, item.reject).finally(() => {
        state.running--;
        this.drain(key, state);
        if (!state.running && !state.queue.length) this.states.delete(key);
      });
    }
  }

  private async run(item: Queued): Promise<unknown> {
    for (let attempt = 1; attempt <= this.config.retry.maxAttempts; attempt++) {
      let outputStarted = false;
      this.emit(item.id, item.job, 'started', attempt, Date.now() - item.enqueuedAt);
      try {
        const result = await item.job.execute({ attempt, markOutputStarted: () => { outputStarted = true; } });
        this.emit(item.id, item.job, 'completed', attempt);
        return result;
      } catch (error) {
        const cancelled = item.job.signal?.aborted || isAbortError(error);
        if (cancelled) { this.emit(item.id, item.job, 'cancelled', attempt, undefined, 'ABORTED'); throw error; }
        if (!outputStarted && attempt < this.config.retry.maxAttempts && isTransientSchedulerError(error)) {
          this.emit(item.id, item.job, 'retrying', attempt, undefined, schedulerErrorCode(error));
          try {
            await wait(retryDelayMs(attempt, this.config.retry.baseDelayMs, this.config.retry.maxDelayMs, this.config.retry.jitterRatio, this.config.random ?? Math.random), item.job.signal);
          } catch (waitError) {
            this.emit(item.id, item.job, 'cancelled', attempt, undefined, 'ABORTED');
            throw waitError;
          }
          continue;
        }
        this.emit(item.id, item.job, 'failed', attempt, undefined, schedulerErrorCode(error));
        throw error;
      }
    }
  }

  private emit(id: string, job: SchedulerJob<unknown>, state: SchedulerDiagnosticEvent['state'], attempt: number, queueWaitMs?: number, errorCode?: string): void {
    const event = { id, timestamp: Date.now(), kind: job.kind, provider: job.provider, model: job.model, state, attempt, queueWaitMs, errorCode };
    this.events.push(event);
    if (this.events.length > (this.config.diagnosticsLimit ?? 100)) this.events.shift();
    this.listeners.forEach(listener => listener(event));
  }
}
