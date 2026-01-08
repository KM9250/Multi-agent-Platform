
export enum ModelType {
  // --- Gemini 3.0 Series ---
  GEMINI_3_PRO = 'gemini-3-pro-preview',
  GEMINI_3_PRO_IMAGE = 'gemini-3-pro-image-preview', // Capable of high res generation

  // --- Gemini 2.5 Series ---
  GEMINI_2_5_PRO = 'gemini-2.5-pro-preview-02-05', // High reasoning 2.5
  GEMINI_2_5_FLASH = 'gemini-2.5-flash', // Standard fast
  GEMINI_2_5_FLASH_LITE = 'gemini-flash-lite-latest', // Ultra fast/cheap
  GEMINI_2_5_FLASH_THINKING = 'gemini-2.5-flash-thinking', // Thinking specialized

  // --- OpenAI (Simulated via Gemini) ---
  GPT_4_O = 'gpt-4o',
  GPT_4_O_MINI = 'gpt-4o-mini',
  GPT_O1 = 'o1-preview',
  GPT_O1_MINI = 'o1-mini'
}

export interface Agent {
  id: string;
  name: string;
  description: string;
  systemInstruction: string; // Manual input
  importedSystemInstruction?: string; // Content read from MD file
  importedSystemInstructionFileName?: string; // Filename for display
  model: string;
  color: string;
  avatar: string; // Emoji char or Base64 Image string
  avatarType?: 'emoji' | 'image'; // Distinguish between types
  isEnabled: boolean;
  thinkingBudget: number; // 0 to disable
}

export interface Attachment {
  id: string;
  type: 'image' | 'text';
  mimeType: string;
  name: string;
  data: string; // Base64 string for images, plain text for text files
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
  updatedAt: number;
}
