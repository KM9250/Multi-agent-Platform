export enum ModelType {
  GEMINI_FLASH = 'gemini-2.5-flash',
  GEMINI_PRO = 'gemini-3-pro-preview',
  GEMINI_FLASH_THINKING = 'gemini-2.5-flash-thinking' // Conceptual mapping
}

export interface Agent {
  id: string;
  name: string;
  description: string;
  systemInstruction: string;
  model: string;
  color: string;
  avatar: string; // Emoji char or Base64 Image string
  avatarType?: 'emoji' | 'image'; // Distinguish between types
  isEnabled: boolean;
  thinkingBudget: number; // 0 to disable
}

export interface Message {
  id: string;
  role: 'user' | 'model';
  content: string;
  agentId?: string; // If model, which agent sent it
  timestamp: number;
  isStreaming?: boolean;
  error?: boolean;
}

export interface Room {
  id: string;
  title: string;
  agents: Agent[];
  messages: Message[];
  updatedAt: number;
}
