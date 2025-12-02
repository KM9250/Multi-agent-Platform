
export enum ModelType {
  GEMINI_FLASH = 'gemini-2.5-flash',
  GEMINI_PRO = 'gemini-3-pro-preview',
  GEMINI_FLASH_THINKING = 'gemini-2.5-flash-thinking' // Conceptual mapping
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
  type: RoomTag;
  agents: Agent[];
  messages: Message[];
  updatedAt: number;
}
