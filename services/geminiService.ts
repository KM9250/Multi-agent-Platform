
import { GoogleGenAI, Content, Part } from "@google/genai";
import { Message, Agent, ModelType } from "../types";
import { DECISION_SYSTEM_INSTRUCTION } from "../constants";
import { getStrategy } from "./agentStrategies";

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

// Helper to sanitize/prepare history for the specific agent
const buildHistoryForAgent = (allMessages: Message[], agentId: string): Content[] => {
  return allMessages
    .filter(m => m.role === 'user' || (m.role === 'model' && m.agentId === agentId))
    .map(m => ({
      role: m.role,
      parts: messageToParts(m)
    }));
};

const buildHistoryForDecision = (allMessages: Message[]): Content[] => {
  // For decision making, strictly use text to save tokens, ignoring images for now
  // unless strictly necessary.
  return allMessages.map(m => {
    let content = m.content;
    // Append attachment names to context so the agent knows a file exists
    if (m.attachments?.length) {
      const fileNames = m.attachments.map(a => `[${a.type} file: ${a.name}]`).join(', ');
      content += `\n${fileNames}`;
    }
    return {
      role: m.role === 'user' ? 'user' : 'model',
      parts: [{ text: `[${m.role === 'user' ? 'User' : 'Agent'}] ${content}` }]
    };
  });
};

const getCombinedSystemInstruction = (agent: Agent, roomSystemInstruction?: string): string => {
  const parts = [];
  
  // Special injection for mapped models to maintain illusion or explain behavior
  if (agent.model.startsWith('gpt') || agent.model.startsWith('o1')) {
      parts.push(`[SYSTEM NOTE: You are acting as ${agent.model}. Adopt the persona and capabilities associated with this model.]`);
  }

  if (roomSystemInstruction) {
     parts.push(`=== ROOM CONTEXT & SHARED RULES ===\n${roomSystemInstruction}\n=== END ROOM CONTEXT ===\n`);
  }

  if (agent.systemInstruction) {
    parts.push(agent.systemInstruction);
  }
  
  if (agent.importedSystemInstruction) {
    parts.push(`\n\n--- ADDITIONAL CONTEXT (${agent.importedSystemInstructionFileName || 'Imported File'}) ---\n${agent.importedSystemInstruction}\n--- END CONTEXT ---`);
  }

  // --- FRAMEWORK INJECTION ---
  const strategy = getStrategy(agent.framework);
  const baseInstruction = parts.join('\n');
  return strategy.injectSystemPrompt(baseInstruction);
};

/**
 * Maps the user-selected model to an available Gemini API model.
 * Since this app only has a Google GenAI key, we simulate GPT models using Gemini.
 */
const resolveModel = (selectedModel: string): string => {
  switch (selectedModel) {
    // --- Gemini Series (Direct mapping) ---
    case ModelType.GEMINI_3_PRO:
    case ModelType.GEMINI_3_PRO_IMAGE:
    case ModelType.GEMINI_2_5_FLASH:
    case ModelType.GEMINI_2_5_FLASH_LITE:
    case ModelType.GEMINI_2_5_FLASH_THINKING:
    case ModelType.GEMINI_2_5_PRO:
      return selectedModel;
      
    // --- OpenAI Mapping (Simulations) ---
    case ModelType.GPT_4_O:
      return ModelType.GEMINI_3_PRO; // High intelligence equivalent
    case ModelType.GPT_O1:
    case ModelType.GPT_O1_MINI:
      return ModelType.GEMINI_3_PRO; // Use Pro for reasoning tasks
    case ModelType.GPT_4_O_MINI:
      return ModelType.GEMINI_2_5_FLASH; // High speed/efficiency equivalent
      
    // --- Fallback ---
    default:
      return ModelType.GEMINI_2_5_FLASH;
  }
};

export const evaluateShouldRespond = async (
  agent: Agent,
  allMessages: Message[],
  roomSystemInstruction?: string
): Promise<boolean> => {
    if (!process.env.API_KEY) return false;

    try {
        const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
        
        let systemPrompt = `あなたは「${agent.name}」という名前のエージェントです。\n役割: ${agent.description}\n\n${DECISION_SYSTEM_INSTRUCTION}`;
        
        if (roomSystemInstruction) {
             systemPrompt = `=== ROOM CONTEXT ===\n${roomSystemInstruction}\n=== END ROOM CONTEXT ===\n\n` + systemPrompt;
        }

        const history = buildHistoryForDecision(allMessages.slice(-10));

        // Use Flash for all decisions to keep it fast/cheap, regardless of agent model
        const response = await ai.models.generateContent({
            model: ModelType.GEMINI_2_5_FLASH,
            contents: [
                ...history,
                { role: 'user', parts: [{ text: "このメッセージに対して返信すべきですか？ 'RESPOND' または 'IGNORE' で答えてください。" }] }
            ],
            config: {
                systemInstruction: systemPrompt,
                temperature: 0.1,
                maxOutputTokens: 10,
            }
        });

        const decision = response.text?.trim().toUpperCase();
        console.log(`Agent ${agent.name} decision: ${decision}`);
        return decision?.includes("RESPOND") ?? false;

    } catch (e) {
        console.error("Decision API Error:", e);
        return allMessages.length < 3; 
    }
}

export const streamAgentResponse = async (
  agent: Agent,
  allMessages: Message[], 
  roomSystemInstruction: string | undefined,
  onChunk: (text: string) => void,
  onComplete: () => void,
  onError: (error: Error) => void
) => {
  if (!process.env.API_KEY) {
    onError(new Error("API Key is missing"));
    return;
  }

  try {
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
    
    // The last message is the trigger (User prompt or Agent reply)
    // We separate the history from the "latest turn" conceptually, 
    // but the SDK handles the last message in `sendMessageStream` argument usually if it's chat.
    // However, since we construct history manually based on filter, we treat the LAST message
    // as the `message` parameter of `sendMessageStream`, and the rest as `history`.
    
    const messagesToUse = allMessages.slice();
    const lastMessage = messagesToUse.pop(); // Remove last to use as prompt

    if (!lastMessage) {
        throw new Error("No messages to respond to");
    }

    const history = buildHistoryForAgent(messagesToUse, agent.id);
    const combinedSystemInstruction = getCombinedSystemInstruction(agent, roomSystemInstruction);
    const actualModel = resolveModel(agent.model);

    const config: any = {
      systemInstruction: combinedSystemInstruction,
    };

    // If simulating 'o1' (Reasoning) using Gemini, force a high thinking budget if supported
    // Otherwise use the user's setting.
    if (agent.model === ModelType.GPT_O1 || agent.model === ModelType.GPT_O1_MINI) {
       // Force thinking for 'o1' simulation if not already set high
       const thinkingBudget = Math.max(agent.thinkingBudget || 0, 4096);
       // Only apply thinking if model supports it (Gemini 2.5 series mostly, but assuming Pro might in future or we map to 2.5 Pro)
       // For now, if mapped to 3.0 Pro, thinking might not be available via 'thinkingConfig' param same way, 
       // but strictly following valid configs:
       if (actualModel.includes('gemini-2.5')) {
          config.thinkingConfig = { thinkingBudget };
       }
    } else if (agent.thinkingBudget > 0) {
       // Only apply thinking config if the resolved model supports it
       if (actualModel.includes('gemini-2.5')) {
          config.thinkingConfig = { thinkingBudget: agent.thinkingBudget };
       }
    }

    const chat = ai.chats.create({
      model: actualModel,
      config: config,
      history: history
    });

    // Convert the last message (prompt) to parts
    const promptParts = messageToParts(lastMessage);

    // sendMessageStream takes (string | Part[]), so we pass the parts directly
    const resultStream = await chat.sendMessageStream({
      message: promptParts 
    });

    for await (const chunk of resultStream) {
      if (chunk.text) {
        onChunk(chunk.text);
      }
    }

    onComplete();
  } catch (err: any) {
    console.error(`Error generating content for agent ${agent.name} (${agent.model} -> ${resolveModel(agent.model)}):`, err);
    onError(err instanceof Error ? err : new Error(String(err)));
  }
};
