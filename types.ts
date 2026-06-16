
export enum ModelType {
  // --- Gemini 3 Series ---
  GEMINI_3_PRO = 'gemini-3.1-pro-preview', // Preview model ID per Gemini API
  GEMINI_3_PRO_IMAGE = 'gemini-3-pro-image', // GA since 2026-05-28 (preview retires 2026-06-25)

  // --- Gemini 2.5 Series ---
  GEMINI_2_5_PRO = 'gemini-2.5-pro', // High reasoning 2.5
  GEMINI_2_5_FLASH = 'gemini-2.5-flash', // Standard fast
  GEMINI_2_5_FLASH_LITE = 'gemini-flash-lite-latest', // Ultra fast/cheap
  // UI-only sentinel: resolved to gemini-2.5-flash with thinking forced on
  GEMINI_2_5_FLASH_THINKING = 'gemini-2.5-flash-thinking',

  // --- OpenAI (Simulated via Gemini) ---
  GPT_4_O = 'gpt-4o',
  GPT_4_O_MINI = 'gpt-4o-mini',
  GPT_O1 = 'o1-preview',
  GPT_O1_MINI = 'o1-mini'
}

export type AgentFramework = 'standard' | 'cot' | 'react';

export interface AgentContextFile {
  id: string;
  name: string;
  content: string;
  mimeType: string;
  charCount: number;
  sizeBytes: number;
  order: number;
  addedAt: number;
}

export type DecisionOutcome = 'RESPOND' | 'IGNORE' | 'ERROR';
export type DecisionSource = 'mentioned' | 'llm_decision' | 'turn_limit' | 'broadcast' | 'fallback' | 'api_error' | 'invalid_decision' | 'timeout' | 'empty_response';

export interface ResponseDecision {
  outcome: DecisionOutcome;
  source: DecisionSource;
  latencyMs: number;
  decisionModel?: string;
  rawDecision?: string;
  errorCode?: string;
  errorDetail?: string;
}

export interface AgentDecisionEvent extends ResponseDecision {
  id: string;
  turnId: string;
  timestamp: number;
  agentId: string;
  agentName: string;
}

export interface Agent {
  id: string;
  name: string;
  description: string;
  systemInstruction: string; // Manual input
  importedSystemInstruction?: string; // Content read from MD file
  importedSystemInstructionFileName?: string; // Filename for display
  additionalContextFiles?: AgentContextFile[];
  model: string;
  framework: AgentFramework; // New: Selected reasoning framework
  color: string;
  avatar: string; // Emoji char or Base64 Image string
  avatarType?: 'emoji' | 'image'; // Distinguish between types
  isEnabled: boolean;
  thinkingBudget: number; // 0 to disable
  historyWindow?: number; // Max recent messages sent to the API; 0/undefined = unlimited
  pinFirstMessage?: boolean; // Keep the first user message even when the window cuts it off
}

export interface Attachment {
  id: string;
  type: 'image' | 'text';
  mimeType: string;
  name: string;
  data: string; // Base64 string for images, plain text for text files
}

export interface GenerationContext {
  historyMessageIds: string[];
  attempt: number;
  modelId: string;
}

export interface Message {
  id: string;
  role: 'user' | 'model';
  content: string;
  agentId?: string; // If model, which agent sent it
  attachments?: Attachment[];
  timestamp: number;
  isStreaming?: boolean;
  error?: boolean;
  errorCode?: string; // e.g., 'QUOTA_EXCEEDED', 'SAFETY_FILTER'
  errorDetail?: string; // Technical details or suggestions
  turnId?: string;
  generationContext?: GenerationContext;
}

export type RoomTag = 'Sandbox' | 'Recreation' | 'Hard';

export interface Room {
  id: string;
  title: string;
  description: string;
  systemInstruction?: string; // Shared instruction for all agents in the room
  type: RoomTag;
  agents: Agent[];
  messages: Message[];
  decisionEvents?: AgentDecisionEvent[];
  updatedAt: number;
}
