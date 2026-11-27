import type { ContextMode } from "../context-contracts.ts";
import type { AnswerContextDTO } from "../context-citations.ts";
/** Browser-safe DATA-1 wire contracts. No server dependencies or credentials. */
export const APP_CONTRACT = "MAP-DATA-1:SERVER_CONVERSATION:1" as const;
export const APP_SCHEMA = 7;
export const CONTEXT_CONTRACT = "MAP-MEM-3:CONTEXT:1" as const;
export const SEARCH_CONTRACT = "MAP-MEM-2:SEARCH:1" as const;
export const MEMORY_CONTRACT = "MAP-MEM-1:MEMORY_VAULT:1" as const;
export const APP_LIMITS = Object.freeze({
  messageChars: 32768,
  configChars: 65536,
  pageSize: 50,
  maxPageSize: 200,
  attachmentBytes: 8 * 1024 * 1024,
  attachmentsPerMessage: 8,
  personasPerRoom: 16,
  segmentsPerRevision: 16,
  maxDepth: 16,
  requestBytes: 12 * 1024 * 1024,
});
export interface Actor {
  actorId: string;
  workspaceId: string;
  sessionId?: string;
}
export type Channel =
  | "public_message"
  | "shared_summary"
  | "private_state"
  | "debug_thoughts"
  | "gm_log"
  | "memory_export";
export type Visibility =
  | "public"
  | "self_only"
  | "self_and_gm"
  | "gm_only"
  | "developer_only";
export interface SegmentInput {
  channel: Channel;
  visibility: Visibility;
  content: string;
}
export interface SegmentDTO extends SegmentInput {
  id: string;
  digest: string;
}
export interface AttachmentDTO {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  digest: string;
  url: string;
}
export interface MessageDTO {
  id: string;
  revision: number;
  revisionId: string;
  parentRevision?: number;
  role: "user" | "model";
  agentId?: string;
  content: string;
  timestamp: number;
  occurredAt: number;
  ingestedAt: number;
  modifiedAt: number;
  segments: SegmentDTO[];
  attachments: AttachmentDTO[];
  context?: AnswerContextDTO;
}
export interface PersonaDTO {
  id: string;
  revision: number;
  name: string;
  description: string;
  systemInstruction: string;
  importedSystemInstruction?: string;
  importedSystemInstructionFileName?: string;
  model: string;
  framework: "standard" | "cot" | "react";
  color: string;
  avatar: string;
  avatarType?: "emoji" | "image";
  avatarAttachmentId?: string;
  isEnabled: boolean;
  thinkingBudget: number;
  historyWindow?: number;
  pinFirstMessage?: boolean;
  contextMode?: ContextMode;
  groups?: string[];
  participationProfile?: string;
  subAgents?: any[];
  subAgentPolicy?: { mode: "off" | "fixed_serial" };
  additionalContextFiles?: any[];
  contextAttachmentIds?: string[];
}
export interface RoomDTO {
  id: string;
  workspaceId: string;
  title: string;
  description: string;
  type: "Sandbox" | "Recreation" | "Hard";
  systemInstruction?: string;
  revision: number;
  contextMode?: ContextMode;
  internalStateSettings: {
    enabled: boolean;
    showPrivateState: boolean;
    showDebugThoughts: boolean;
    showGmLog: boolean;
    showMemoryExport: boolean;
  };
  agents: PersonaDTO[];
  historicalPersonas?: Array<{
    id: string;
    legacyRoomId: string;
    legacyPersonaId: string;
  }>;
  updatedAt: number;
  legacyDecisions?: any[];
  legacyReactions?: any[];
}
export interface MessagePage {
  messages: MessageDTO[];
  cursor?: string;
}
export interface AuthorizationPort {
  revision?(actor: Actor, workspaceId?: string): number;
  assert(
    actor: Actor,
    operation: string,
    scope?: { roomId?: string; personaId?: string; provider?: string },
  ): void;
  canReadSegment(
    actor: Actor,
    segment: {
      workspaceId: string;
      roomId: string;
      ownerPersonaId?: string;
      channel: string;
      visibility: string;
    },
  ): boolean;
}
export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.name = "AppError";
    this.code = code;
    this.status = status;
  }
}
