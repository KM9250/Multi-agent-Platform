import { BrowserSandboxController, GuardedBrowserDriver, SANDBOX_TARGETS } from './browserDriver';
import { reject, stableId } from './validation';
import type { BrowserPocCommand, BrowserSurfaceSnapshot, BrowserTarget } from './types';

export class DomSandboxBrowserDriver extends GuardedBrowserDriver {
  private readonly root: HTMLElement;
  private readonly surfaceId: string;
  private readonly controller: BrowserSandboxController;
  // Pin element identities at trusted mount: replacing a node with the same target ID is not authorization.
  private readonly elements = new Map<string, HTMLElement>();
  constructor(options: { root: HTMLElement; surfaceId: string; controller: BrowserSandboxController }) {
    super(); this.root = options.root; this.surfaceId = stableId(options.surfaceId); this.controller = options.controller;
    if (typeof window !== 'undefined' && this.root.ownerDocument !== window.document) reject('BROWSER_FOREIGN_DOCUMENT');
    for (const [id, element] of this.resolve()) this.elements.set(id, element);
  }
  private resolve(): Map<string, HTMLElement> {
    const found = new Map<string, HTMLElement>();
    for (const element of this.root.querySelectorAll<HTMLElement>('[data-browser-id]')) {
      const id = element.getAttribute('data-browser-id')!;
      if (!this.root.contains(element) || found.has(id)) reject('BROWSER_DUPLICATE_TARGET');
      if (!SANDBOX_TARGETS.some(t => t.targetId === id)) reject('BROWSER_UNKNOWN_TARGET');
      found.set(id, element);
    }
    if (found.size !== SANDBOX_TARGETS.length) reject('BROWSER_UNKNOWN_TARGET');
    return found;
  }
  private hidden(element: Element): boolean {
    const view = this.root.ownerDocument.defaultView;
    for (let e: Element | null = element; e && this.root.contains(e); e = e.parentElement) {
      if (e.hasAttribute('hidden') || e.getAttribute('aria-hidden') === 'true') return true;
      const style = view?.getComputedStyle(e);
      if (style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse') return true;
    }
    return false;
  }
  private targetState(t: BrowserTarget, element: HTMLElement): BrowserTarget {
    const tag = element.tagName.toLowerCase();
    const type = (element as HTMLInputElement).type;
    const valid = t.role === 'form' ? tag === 'div' && element.getAttribute('role') === 'form'
      : t.role === 'textbox' ? tag === 'input' && type === 'text' && element.getAttribute('autocomplete') === 'off'
      : t.role === 'checkbox' ? tag === 'input' && type === 'checkbox'
      : t.role === 'combobox' ? tag === 'select' && !(element as HTMLSelectElement).multiple
      : t.role === 'button' ? tag === 'button' && type === 'button'
      : tag === 'output';
    if (!valid || this.hidden(element) || element.hasAttribute('data-credential')) reject('BROWSER_CAPABILITY_MISMATCH');
    const explicitRole = element.getAttribute('role');
    if (explicitRole && explicitRole !== t.role) reject('BROWSER_CAPABILITY_MISMATCH');
    const actual = { ...t, label: element.getAttribute('aria-label') ?? t.label,
      disabled: element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true'
        || (t.role === 'textbox' && (element as HTMLInputElement).readOnly) };
    // Read only approved text/select/checkbox state; never read password/file/hidden fields.
    if (t.role === 'textbox' || t.role === 'combobox') {
      actual.value = (element as HTMLInputElement).value;
      if (actual.value !== t.value) reject('BROWSER_STATE_DESYNC');
    }
    if (t.role === 'checkbox') {
      actual.checked = (element as HTMLInputElement).checked;
      if (actual.checked !== t.checked) reject('BROWSER_STATE_DESYNC');
    }
    if (t.role === 'combobox') {
      const options = Array.from((element as HTMLSelectElement).options);
      if (options.length !== t.options!.length || options.some((o, i) => o.value !== t.options![i] || o.disabled)) reject('BROWSER_INVALID_OPTION');
      // Visible option labels are separately scanned as text; authority remains the controller allowlist.
    }
    return actual;
  }
  protected capture(): BrowserSurfaceSnapshot {
    if (!this.root.isConnected) reject('BROWSER_DETACHED_ROOT');
    const elements = this.resolve();
    for (const [id, element] of elements) if (element !== this.elements.get(id)) reject('BROWSER_TARGET_SWAP');
    const snapshot = this.controller.snapshot(this.surfaceId);
    snapshot.targets = snapshot.targets.map(t => this.targetState(t, elements.get(t.targetId)!));
    const blocks: string[] = [];
    let incomplete = false;
    const visit = (element: Element): void => {
      if (this.hidden(element) || ['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT'].includes(element.tagName)) return;
      if (element.tagName === 'INPUT' && ['password', 'hidden', 'file'].includes((element as HTMLInputElement).type)) return;
      if (element.hasAttribute('data-credential')) return;
      if (element.tagName === 'TEXTAREA') { incomplete = true; return; }
      if (['IFRAME', 'OBJECT', 'EMBED', 'CANVAS'].includes(element.tagName) || element.shadowRoot) incomplete = true;
      if (['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'FORM', 'A'].includes(element.tagName) && !this.elements.has(element.getAttribute('data-browser-id') ?? '')) {
        if (!['password', 'hidden', 'file'].includes((element as HTMLInputElement).type)) incomplete = true;
      }
      for (const name of ['aria-label', 'title', 'alt', 'placeholder']) {
        const value = element.getAttribute(name); if (value) blocks.push(value);
      }
      for (const node of element.childNodes) {
        if (node.nodeType === 3 && node.textContent?.trim()) blocks.push(node.textContent.trim());
        else if (node.nodeType === 1) visit(node as Element);
      }
    };
    visit(this.root);
    snapshot.textBlocks = blocks; snapshot.visibility = incomplete ? 'incomplete' : 'complete';
    return snapshot;
  }
  protected apply(command: BrowserPocCommand): void { this.controller.transition(command); }
}
