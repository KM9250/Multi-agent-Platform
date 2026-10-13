import { canonicalSerialize } from './fingerprint';
import { normalizeBrowserCommand, validateBrowserTarget, BrowserValidationError } from './validation';
import type { BrowserDispatchGuard, BrowserDriverResult, BrowserPocCommand, BrowserPocDriver, BrowserSurfaceSnapshot, BrowserTarget } from './types';

/** Only this trusted pre-dispatch error establishes that no transition occurred. */
export class BrowserBeforeDispatchError extends Error {
  constructor(public readonly code: string) { super(code); }
}
export const SANDBOX_TARGETS: ReadonlyArray<BrowserTarget> = [
  { targetId: 'demo-form', role: 'form', label: 'Demo form', capabilities: ['read', 'submit'], disabled: false },
  { targetId: 'query-input', role: 'textbox', label: 'Search query', capabilities: ['read', 'input'], disabled: false },
  { targetId: 'confirm-checkbox', role: 'checkbox', label: 'Confirm', capabilities: ['read', 'toggle'], disabled: false },
  { targetId: 'category-select', role: 'combobox', label: 'Category', capabilities: ['read', 'select'], disabled: false, options: ['general', 'research'] },
  { targetId: 'preview-button', role: 'button', label: 'Preview', capabilities: ['read', 'click'], disabled: false },
  { targetId: 'submit-button', role: 'button', label: 'Submit', capabilities: ['read', 'submit'], disabled: false },
  { targetId: 'result-status', role: 'status', label: 'Result status', capabilities: ['read'], disabled: false },
];
export interface SandboxState {
  pageId: 'form' | 'result'; revision: number; query: string; category: string; confirmed: boolean;
  submitted: boolean; submitCount: number; resultStatus: 'idle' | 'preview' | 'completed'; content: string;
}
/** Authoritative state transitions shared by React and the in-memory test driver. No native clicks/forms/network. */
export class BrowserSandboxController {
  private state: SandboxState = { pageId: 'form', revision: 0, query: '', category: 'general', confirmed: false,
    submitted: false, submitCount: 0, resultStatus: 'idle', content: 'Browse the sample form and review its local result.' };
  private listeners = new Set<() => void>();
  getState = (): Readonly<SandboxState> => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<SandboxState>): void {
    this.state = { ...this.state, ...patch, revision: this.state.revision + 1 };
    this.listeners.forEach(listener => listener());
  }
  setContent(content: string): void { this.update({ content }); }
  snapshot(surfaceId = 'map-browser-poc'): BrowserSurfaceSnapshot {
    const s = this.state;
    const targets = structuredClone(SANDBOX_TARGETS).filter(t => s.pageId === 'result' ? t.targetId === 'result-status' : t.targetId !== 'result-status');
    for (const t of targets) {
      if (t.targetId === 'query-input') t.value = s.query;
      if (t.targetId === 'category-select') t.value = s.category;
      if (t.targetId === 'confirm-checkbox') t.checked = s.confirmed;
    }
    return { surfaceId, pageId: s.pageId, pageIds: ['form', 'result'], revision: s.revision, targets,
      textBlocks: s.pageId === 'form' ? [s.content] : [`Status: ${s.resultStatus}`, `Submit count: ${s.submitCount}`],
      visibility: 'complete', submitted: s.submitted, submitCount: s.submitCount, resultStatus: s.resultStatus };
  }
  transition(command: BrowserPocCommand): void {
    validateBrowserTarget(command, this.snapshot());
    switch (command.operation) {
      case 'read': return;
      case 'navigate': this.update({ pageId: command.pageId as 'form' | 'result' }); return;
      case 'input': this.update({ query: command.value }); return;
      case 'interact':
        if (command.interaction === 'toggle') this.update({ confirmed: !this.state.confirmed });
        if (command.interaction === 'select') this.update({ category: command.value! });
        if (command.interaction === 'click') this.update({ resultStatus: 'preview' });
        return;
      case 'submit': this.update({ submitted: true, submitCount: this.state.submitCount + 1, resultStatus: 'completed' });
    }
  }
}
export abstract class GuardedBrowserDriver implements BrowserPocDriver {
  protected abstract capture(): BrowserSurfaceSnapshot;
  protected abstract apply(command: BrowserPocCommand): void;
  async inspect(): Promise<BrowserSurfaceSnapshot> { return structuredClone(this.capture()); }
  private async dispatch(command: BrowserPocCommand, signal?: AbortSignal, guard?: BrowserDispatchGuard): Promise<BrowserDriverResult> {
    try {
      if (signal?.aborted) throw new BrowserBeforeDispatchError('BROWSER_ABORTED_BEFORE_DISPATCH');
      const { operation, ...args } = command;
      command = normalizeBrowserCommand(operation, args);
      const current = this.capture();
      if (!guard || canonicalSerialize(current) !== canonicalSerialize(guard.expected)) throw new BrowserBeforeDispatchError('BROWSER_STALE_STATE');
      validateBrowserTarget(command, current);
    } catch (error) {
      if (error instanceof BrowserBeforeDispatchError) throw error;
      throw new BrowserBeforeDispatchError(error instanceof BrowserValidationError ? error.code : 'BROWSER_INVALID_SURFACE');
    }
    // No await between preconditions and the transition. Anything thrown below has an unknown outcome.
    this.apply(command);
    return { snapshot: structuredClone(this.capture()) };
  }
  navigate(command: Extract<BrowserPocCommand, { operation: 'navigate' }>, signal?: AbortSignal, guard?: BrowserDispatchGuard) { return this.dispatch(command, signal, guard); }
  read(command: Extract<BrowserPocCommand, { operation: 'read' }>, signal?: AbortSignal, guard?: BrowserDispatchGuard) { return this.dispatch(command, signal, guard); }
  input(command: Extract<BrowserPocCommand, { operation: 'input' }>, signal?: AbortSignal, guard?: BrowserDispatchGuard) { return this.dispatch(command, signal, guard); }
  interact(command: Extract<BrowserPocCommand, { operation: 'interact' }>, signal?: AbortSignal, guard?: BrowserDispatchGuard) { return this.dispatch(command, signal, guard); }
  submit(command: Extract<BrowserPocCommand, { operation: 'submit' }>, signal?: AbortSignal, guard?: BrowserDispatchGuard) { return this.dispatch(command, signal, guard); }
}
export class InMemoryBrowserPocDriver extends GuardedBrowserDriver {
  constructor(public readonly controller = new BrowserSandboxController(), private readonly surfaceId = 'map-browser-poc') { super(); }
  protected capture(): BrowserSurfaceSnapshot { return this.controller.snapshot(this.surfaceId); }
  protected apply(command: BrowserPocCommand): void { this.controller.transition(command); }
}
