import { GoogleGenAI, Content, Part } from "@google/genai";
import { Message, Agent, ModelType } from "../types";
import { DECISION_SYSTEM_INSTRUCTION } from "../constants";

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

const getCombinedSystemInstruction = (agent: Agent): string => {
  const parts = [];
  if (agent.systemInstruction) {
    parts.push(agent.systemInstruction);
  }
  if (agent.importedSystemInstruction) {
    parts.push(`\n\n--- ADDITIONAL CONTEXT (${agent.importedSystemInstructionFileName || 'Imported File'}) ---\n${agent.importedSystemInstruction}\n--- END CONTEXT ---`);
  }
  return parts.join('\n');
};

export const evaluateShouldRespond = async (
  agent: Agent,
  allMessages: Message[],
): Promise<boolean> => {
    if (!process.env.API_KEY) return false;

    try {
        const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
        
        // Note: For decision making, we use the basic persona description + specific decision rules.
        // We do NOT inject the full combined system instruction (which might be huge) to save tokens/speed for this check,
        // unless the agent description is empty.
        const systemPrompt = `あなたは「${agent.name}」という名前のエージェントです。\n役割: ${agent.description}\n\n${DECISION_SYSTEM_INSTRUCTION}`;
        const history = buildHistoryForDecision(allMessages.slice(-10));

        const response = await ai.models.generateContent({
            model: ModelType.GEMINI_FLASH,
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
    const combinedSystemInstruction = getCombinedSystemInstruction(agent);

    const config: any = {
      systemInstruction: combinedSystemInstruction,
    };

    if (agent.thinkingBudget > 0) {
      config.thinkingConfig = { thinkingBudget: agent.thinkingBudget };
    }

    const chat = ai.chats.create({
      model: agent.model,
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
    console.error(`Error generating content for agent ${agent.name}:`, err);
    onError(err instanceof Error ? err : new Error(String(err)));
  }
};