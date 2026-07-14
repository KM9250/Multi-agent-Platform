export type GenerationMode = 'normal' | 'retry' | 'regenerate';

export interface GenerationSessionIdentity {
  sessionId: string;
  turnId: string;
  roomId: string;
}

export interface GenerationSession extends GenerationSessionIdentity {
  controller: AbortController;
  targetMessageId?: string;
  mode: GenerationMode;
}

export const isSameGenerationSession = (
  current: GenerationSessionIdentity | null,
  expected: GenerationSessionIdentity
): boolean =>
  current?.sessionId === expected.sessionId &&
  current?.turnId === expected.turnId &&
  current?.roomId === expected.roomId;

export const shouldAcceptStreamChunk = (isCurrentSession: boolean, aborted: boolean): boolean =>
  isCurrentSession && !aborted;
