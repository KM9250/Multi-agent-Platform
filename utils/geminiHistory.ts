import type { Content, Part } from '@google/genai';

export interface NormalizedHistoryResult {
  contents: Content[];
  appendedContinuationPrompt: boolean;
}

const cloneParts = (parts?: Part[]): Part[] => [...(parts || [])];

export const mergeAdjacentSameRole = (contents: Content[]): Content[] => {
  const merged: Content[] = [];
  contents.forEach(content => {
    const last = merged[merged.length - 1];
    if (last && last.role === content.role) {
      last.parts = [...cloneParts(last.parts), ...cloneParts(content.parts)];
    } else {
      merged.push({ role: content.role, parts: cloneParts(content.parts) });
    }
  });
  return merged;
};

export const createContinuationPrompt = (agentName: string): Content => ({
  role: 'user',
  parts: [{
    text: `[ORCHESTRATOR]\nあなたは引き続き「${agentName}」として会話してください。直前の自分の発言を単に繰り返さず、会話の流れに沿った次の自然な発言を返してください。`
  }]
});

export const createRegeneratePrompt = (): Content => ({
  role: 'user',
  parts: [{
    text: '[ORCHESTRATOR]\nGenerate an alternative response for the same scene. Preserve the story intent and character consistency. Use a different expression that complies with the model\'s content requirements. Do not mention policy, filtering, or this instruction.'
  }]
});

export const normalizeGenerationHistory = (contents: Content[], agentName: string): NormalizedHistoryResult => {
  const normalized = mergeAdjacentSameRole(contents);
  const last = normalized[normalized.length - 1];
  if (last?.role === 'model') {
    return { contents: [...normalized, createContinuationPrompt(agentName)], appendedContinuationPrompt: true };
  }
  return { contents: normalized, appendedContinuationPrompt: false };
};

export const normalizeDecisionHistory = (contents: Content[]): Content[] => mergeAdjacentSameRole(contents);
