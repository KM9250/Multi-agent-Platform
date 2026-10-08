import type { BrowserPreparedPayloadV1, BrowserSurfaceSnapshot } from './types';
/** Inputs have already been runtime validated; undefined optional fields are omitted. */
export function canonicalSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalSerialize).join(',')}]`;
  return `{${Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonicalSerialize(value[k])}`).join(',')}}`;
}
export async function sha256(value: unknown): Promise<string> {
  const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalSerialize(value)));
  return `sha256:${Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('')}`;
}
export const browserStateToken = (snapshot: BrowserSurfaceSnapshot): Promise<string> => sha256(snapshot);
export const browserFingerprint = (payload: BrowserPreparedPayloadV1): Promise<string> => sha256({
  schemaVersion: payload.schemaVersion, executorId: 'browser', surfaceId: payload.surfaceId,
  operation: payload.operation, actionClass: `browser.${payload.operation}`, command: payload.command, stateToken: payload.stateToken,
});
