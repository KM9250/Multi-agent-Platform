export interface GenerationSessionIdentity {
  turnId: string;
  roomId: string;
}

export interface GenerationSession extends GenerationSessionIdentity {
  controller: AbortController;
}

export const isSameGenerationSession = (
  current: GenerationSessionIdentity | null,
  expected: GenerationSessionIdentity
): boolean => current?.turnId === expected.turnId && current?.roomId === expected.roomId;

export const shouldAcceptStreamChunk = (isCurrentSession: boolean, aborted: boolean): boolean =>
  isCurrentSession && !aborted;
