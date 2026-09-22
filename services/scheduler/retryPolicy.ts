const statusOf = (error: unknown): number | undefined => {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as { status?: unknown; statusCode?: unknown; code?: unknown };
  for (const value of [candidate.status, candidate.statusCode, candidate.code]) {
    const parsed = typeof value === 'number' ? value : Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  const match = String((error as { message?: unknown }).message ?? error).match(/\b(4\d\d|5\d\d)\b/);
  return match ? Number(match[1]) : undefined;
};

export const isAbortError = (error: unknown): boolean =>
  !!error && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError';

export const isTransientSchedulerError = (error: unknown): boolean => {
  if (isAbortError(error)) return false;
  const status = statusOf(error);
  if (status !== undefined) return status === 429 || [500, 502, 503, 504].includes(status);
  const message = String((error as { message?: unknown })?.message ?? error).toLowerCase();
  return /network|failed to fetch|fetch failed|timeout|timed out|econn(reset|refused)|socket hang up|temporar/.test(message);
};

export const schedulerErrorCode = (error: unknown): string | undefined => {
  if (isAbortError(error)) return 'ABORTED';
  const status = statusOf(error);
  if (status !== undefined) return String(status);
  const candidate = error as { code?: unknown };
  return typeof candidate?.code === 'string' ? candidate.code : undefined;
};

export const retryDelayMs = (attempt: number, base: number, max: number, jitter: number, random: () => number): number => {
  const capped = Math.min(max, base * (2 ** Math.max(0, attempt - 1)));
  return Math.max(0, Math.round(capped * (1 + (random() * 2 - 1) * jitter)));
};
