import type { BrowserObservation, BrowserSurfaceSnapshot } from './types';
export const BROWSER_OBSERVATION_LIMITS = Object.freeze({ maxTextBlocks: 50, maxControls: 100, maxTextCharsPerBlock: 1000, maxTotalTextChars: 20000, maxOptionsPerControl: 50 });
export function browserObservation(s: BrowserSurfaceSnapshot, targetId?: string): BrowserObservation {
  const limits = BROWSER_OBSERVATION_LIMITS;
  let truncated = false, remaining = limits.maxTotalTextChars;
  const clip = (text: string): string => {
    const result = text.slice(0, Math.min(limits.maxTextCharsPerBlock, remaining));
    if (result.length !== text.length) truncated = true;
    remaining -= result.length; return result;
  };
  const textBlocks = s.textBlocks.slice(0, limits.maxTextBlocks).map(clip);
  if (s.textBlocks.length > limits.maxTextBlocks || s.targets.length > limits.maxControls) truncated = true;
  const controls = s.targets.slice(0, limits.maxControls).map(t => {
    if ((t.options?.length ?? 0) > limits.maxOptionsPerControl) truncated = true;
    return { targetId: t.targetId, role: t.role, capabilities: [...t.capabilities], disabled: t.disabled,
      label: clip(t.label), ...(t.checked === undefined ? {} : { checked: t.checked }),
      ...(t.options ? { options: t.options.slice(0, limits.maxOptionsPerControl).map(clip) } : {}), valueRedacted: t.value !== undefined };
  });
  // Trust assessment always receives the whole visible page; target filtering is only for released evidence.
  return { schemaVersion: 1, source: 'untrusted-sandbox', surfaceId: s.surfaceId, pageId: s.pageId,
    textBlocks, controls: targetId ? controls.filter(t => t.targetId === targetId) : controls,
    truncated, visibility: s.visibility };
}
