import { GoogleGenAI } from "@google/genai";
import type { Content, Part } from "@google/genai";
import { ModelType } from "../types";
import type { Message, Agent, ResponseDecision } from "../types";
import { DECISION_SYSTEM_INSTRUCTION } from "../constants";
import { getStrategy } from "./agentStrategies";
import { buildAdditionalContext } from "../utils/contextFiles";
import { normalizeDecisionHistory, normalizeGenerationHistory, createRegeneratePrompt } from "../utils/geminiHistory";
import { classifyGenerationResult, getFinishMetadata } from "../utils/generationResult";
import type { GenerationResult } from "../utils/generationResult";
import { parseDecisionText } from "../utils/decisionDiagnostics";

export const hasApiKey = (): boolean => !!process.env.API_KEY;

// Failed responses and empty placeholders must not reach the API:
// a message that maps to zero Parts makes generateContent reject the request.
const isSendableMessage = (m: Message): boolean =>
  !m.error && (!!m.content || !!m.attachments?.length);

// Helper to convert internal Message structure to Gemini Content Parts
const messageToParts = (message: Message): Part[] => {
  const parts: Part[] = [];

  // 1. Add Attachments
  if (message.attachments && message.attachments.length > 0) {
    message.attachments.forEach(att => {
      if (att.type === 'image') {
        // Remove data URL header (e.g., "data:image/png;base64,") for the API
        const base64Data = att.data.split(',')[1]; 
        parts.push({
          inlineData: {
            mimeType: att.mimeType,
            data: base64Data
          }
        });
      } else if (att.type === 'text') {
        // Format text files clearly
        parts.push({
          text: `\n\n--- File: ${att.name} ---\n${att.data}\n--- End of File ---\n\n`
        });
      }
    });
  }

  // 2. Add Main Text Content
  if (message.content) {
    parts.push({ text: message.content });
  }

  return parts;
};

// Applies the agent's memory window: keep only the most recent N messages,
// optionally pinning the first user message (the conversation's task anchor)
// so the original request survives truncation. Exported for testing.
export const applyHistoryWindow = (messages: Message[], agent: Agent): Message[] => {
  const limit = agent.historyWindow ?? 0;
  if (limit <= 0 || messages.length <= limit) return messages;

  const recent = messages.slice(-limit);
  if (agent.pinFirstMessage ?? true) {
    const firstUser = messages.find(m => m.role === 'user');
    if (firstUser && !recent.includes(firstUser)) {
      const rest = limit > 1 ? recent.slice(-(limit - 1)) : [];
      return [firstUser, ...rest];
    }
  }
  return recent;
};

// Resolves an agentId to a display name for speaker labels in shared history
const makeNameResolver = (agents?: Agent[]) => (id?: string): string =>
  agents?.find(a => a.id === id)?.name || 'Agent';

// Build the shared conversation from one agent's perspective: its own
// messages stay 'model' turns, while the user and every other agent become
// labeled 'user' turns so the model can follow who said what.
export const buildHistoryForAgent = (
  allMessages: Message[],
  agentId: string,
  nameOf: (id?: string) => string
): Content[] => {
  return allMessages.map(m => {
    if (m.role === 'model' && m.agentId === agentId) {
      return { role: 'model', parts: messageToParts(m) };
    }
    const speaker = m.role === 'user' ? 'User' : nameOf(m.agentId);
    const labeled: Message = { ...m, content: `[${speaker}]: ${m.content || ''}` };
    return { role: 'user', parts: messageToParts(labeled) };
  });
};

export const buildHistoryForDecision = (
  allMessages: Message[],
  nameOf: (id?: string) => string
): Content[] => {
  return allMessages.filter(isSendableMessage).map(m => {
    let content = m.content;
    if (m.attachments?.length) {
      const fileNames = m.attachments.map(a => `[${a.type} file: ${a.name}]`).join(', ');
      content += `\n${fileNames}`;
    }
    const speaker = m.role === 'user' ? 'User' : nameOf(m.agentId);
    return {
      role: m.role === 'user' ? 'user' : 'model',
      parts: [{ text: `[${speaker}] ${content}` }]
    };
  });
};

export const getCombinedSystemInstruction = (agent: Agent, roomSystemInstruction?: string): string => {
  const parts = [];

  parts.push(
    `You are "${agent.name}" in a multi-agent chat room. ` +
    `Messages from the user and from other agents appear prefixed with their speaker label like "[Name]:". ` +
    `Reply only as ${agent.name}: never write a "[Name]:" prefix yourself and never speak on behalf of the user or other agents.`
  );

  if (agent.model.startsWith('gpt') || agent.model.startsWith('o1')) {
      parts.push(`[SYSTEM NOTE: You are acting as ${agent.model}. Adopt the persona and capabilities associated with this model.]`);
  }

  if (roomSystemInstruction) {
     parts.push(`=== ROOM CONTEXT & SHARED RULES ===\n${roomSystemInstruction}\n=== END ROOM CONTEXT ===\n`);
  }

  if (agent.systemInstruction) {
    parts.push(agent.systemInstruction);
  }
  
  if (Array.isArray(agent.additionalContextFiles)) {
    const additionalContext = buildAdditionalContext(agent.additionalContextFiles);
    if (additionalContext) {
      parts.push(additionalContext);
    }
  } else if (agent.importedSystemInstruction) {
    parts.push(`\n\n--- ADDITIONAL CONTEXT 1: ${agent.importedSystemInstructionFileName || 'Imported File'} ---\n${agent.importedSystemInstruction}\n--- END CONTEXT: ${agent.importedSystemInstructionFileName || 'Imported File'} ---`);
  }

  const strategy = getStrategy(agent.framework);
  const baseInstruction = parts.join('\n');
  return strategy.injectSystemPrompt(baseInstruction);
};

const resolveModel = (selectedModel: string): string => {
  switch (selectedModel) {
    case ModelType.GEMINI_3_PRO:
    case ModelType.GEMINI_3_PRO_IMAGE:
    case ModelType.GEMINI_2_5_FLASH:
    case ModelType.GEMINI_2_5_FLASH_LITE:
    case ModelType.GEMINI_2_5_PRO:
      return selectedModel;
    case ModelType.GEMINI_2_5_FLASH_THINKING:
      // 'gemini-2.5-flash-thinking' is not a real API model; thinking is
      // enabled on the standard flash model via thinkingConfig instead.
      return ModelType.GEMINI_2_5_FLASH;
    case 'gemini-2.5-pro-preview-02-05':
      // Legacy ID that may persist in saved rooms from older versions
      return ModelType.GEMINI_2_5_PRO;
    case 'gemini-3.1-pro':
    case 'gemini-3-pro-preview':
      return ModelType.GEMINI_3_PRO;
    case 'gemini-3-pro-image-preview':
      // Preview retires 2026-06-25; remap to the GA model
      return ModelType.GEMINI_3_PRO_IMAGE;
    case ModelType.GPT_4_O:
      return ModelType.GEMINI_3_PRO;
    case ModelType.GPT_O1:
    case ModelType.GPT_O1_MINI:
      return ModelType.GEMINI_3_PRO;
    case ModelType.GPT_4_O_MINI:
      return ModelType.GEMINI_2_5_FLASH;
    default:
      return ModelType.GEMINI_2_5_FLASH;
  }
};

/**
 * Classifies an error into a human-readable code and detailed description.
 */
export const classifyError = (err: any): { code: string; detail: string; message: string } => {
  const msg = err.message || String(err);
  
  if (msg.includes("API Key is missing") || msg.includes("401")) {
    return { 
      code: 'AUTH_ERROR', 
      message: 'Authentication failed.', 
      detail: 'The API key is missing or invalid. Please check your configuration.' 
    };
  }
  
  if (msg.includes("404") || /model not found/i.test(msg) || /does not exist/i.test(msg) || /not available/i.test(msg) || /unsupported model/i.test(msg)) {
    return {
      code: 'MODEL_NOT_FOUND',
      message: 'Selected model is unavailable.',
      detail: 'The configured model ID may be invalid, deprecated, or unavailable for this API key.'
    };
  }

  if (msg.includes("429") || msg.includes("QuotaExceeded")) {
    return { 
      code: 'QUOTA_EXCEEDED', 
      message: 'Rate limit reached.', 
      detail: 'The API quota has been exhausted. Try again later or upgrade your plan.' 
    };
  }

  if (msg.includes("Safety") || msg.includes("block") || msg.includes("finishReason: SAFETY")) {
    return { 
      code: 'SAFETY_BLOCK', 
      message: 'Response blocked.', 
      detail: 'The request was flagged by safety filters. Consider rephrasing.' 
    };
  }

  if (msg.includes("503") || msg.includes("Overloaded") || msg.includes("Service Unavailable")) {
    return { 
      code: 'MODEL_OVERLOADED', 
      message: 'Model is overloaded.', 
      detail: 'Google\'s servers are currently under heavy load. Please retry in a moment.' 
    };
  }

  if (msg.includes("Failed to fetch") || msg.includes("NetworkError")) {
    return { 
      code: 'NETWORK_ERROR', 
      message: 'Connection failed.', 
      detail: 'Unable to reach the API. Please check your internet connection.' 
    };
  }

  return { 
    code: 'UNKNOWN_ERROR', 
    message: 'An unexpected error occurred.', 
    detail: msg 
  };
};


export const createDecisionError = (
  error: unknown,
  latencyMs: number,
  decisionModel: string
): ResponseDecision => {
  const classified = classifyError(error);
  return {
    outcome: 'ERROR',
    source: 'api_error',
    latencyMs,
    decisionModel,
    errorCode: classified.code,
    errorDetail: classified.detail
  };
};

export interface AgentCallOptions {
  agents?: Agent[];        // Room agents, used to label speakers in history
  signal?: AbortSignal;    // Aborts the underlying API request (Stop button)
  mode?: 'normal' | 'retry' | 'regenerate';
}

export const evaluateShouldRespond = async (
  agent: Agent,
  allMessages: Message[],
  roomSystemInstruction?: string,
  options?: AgentCallOptions
): Promise<ResponseDecision> => {
    const decisionModel = ModelType.GEMINI_2_5_FLASH;
    const startedAt = performance.now();
    const latency = () => Math.round(performance.now() - startedAt);

    if (!process.env.API_KEY) {
      return { outcome: 'ERROR', source: 'api_error', latencyMs: latency(), decisionModel, errorCode: 'AUTH_ERROR', errorDetail: 'API Key is missing' };
    }

    try {
        const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
        let systemPrompt = `あなたは「${agent.name}」という名前のエージェントです。\n役割: ${agent.description}\n\n${DECISION_SYSTEM_INSTRUCTION}`;
        if (roomSystemInstruction) {
             systemPrompt = `=== ROOM CONTEXT ===\n${roomSystemInstruction}\n=== END ROOM CONTEXT ===\n\n` + systemPrompt;
        }
        const visibleHistory = applyHistoryWindow(allMessages.filter(isSendableMessage), agent).slice(-10);
        const history = normalizeDecisionHistory(buildHistoryForDecision(visibleHistory, makeNameResolver(options?.agents)));
        const response = await ai.models.generateContent({
            model: decisionModel,
            contents: [
                ...history,
                { role: 'user', parts: [{ text: "このメッセージに対して返信すべきですか？ 'RESPOND' または 'IGNORE' で答えてください。" }] }
            ],
            config: {
                systemInstruction: systemPrompt,
                temperature: 0.1,
                maxOutputTokens: 10,
                thinkingConfig: { thinkingBudget: 0 },
                abortSignal: options?.signal
            }
        });

        return parseDecisionText(response.text, latency(), decisionModel);
    } catch (e) {
        return createDecisionError(e, latency(), decisionModel);
    }
}

export const streamAgentResponse = async (
  agent: Agent,
  allMessages: Message[],
  roomSystemInstruction: string | undefined,
  onChunk: (text: string) => void,
  onComplete: (result: GenerationResult) => void,
  onError: (error: { message: string, code: string, detail: string }) => void,
  options?: AgentCallOptions
) => {
  if (!process.env.API_KEY) {
    onError(classifyError(new Error("API Key is missing")));
    return;
  }

  const signal = options?.signal;

  try {
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
    const messagesToUse = applyHistoryWindow(allMessages.filter(isSendableMessage), agent);

    if (messagesToUse.length === 0) {
        throw new Error("No messages to respond to");
    }

    const baseContents = buildHistoryForAgent(messagesToUse, agent.id, makeNameResolver(options?.agents));
    const normalizedHistory = normalizeGenerationHistory(baseContents, agent.name);
    const contents = options?.mode === 'regenerate'
      ? [...normalizedHistory.contents, createRegeneratePrompt()]
      : normalizedHistory.contents;
    const combinedSystemInstruction = getCombinedSystemInstruction(agent, roomSystemInstruction);
    const actualModel = resolveModel(agent.model);

    const config: any = {
      systemInstruction: combinedSystemInstruction,
      abortSignal: signal,
    };

    if (agent.model === ModelType.GPT_O1 || agent.model === ModelType.GPT_O1_MINI || agent.model === ModelType.GEMINI_2_5_FLASH_THINKING) {
       const thinkingBudget = Math.max(agent.thinkingBudget || 0, 4096);
       // Gemini 2.5 and 3.0 series both support thinkingConfig
       if (actualModel.includes('gemini-2.5') || actualModel.includes('gemini-3')) {
          config.thinkingConfig = { thinkingBudget };
       }
    } else if (agent.thinkingBudget > 0) {
       // Gemini 2.5 and 3.0 series both support thinkingConfig
       if (actualModel.includes('gemini-2.5') || actualModel.includes('gemini-3')) {
          config.thinkingConfig = { thinkingBudget: agent.thinkingBudget };
       }
    }

    const startedAt = performance.now();
    let accumulatedText = '';
    let finishMetadata: ReturnType<typeof getFinishMetadata> = {};

    const resultStream = await ai.models.generateContentStream({
      model: actualModel,
      contents,
      config
    });

    for await (const chunk of resultStream) {
      if (signal?.aborted) break;
      // Accessing .text property from stream chunk
      finishMetadata = { ...finishMetadata, ...getFinishMetadata(chunk) };
      if (chunk.text) {
        accumulatedText += chunk.text;
        onChunk(chunk.text);
      }
    }

    onComplete(classifyGenerationResult(accumulatedText, finishMetadata, !!signal?.aborted, Math.round(performance.now() - startedAt)));
  } catch (err: any) {
    // A user-initiated stop is not an error; finalize the message as-is
    if (signal?.aborted) {
      onComplete({ outcome: 'ABORTED', text: '', latencyMs: 0 });
      return;
    }
    onError(classifyError(err));
  }
};
