import type { RiskDecision } from '../../types';

export const BROWSER_RISK_RULES: Readonly<Record<string, RiskDecision>> = Object.freeze({
  'browser.navigate': 'ALLOW', 'browser.read': 'ALLOW', 'browser.input': 'NEEDS_USER',
  'browser.interact': 'NEEDS_USER', 'browser.submit': 'NEEDS_USER',
});
export type BrowserPocCommand =
  | { operation: 'navigate'; pageId: string }
  | { operation: 'read'; targetId?: string }
  | { operation: 'input'; targetId: string; value: string }
  | { operation: 'interact'; targetId: string; interaction: 'toggle' | 'select' | 'click'; value?: string }
  | { operation: 'submit'; targetId: string };
export type BrowserOperation = BrowserPocCommand['operation'];
export type BrowserCapability = 'read' | 'input' | 'toggle' | 'select' | 'click' | 'submit' | 'navigate';
export interface BrowserTarget {
  targetId: string; role: 'form' | 'textbox' | 'checkbox' | 'combobox' | 'button' | 'status';
  label: string; capabilities: BrowserCapability[]; disabled: boolean;
  value?: string; checked?: boolean; options?: string[];
}
/** Trusted driver snapshot. Private control state is used only for preconditions, never as a public summary. */
export interface BrowserSurfaceSnapshot {
  surfaceId: string; pageId: string; pageIds: string[]; revision: number;
  targets: BrowserTarget[]; textBlocks: string[]; visibility: 'complete' | 'incomplete';
  submitted: boolean; submitCount: number; resultStatus: 'idle' | 'preview' | 'completed';
}
export interface BrowserObservation {
  schemaVersion: 1; source: 'untrusted-sandbox'; surfaceId: string; pageId: string;
  textBlocks: string[]; controls: Array<Omit<BrowserTarget, 'value'> & { valueRedacted: boolean }>;
  truncated: boolean; visibility: 'complete' | 'incomplete';
}
export interface BrowserPreparedPayloadV1 {
  schemaVersion: 1; surfaceId: string; operation: BrowserOperation; stateToken: string; command: BrowserPocCommand;
}
/** Driver must compare the complete snapshot synchronously immediately before its trusted transition. */
export interface BrowserDispatchGuard { expected: BrowserSurfaceSnapshot }
export interface BrowserDriverResult { snapshot: BrowserSurfaceSnapshot }
export interface BrowserPocDriver {
  inspect(): Promise<BrowserSurfaceSnapshot>;
  navigate(command: Extract<BrowserPocCommand, { operation: 'navigate' }>, signal?: AbortSignal, guard?: BrowserDispatchGuard): Promise<BrowserDriverResult>;
  read(command: Extract<BrowserPocCommand, { operation: 'read' }>, signal?: AbortSignal, guard?: BrowserDispatchGuard): Promise<BrowserDriverResult>;
  input(command: Extract<BrowserPocCommand, { operation: 'input' }>, signal?: AbortSignal, guard?: BrowserDispatchGuard): Promise<BrowserDriverResult>;
  interact(command: Extract<BrowserPocCommand, { operation: 'interact' }>, signal?: AbortSignal, guard?: BrowserDispatchGuard): Promise<BrowserDriverResult>;
  submit(command: Extract<BrowserPocCommand, { operation: 'submit' }>, signal?: AbortSignal, guard?: BrowserDispatchGuard): Promise<BrowserDriverResult>;
}
export const TRUST_REASONS = ['INSTRUCTION_ATTEMPT', 'AUTHORITY_SPOOFING', 'APPROVAL_SPOOFING', 'TOOL_REDIRECTION',
  'GOAL_REDIRECTION', 'DATA_EXFILTRATION_REQUEST', 'AMBIGUOUS_INSTRUCTION', 'INSUFFICIENT_VISIBILITY'] as const;
export type BrowserTrustReason = typeof TRUST_REASONS[number];
export interface BrowserContentTrustAssessment {
  decision: 'DATA_ONLY' | 'NEEDS_REVIEW'; reasons: BrowserTrustReason[]; safeSummary: string;
}
