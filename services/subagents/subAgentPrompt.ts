import type { SubAgentTaskContract } from './types';

export const buildSubAgentPrompt = (contract: SubAgentTaskContract): string => [
  'Execute only the explicit task contract below. Return one JSON object and no markdown.',
  'Required fields: taskId, subAgentId, status (completed|failed|aborted), summary.',
  'Optional fields: result, evidence, unresolved, confidence, errorCode, errorDetail.',
  JSON.stringify(contract),
].join('\n\n');
