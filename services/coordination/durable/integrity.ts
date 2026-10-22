import { createHash } from 'node:crypto';

export type DurableErrorCode = 'INVALID_CONFIGURATION' | 'DATABASE_ERROR' | 'DATABASE_BUSY'
  | 'SCHEMA_UNSUPPORTED' | 'INTEGRITY_ERROR' | 'INVALID_JSON' | 'INVALID_SEED'
  | 'INVALID_EVENT' | 'WORKFLOW_NOT_FOUND' | 'WORKFLOW_EXISTS' | 'EVENT_COLLISION'
  | 'SEQUENCE_CONFLICT' | 'INVALID_TRANSACTION' | 'EXECUTION_REVIEW_REQUIRED';

/** Only fixed codes cross this boundary; never attach raw SQLite/Kernel errors. */
export class DurableStoreError extends Error {
  constructor(public readonly code: DurableErrorCode) { super(code); this.name = 'DurableStoreError'; }
}
export function requireIntegrity(condition: unknown): asserts condition {
  if (!condition) throw new DurableStoreError('INTEGRITY_ERROR');
}
export function guarded<T>(code: DurableErrorCode, fn: () => T): T {
  try { return fn(); } catch (error) {
    if (error instanceof DurableStoreError) throw error;
    const errno = (error as { errcode?: number })?.errcode;
    if (typeof errno === 'number') throw new DurableStoreError([5, 6].includes(errno & 255) ? 'DATABASE_BUSY' : 'DATABASE_ERROR');
    throw new DurableStoreError(code);
  }
}

/** Stable JSON, without toJSON/coercion. Optional undefined object fields mean absent.
 * Undefined roots/array entries, sparse arrays, cycles and non-JSON objects fail closed.
 */
export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();
  function encode(entry: unknown): string {
    if (entry === null || typeof entry === 'string' || typeof entry === 'boolean') return JSON.stringify(entry);
    if (typeof entry === 'number' && Number.isFinite(entry)) return JSON.stringify(entry);
    if (typeof entry !== 'object' || ancestors.has(entry)) throw new DurableStoreError('INVALID_JSON');
    const proto = Object.getPrototypeOf(entry);
    if (!Array.isArray(entry) && proto !== Object.prototype && proto !== null) throw new DurableStoreError('INVALID_JSON');
    if (Object.getOwnPropertySymbols(entry).length) throw new DurableStoreError('INVALID_JSON');
    ancestors.add(entry);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(entry);
      if (Object.values(descriptors).some(d => !('value' in d))) throw new DurableStoreError('INVALID_JSON');
      if (Array.isArray(entry)) {
        if (Object.keys(entry).length !== entry.length) throw new DurableStoreError('INVALID_JSON');
        return `[${Array.from({ length: entry.length }, (_, i) => encode(entry[i])).join(',')}]`;
      }
      return `{${Object.keys(entry).sort().filter(key => descriptors[key].value !== undefined)
        .map(key => `${JSON.stringify(key)}:${encode(descriptors[key].value)}`).join(',')}}`;
    } finally { ancestors.delete(entry); }
  }
  return guarded('INVALID_JSON', () => encode(value));
}
export const digest = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex');
export const parseJson = <T>(value: unknown): T => guarded('INTEGRITY_ERROR', () => {
  requireIntegrity(typeof value === 'string');
  const parsed = JSON.parse(value);
  canonicalJson(parsed);
  return parsed as T;
});
export const jsonCopy = <T>(value: T): T => JSON.parse(canonicalJson(value));
