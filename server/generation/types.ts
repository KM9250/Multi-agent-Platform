import type { DatabaseSync } from "node:sqlite";
import type { ProviderAdapter } from "./provider";
export interface Actor {
  actorId: string;
  workspaceId: string;
  sessionId?: string;
}
export interface AppDatabasePort {
  db: DatabaseSync;
  transaction<T>(fn: () => T): T;
}
export interface PolicyPort {
  assert(
    actor: Actor,
    operation: string,
    target: {
      workspaceId?: string;
      roomId?: string;
      personaId?: string;
      provider?: string;
    },
  ): unknown;
  revision(actor: Actor, workspaceId?: string): number;
  canReadSegment(actor: Actor, segment: any): boolean;
}
export interface RepositoryPort {
  getRoom(actor: Actor, roomId: string): any;
  getPersona(actor: Actor, roomId: string, personaId: string): any;
  appendMessage(actor: Actor, roomId: string, input: any): any;
  appendRevision(
    actor: Actor,
    roomId: string,
    messageId: string,
    input: any,
  ): any;
  getMessage(
    actor: Actor,
    roomId: string,
    messageId: string,
    revision?: number,
  ): any;
}
export interface GenerationLimits {
  maxPersonas: number;
  maxSubAgents: number;
  maxCalls: number;
  maxConcurrentRuns: number;
  maxHistory: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxTotalTokens: number;
  maxCostMicros: number;
  acceptanceMs: number;
  dispatchMs: number;
  deadlineMs: number;
  collectionMs: number;
}
export const DEFAULT_GENERATION_LIMITS: Readonly<GenerationLimits> =
  Object.freeze({
    maxPersonas: 8,
    maxSubAgents: 3,
    maxCalls: 40,
    maxConcurrentRuns: 2,
    maxHistory: 100,
    maxInputTokens: 16384,
    maxOutputTokens: 2048,
    maxTotalTokens: 131072,
    maxCostMicros: 1_000_000,
    acceptanceMs: 30000,
    dispatchMs: 30000,
    deadlineMs: 120000,
    collectionMs: 180000,
  });
export interface Pricing {
  version: string;
  inputMicrosPerMillion: number;
  outputMicrosPerMillion: number;
}
export interface CoordinatorOptions {
  provider: ProviderAdapter;
  defaultModel: string;
  attachmentStore?: {
    read(
      actor: Actor,
      roomId: string,
      id: string,
    ): Promise<{ metadata: any; data: Buffer }>;
    readForContext(
      actor: Actor,
      roomId: string,
      id: string,
      personaId: string,
    ): Promise<{ metadata: any; data: Buffer }>;
  };
  limits?: Partial<GenerationLimits>;
  pricing?: Pricing;
  hooks?: {
    beforeAcceptCommit?: () => void;
    afterAcceptCommit?: () => void;
    beforeIntentCommit?: () => void;
    afterIntentCommit?: () => void;
    afterProvider?: () => void;
    afterProviderResponse?: () => void;
    beforeResultCommit?: () => void;
    afterResultCommit?: () => void;
    afterContext?: () => void;
  };
  now?: () => number;
  monotonic?: () => number;
}
export interface TurnRequest {
  requestId: string;
  expectedRoomRevision: number;
  content: string;
  attachmentIds?: string[];
  recipient?: {
    type: "auto" | "agent" | "group" | "all";
    agentIds?: string[];
    groupId?: string;
  };
}
export class GenerationError extends Error {
  readonly status: number;
  constructor(
    readonly code: string,
    status = 400,
  ) {
    super(code);
    this.status = status;
  }
}
export function stable(value: any): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  return (
    "{" +
    Object.keys(value)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + stable(value[k]))
      .join(",") +
    "}"
  );
}
export function exact(value: any, keys: string[]): void {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).some((k) => !keys.includes(k)) ||
    Object.values(Object.getOwnPropertyDescriptors(value)).some(
      (d) => d.get || d.set,
    )
  )
    throw new GenerationError("INVALID_INPUT");
}

/** Reject executable descriptors before accessing any untrusted object or array member. */
export function safeInput(
  value: unknown,
  depth = 0,
  seen = new Set<object>(),
  budget = { nodes: 0 },
): void {
  if (++budget.nodes > 10000 || depth > 16)
    throw new GenerationError("INVALID_INPUT");
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (value.length > 1048576) throw new GenerationError("INVALID_INPUT");
    return;
  }
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object") throw new GenerationError("INVALID_INPUT");
  const array = Array.isArray(value);
  if (
    Object.getPrototypeOf(value) !==
      (array ? Array.prototype : Object.prototype) ||
    seen.has(value)
  )
    throw new GenerationError("INVALID_INPUT");
  seen.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (
      descriptor.get ||
      descriptor.set ||
      !Object.hasOwn(descriptor, "value") ||
      ["__proto__", "prototype", "constructor"].includes(key)
    )
      throw new GenerationError("INVALID_INPUT");
    if (array && key === "length") continue;
    if (array && !/^(0|[1-9][0-9]*)$/.test(key))
      throw new GenerationError("INVALID_INPUT");
    safeInput(descriptor.value, depth + 1, seen, budget);
  }
  seen.delete(value);
}
