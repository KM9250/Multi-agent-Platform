import { canonicalJson, DurableStoreError } from './integrity';

export const EXECUTION_LIMITS = { action: 256 * 1024, result: 256 * 1024, evidence: 1024 * 1024, depth: 32 } as const;
/** Preflight before canonicalJson: bound traversal, strings, containers and output; never invoke accessors. */
export function executionJson(value: unknown, limit: number): string {
  let remaining = limit, nodes = limit;
  const ancestors = new Set<object>();
  const spend = (n: number) => { remaining -= n; if (remaining < 0) throw new DurableStoreError('INVALID_JSON'); };
  const visit = (v: unknown, depth: number): void => {
    if (--nodes < 0 || depth > EXECUTION_LIMITS.depth) throw new DurableStoreError('INVALID_JSON');
    if (typeof v === 'string') {
      if (v.length > remaining) throw new DurableStoreError('INVALID_JSON');
      spend(Buffer.byteLength(JSON.stringify(v))); return;
    }
    if (!v || typeof v !== 'object') { spend(8); return; }
    if (ancestors.has(v)) throw new DurableStoreError('INVALID_JSON');
    const proto = Object.getPrototypeOf(v);
    if ((!Array.isArray(v) && proto !== Object.prototype && proto !== null) || Object.getOwnPropertySymbols(v).length) throw new DurableStoreError('INVALID_JSON');
    if (Array.isArray(v) && v.length > remaining) throw new DurableStoreError('INVALID_JSON');
    const keys = Object.keys(v);
    if (keys.length > remaining || (Array.isArray(v) && keys.length !== v.length)) throw new DurableStoreError('INVALID_JSON');
    ancestors.add(v); spend(2);
    try {
      for (const key of keys) {
        const d = Object.getOwnPropertyDescriptor(v, key)!;
        if (!('value' in d)) throw new DurableStoreError('INVALID_JSON');
        if (!Array.isArray(v)) { visit(key, depth); spend(1); }
        visit(d.value, depth + 1); spend(1);
      }
    } finally { ancestors.delete(v); }
  };
  visit(value, 0);
  const json = canonicalJson(value);
  if (Buffer.byteLength(json) > limit) throw new DurableStoreError('INVALID_JSON');
  return json;
}
export function parseExecutionJson<T>(value: unknown, limit: number): T {
  if (typeof value !== 'string' || Buffer.byteLength(value) > limit) throw new DurableStoreError('INTEGRITY_ERROR');
  try { const parsed = JSON.parse(value); executionJson(parsed, limit); return parsed; }
  catch { throw new DurableStoreError('INTEGRITY_ERROR'); }
}
export interface DurableSecretReference { kind: 'secret-reference'; reference: string }
/** Credential-bearing fields are forbidden. Trusted adapters must supply opaque references instead. */
export function rejectEmbeddedCredentials(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  if (!Array.isArray(value) && (value as DurableSecretReference).kind === 'secret-reference') {
    const ref = value as DurableSecretReference;
    if (Object.keys(value).some(k => !['kind', 'reference'].includes(k)) || typeof ref.reference !== 'string'
      || !/^map\.secret\.v1:[A-Za-z0-9._/-]+$/.test(ref.reference)) throw new DurableStoreError('INVALID_JSON');
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (/^(credentials?|password|passwd|secret|token|accesstoken|refreshtoken|apikey|privatekey|authorization|cookie)$/i.test(key.replace(/[_-]/g, ''))) throw new DurableStoreError('INVALID_JSON');
    rejectEmbeddedCredentials(item);
  }
}
