import type { BrowserPocCommand, BrowserSurfaceSnapshot, BrowserTarget } from './types';

export class BrowserValidationError extends Error {
  constructor(public readonly code = 'BROWSER_INVALID_COMMAND') { super(code); }
}
export const reject = (code?: string): never => { throw new BrowserValidationError(code); };
export const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) reject();
  return value as Record<string, unknown>;
};
export const stableId = (v: unknown): string => typeof v === 'string' && /^[a-z][a-z0-9-]{0,79}$/.test(v) ? v : reject();
export function normalizeBrowserCommand(operation: unknown, args: unknown): BrowserPocCommand {
  const v = record(args);
  // Classification/fingerprint hints are deliberately ignored; executable selectors and URLs are rejected.
  const common = ['actionClass', 'fingerprint', 'expectedStateToken'];
  const keys: Record<string, string[]> = { navigate: ['pageId'], read: ['targetId'], input: ['targetId', 'value'], interact: ['targetId', 'interaction', 'value'], submit: ['targetId'] };
  if (typeof operation !== 'string' || !Object.hasOwn(keys, operation)) reject();
  if (Object.keys(v).some(key => !keys[operation as string].includes(key) && !common.includes(key))) reject();
  switch (operation) {
    case 'navigate': return { operation, pageId: stableId(v.pageId) };
    case 'read': return { operation, ...(v.targetId === undefined ? {} : { targetId: stableId(v.targetId) }) };
    case 'input':
      if (typeof v.value !== 'string' || v.value.length > 10000) reject();
      return { operation, targetId: stableId(v.targetId), value: v.value as string };
    case 'interact': {
      if (!['toggle', 'select', 'click'].includes(v.interaction as string)) reject();
      if (v.interaction === 'select' ? typeof v.value !== 'string' || v.value.length > 1000 : v.value !== undefined) reject();
      return { operation, targetId: stableId(v.targetId), interaction: v.interaction as 'toggle' | 'select' | 'click', ...(v.value === undefined ? {} : { value: v.value as string }) };
    }
    case 'submit': return { operation, targetId: stableId(v.targetId) };
    default: return reject();
  }
}
export function validateSurface(s: BrowserSurfaceSnapshot): void {
  stableId(s.surfaceId); stableId(s.pageId);
  if (!Array.isArray(s.pageIds) || !s.pageIds.includes(s.pageId) || new Set(s.pageIds).size !== s.pageIds.length) reject('BROWSER_INVALID_SURFACE');
  s.pageIds.forEach(stableId);
  if (!Number.isSafeInteger(s.revision) || s.revision < 0 || !Number.isSafeInteger(s.submitCount) || s.submitCount < 0
    || typeof s.submitted !== 'boolean' || !['idle', 'preview', 'completed'].includes(s.resultStatus)
    || !['complete', 'incomplete'].includes(s.visibility) || !Array.isArray(s.textBlocks) || s.textBlocks.some(t => typeof t !== 'string')
    || !Array.isArray(s.targets)) reject('BROWSER_INVALID_SURFACE');
  const seen = new Set<string>();
  for (const t of s.targets) {
    stableId(t.targetId);
    if (seen.has(t.targetId)) reject('BROWSER_DUPLICATE_TARGET');
    seen.add(t.targetId);
    if (!['form', 'textbox', 'checkbox', 'combobox', 'button', 'status'].includes(t.role) || typeof t.label !== 'string'
      || typeof t.disabled !== 'boolean' || !Array.isArray(t.capabilities)
      || t.capabilities.some(c => !['read', 'input', 'toggle', 'select', 'click', 'submit', 'navigate'].includes(c))
      || (t.value !== undefined && typeof t.value !== 'string') || (t.checked !== undefined && typeof t.checked !== 'boolean')
      || (t.options !== undefined && (!Array.isArray(t.options) || t.options.some(o => typeof o !== 'string')))) reject('BROWSER_INVALID_SURFACE');
  }
}
export function validateBrowserTarget(command: BrowserPocCommand, s: BrowserSurfaceSnapshot): BrowserTarget | undefined {
  validateSurface(s);
  if (command.operation === 'navigate') { if (!s.pageIds.includes(command.pageId)) reject('BROWSER_UNKNOWN_PAGE'); return; }
  if (command.operation === 'read' && command.targetId === undefined) return;
  const t = s.targets.find(t => t.targetId === command.targetId);
  if (!t) reject('BROWSER_UNKNOWN_TARGET');
  if (command.operation !== 'read' && t.disabled) reject('BROWSER_DISABLED_TARGET');
  const capability = command.operation === 'interact' ? command.interaction : command.operation;
  const roles = { input: ['textbox'], toggle: ['checkbox'], select: ['combobox'], click: ['button'], submit: ['form', 'button'] };
  if (!t.capabilities.includes(capability) || (capability !== 'read' && !roles[capability]?.includes(t.role))) reject('BROWSER_CAPABILITY_MISMATCH');
  if (command.operation === 'interact' && (t.capabilities.includes('submit') || t.capabilities.includes('navigate'))) reject('BROWSER_OPERATION_CONFUSION');
  if (command.operation === 'interact' && command.interaction === 'select' && !t.options?.includes(command.value!)) reject('BROWSER_INVALID_OPTION');
  return t;
}
