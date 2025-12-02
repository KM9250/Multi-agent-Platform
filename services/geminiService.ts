import { GoogleGenAI, Content } from "@google/genai";
import { Message, Agent, ModelType } from "../types";
import { DECISION_SYSTEM_INSTRUCTION } from "../constants";

// Helper to sanitize/prepare history for the specific agent
// We only want the USER messages and THIS AGENT'S messages.
// We do not want Agent A to see Agent B's replies in the context usually,
// unless it's a "debate" mode. For this UI, we treat them as parallel conversations.
const buildHistoryForAgent = (allMessages: Message[], agentId: string): Content[] => {
  return allMessages
    .filter(m => m.role === 'user' || (m.role === 'model' && m.agentId === agentId))
    .map(m => ({
      role: m.role,
      parts: [{ text: m.content }]
    }));
};

const buildHistoryForDecision = (allMessages: Message[]): Content[] => {
  // For decision making, the agent needs to see the WHOLE conversation context
  // to know if others have replied or if it's relevant.
  return allMessages.map(m => ({
      role: m.role === 'user' ? 'user' : 'model',
      parts: [{ text: `[${m.role === 'user' ? 'User' : 'Agent'}] ${m.content}` }]
  }));
};

export const evaluateShouldRespond = async (
  agent: Agent,
  allMessages: Message[],
): Promise<boolean> => {
    if (!process.env.API_KEY) return false;

    try {
        const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
        
        // Use Flash for fast, cheap decision making
        // We append specific context about "Who am I" to the system instruction
        const systemPrompt = `あなたは「${agent.name}」という名前のエージェントです。\n役割: ${agent.description}\n\n${DECISION_SYSTEM_INSTRUCTION}`;
        
        const lastMessage = allMessages[allMessages.length - 1];
        // Taking last 10 messages for context is usually enough for decision
        const history = buildHistoryForDecision(allMessages.slice(-10));

        const response = await ai.models.generateContent({
            model: ModelType.GEMINI_FLASH, // Always use Flash for this
            contents: [
                ...history,
                { role: 'user', parts: [{ text: "このメッセージに対して返信すべきですか？ 'RESPOND' または 'IGNORE' で答えてください。" }] }
            ],
            config: {
                systemInstruction: systemPrompt,
                temperature: 0.1, // Deterministic
                maxOutputTokens: 10,
            }
        });

        const decision = response.text?.trim().toUpperCase();
        console.log(`Agent ${agent.name} decision: ${decision}`);
        return decision?.includes("RESPOND") ?? false;

    } catch (e) {
        console.error("Decision API Error:", e);
        // Fallback: If decision fails, lean towards NOT responding to avoid chaos, 
        // unless it's a very short conversation.
        return allMessages.length < 3; 
    }
}

export const streamAgentResponse = async (
  agent: Agent,
  allMessages: Message[], // Full history including user prompt
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
    
    // Extract the latest user message (prompt)
    const lastMessage = allMessages[allMessages.length - 1];
    
    // In a multi-turn/parallel chat, the last message might not be 'user' if an agent is responding to another agent.
    // But typically in this App flow, we trigger after user input or agent input.
    // For safety, we just pass the content.

    // Build history excluding the very last message (which is the new prompt)
    const history = buildHistoryForAgent(allMessages.slice(0, -1), agent.id);

    const config: any = {
      systemInstruction: agent.systemInstruction,
    };

    // Apply thinking budget if set and > 0 (Only for 2.5 series usually, but generic implementation here)
    if (agent.thinkingBudget > 0) {
      config.thinkingConfig = { thinkingBudget: agent.thinkingBudget };
    }

    const chat = ai.chats.create({
      model: agent.model,
      config: config,
      history: history
    });

    const resultStream = await chat.sendMessageStream({
      message: lastMessage.content
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