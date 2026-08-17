import { ModelType } from '../types';

export const GOOGLE_SUBAGENT_MODELS = [ModelType.GEMINI_3_PRO, ModelType.GEMINI_3_FLASH, ModelType.GEMINI_2_5_PRO, ModelType.GEMINI_2_5_FLASH, ModelType.GEMINI_2_5_FLASH_LITE] as readonly string[];

export const getSubAgentProviderLabel = (provider: string): string =>
  provider === 'google' ? 'Google' : `${provider} (unsupported in SA-1)`;

export const getSubAgentModelLabel = (model: string): string =>
  GOOGLE_SUBAGENT_MODELS.includes(model) ? model : `${model} (unsupported for Google SubAgent)`;
