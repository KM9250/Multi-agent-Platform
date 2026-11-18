import { createHash } from "node:crypto";

export const IMPORT_LIMITS = Object.freeze({
  bytes: 16 * 1024 * 1024,
  rooms: 50,
  personasPerRoom: 16,
  messages: 20000,
  attachments: 1000,
  attachmentBytes: 4 * 1024 * 1024,
  text: 32768,
  depth: 14,
});
export class OperationError extends Error {
  constructor(
    public code: string,
    public status = 400,
  ) {
    super(code);
  }
}
export const hash = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
export const json = (value: unknown): string => JSON.stringify(value);
function fail(code = "IMPORT_INVALID"): never {
  throw new OperationError(code);
}
const forbidden = new Set([
  "__proto__",
  "prototype",
  "constructor",
  "apiKey",
  "api_key",
  "password",
  "sessionId",
  "sessionToken",
  "GEMINI_API_KEY",
  "API_KEY",
]);
function plain(value: unknown, depth = 0, budget = { nodes: 0 }): void {
  if (++budget.nodes > 500000) fail("IMPORT_LIMIT");
  if (depth > IMPORT_LIMITS.depth) fail("IMPORT_DEPTH_LIMIT");
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail();
    return;
  }
  if (typeof value !== "object") fail();
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    fail();
  for (const [key, property] of Object.entries(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if (key === "length" && Array.isArray(value)) continue;
    if (forbidden.has(key) || !("value" in property))
      fail("IMPORT_UNTRUSTED_FIELD");
    plain(property.value, depth + 1, budget);
  }
}
function obj(value: unknown, keys: string[]): Record<string, any> {
  if (!value || Array.isArray(value) || typeof value !== "object") fail();
  const object = value as Record<string, any>;
  for (const key of Object.keys(object))
    if (!keys.includes(key)) fail("IMPORT_UNKNOWN_FIELD");
  return object;
}
function text(
  value: unknown,
  max: number = IMPORT_LIMITS.text,
  optional = false,
): string {
  if (optional && value === undefined) return "";
  if (
    typeof value !== "string" ||
    value.length > max ||
    value.includes("\u0000")
  )
    fail();
  return value;
}
function ident(value: unknown): string {
  const result = text(value, 200);
  if (!result) fail();
  return result;
}
function array(value: unknown, max: number, optional = false): any[] {
  if (optional && value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) fail("IMPORT_LIMIT");
  return value;
}
function integer(value: unknown, max: number, fallback = 0): number {
  if (value === undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > max
  )
    fail();
  return value;
}
function boolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") fail();
  return value;
}
function timestamp(value: unknown): {
  value: number;
  trust: "legacy" | "unknown";
} {
  if (value === undefined || value === null)
    return { value: 0, trust: "unknown" };
  return { value: integer(value, 8640000000000000), trust: "legacy" };
}
function unique(items: { oldId: string }[]): void {
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.oldId)) fail("IMPORT_DUPLICATE_ID");
    ids.add(item.oldId);
  }
}
export type LegacyAttachment = {
  oldId: string;
  name: string;
  mimeType: string;
  data: Buffer;
  digest: string;
  sourceDigest: string;
};
export type LegacySegment = {
  oldId: string;
  channel: string;
  visibility: string;
  content: string;
  digest: string;
};
export type LegacyPersona = {
  oldId: string;
  config: Record<string, any>;
  attachments: {
    attachment: LegacyAttachment;
    purpose: "avatar" | "context";
    originalId: string;
  }[];
  sourceDigest: string;
};
export type LegacyMessage = {
  oldId: string;
  role: "user" | "model";
  personaOldId?: string;
  content: string;
  segments: LegacySegment[];
  attachments: LegacyAttachment[];
  occurredAt: number;
  timeTrust: "legacy" | "unknown";
  incomplete: boolean;
  sourceDigest: string;
  recipient?: unknown;
};
export type LegacyRoom = {
  oldId: string;
  config: Record<string, any>;
  personas: LegacyPersona[];
  messages: LegacyMessage[];
  decisions: Record<string, any>[];
  reactions: Record<string, any>[];
  sourceDigest: string;
};
export type LegacyManifest = {
  sourceId: string;
  rooms: LegacyRoom[];
  digest: string;
  counts: Record<string, number>;
  warnings: { code: string; count: number }[];
};

function attachment(value: unknown): LegacyAttachment {
  const source = obj(value, ["id", "type", "mimeType", "name", "data"]);
  const oldId = ident(source.id),
    name = text(source.name, 200),
    mimeType = text(source.mimeType, 100);
  const input = text(source.data, IMPORT_LIMITS.attachmentBytes * 2);
  let data: Buffer;
  if (
    source.type === "text" &&
    (mimeType === "text/plain" ||
      mimeType === "text/markdown" ||
      mimeType === "application/json")
  )
    data = Buffer.from(input, "utf8");
  else if (
    source.type === "image" &&
    ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mimeType)
  ) {
    const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(input);
    const encoded = match ? match[2] : input;
    if (
      (match && match[1] !== mimeType) ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) ||
      encoded.length % 4 !== 0
    )
      fail("IMPORT_ATTACHMENT_INVALID");
    data = Buffer.from(encoded, "base64");
    if (data.toString("base64") !== encoded) fail("IMPORT_ATTACHMENT_INVALID");
  } else fail("IMPORT_ATTACHMENT_TYPE");
  if (data.length > IMPORT_LIMITS.attachmentBytes)
    fail("IMPORT_ATTACHMENT_LIMIT");
  return {
    oldId,
    name,
    mimeType,
    data,
    digest: hash(data),
    sourceDigest: hash(json({ oldId, name, mimeType, digest: hash(data) })),
  };
}
function persona(value: unknown): LegacyPersona {
  const p = obj(value, [
    "id",
    "name",
    "description",
    "systemInstruction",
    "importedSystemInstruction",
    "importedSystemInstructionFileName",
    "additionalContextFiles",
    "model",
    "framework",
    "color",
    "avatar",
    "avatarType",
    "isEnabled",
    "thinkingBudget",
    "historyWindow",
    "pinFirstMessage",
    "subAgents",
    "subAgentPolicy",
    "groups",
    "participationProfile",
  ]);
  const oldId = ident(p.id),
    attachments: LegacyPersona["attachments"] = [];
  const config: Record<string, any> = {
    name: text(p.name, 200),
    description: text(p.description, 4000, true),
    systemInstruction: text(p.systemInstruction, IMPORT_LIMITS.text, true),
    model: text(p.model, 160),
    framework: p.framework ?? "standard",
    color: text(p.color, 64, true),
    avatar: text(p.avatar, IMPORT_LIMITS.attachmentBytes * 2, true),
    avatarType: p.avatarType ?? "emoji",
    isEnabled: boolean(p.isEnabled, true),
    thinkingBudget: integer(p.thinkingBudget, 32768),
    historyWindow: integer(p.historyWindow, 200),
    pinFirstMessage: boolean(p.pinFirstMessage, true),
    groups: array(p.groups, 16, true).map((g) => text(g, 100)),
    participationProfile: text(p.participationProfile, 4000, true),
    subAgents: array(p.subAgents, 4, true).map((raw) => {
      const a = obj(raw, [
        "id",
        "name",
        "description",
        "provider",
        "model",
        "systemInstruction",
        "capabilities",
        "isEnabled",
        "thinkingBudget",
        "maxOutputTokens",
        "maxCallsPerTurn",
      ]);
      return {
        id: ident(a.id),
        name: text(a.name, 200),
        description: text(a.description, 4000, true),
        provider: text(a.provider, 100),
        model: text(a.model, 160),
        systemInstruction: text(a.systemInstruction),
        capabilities: array(a.capabilities, 8, true).map((c) => text(c, 100)),
        isEnabled: boolean(a.isEnabled, true),
        ...(a.thinkingBudget === undefined
          ? {}
          : { thinkingBudget: integer(a.thinkingBudget, 32768) }),
        maxOutputTokens: integer(a.maxOutputTokens, 8192, 1024),
        maxCallsPerTurn: integer(a.maxCallsPerTurn, 1, 1),
      };
    }),
    subAgentPolicy:
      p.subAgentPolicy === undefined
        ? { mode: "off" }
        : obj(p.subAgentPolicy, ["mode"]),
  };
  if (
    !["standard", "cot", "react"].includes(config.framework) ||
    !["off", "fixed_serial"].includes(config.subAgentPolicy.mode)
  )
    fail();
  if (p.importedSystemInstruction !== undefined)
    config.importedSystemInstruction = text(p.importedSystemInstruction);
  if (p.importedSystemInstructionFileName !== undefined)
    config.importedSystemInstructionFileName = text(
      p.importedSystemInstructionFileName,
      200,
    );
  if (config.avatarType === "image") {
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,/.exec(
      config.avatar,
    );
    if (!match) fail("IMPORT_ATTACHMENT_INVALID");
    attachments.push({
      purpose: "avatar",
      originalId: `${oldId}:avatar`,
      attachment: attachment({
        id: `${oldId}:avatar`,
        name: "avatar",
        type: "image",
        mimeType: match[1],
        data: config.avatar,
      }),
    });
    delete config.avatar;
  } else if (config.avatarType !== "emoji" || config.avatar.length > 32)
    fail("IMPORT_ATTACHMENT_INVALID");
  for (const raw of array(p.additionalContextFiles, 16, true)) {
    const f = obj(raw, [
      "id",
      "name",
      "content",
      "mimeType",
      "charCount",
      "sizeBytes",
      "order",
      "addedAt",
    ]);
    const data = attachment({
      id: ident(f.id),
      name: text(f.name, 255),
      type: "text",
      mimeType: text(f.mimeType, 100),
      data: text(f.content),
    });
    attachments.push({
      purpose: "context",
      originalId: data.oldId,
      attachment: data,
    });
  }
  if (json(config).length + attachments.length * 40 > 65536)
    fail("IMPORT_CONFIG_LIMIT");
  return { oldId, config, attachments, sourceDigest: hash(json(p)) };
}
function message(
  value: unknown,
  warningCounts: Map<string, number>,
): LegacyMessage {
  const m = obj(value, [
    "id",
    "role",
    "content",
    "agentId",
    "attachments",
    "timestamp",
    "isStreaming",
    "error",
    "errorCode",
    "errorDetail",
    "turnId",
    "generationContext",
    "segments",
    "separationVersion",
    "recipientTarget",
  ]);
  const oldId = ident(m.id),
    content = text(m.content),
    role = m.role;
  if (role !== "user" && role !== "model") fail();
  const occurred = timestamp(m.timestamp),
    incomplete = boolean(m.isStreaming, false);
  const warn = (code: string) =>
    warningCounts.set(code, (warningCounts.get(code) ?? 0) + 1);
  if (occurred.trust === "unknown") warn("TIMESTAMP_UNKNOWN");
  if (incomplete) warn("UNFINISHED_GENERATION_NOT_RESUMED");
  let segments: LegacySegment[] = [];
  const rawSegments = array(m.segments, 16, true);
  for (const raw of rawSegments) {
    const s = obj(raw, ["id", "channel", "visibility", "content"]);
    const body = text(s.content),
      channel = text(s.channel, 100),
      visibility = text(s.visibility, 100);
    const known =
      [
        "public_message",
        "shared_summary",
        "private_state",
        "debug_thoughts",
        "gm_log",
        "memory_export",
      ].includes(channel) &&
      [
        "public",
        "self_only",
        "self_and_gm",
        "gm_only",
        "developer_only",
      ].includes(visibility);
    const safePublic =
      (channel === "public_message" || channel === "shared_summary") &&
      visibility === "public";
    const safePrivate =
      known &&
      visibility !== "public" &&
      channel !== "public_message" &&
      channel !== "shared_summary";
    if (!safePublic && !safePrivate) warn("UNKNOWN_CLASSIFICATION_QUARANTINED");
    segments.push({
      oldId: ident(s.id),
      channel: safePublic || safePrivate ? channel : "gm_log",
      visibility: safePublic || safePrivate ? visibility : "developer_only",
      content: body,
      digest: hash(body),
    });
  }
  if (!rawSegments.length) {
    // Never promote legacy application debug blocks or unfinished raw JSON to public text.
    if (role === "model" && (incomplete || /^\s*[{[]/.test(content))) {
      segments = [
        {
          oldId: `${oldId}:quarantined`,
          channel: "gm_log",
          visibility: "developer_only",
          content,
          digest: hash(content),
        },
      ];
      warn("UNKNOWN_CLASSIFICATION_QUARANTINED");
    } else {
      const debug: string[] = [];
      const publicText =
        role === "model"
          ? content.replace(
              /\[(THOUGHT|ACTION)\]([\s\S]*?)\[\/\1\]/gi,
              (_whole, _tag, body) => {
                debug.push(body);
                return "";
              },
            )
          : content;
      if (publicText)
        segments.push({
          oldId: `${oldId}:public`,
          channel: "public_message",
          visibility: "public",
          content: publicText,
          digest: hash(publicText),
        });
      debug.forEach((body, i) =>
        segments.push({
          oldId: `${oldId}:debug:${i}`,
          channel: "debug_thoughts",
          visibility: "developer_only",
          content: body,
          digest: hash(body),
        }),
      );
    }
  }
  if (!segments.length)
    segments.push({
      oldId: `${oldId}:public`,
      channel: "public_message",
      visibility: "public",
      content: "",
      digest: hash(""),
    });
  unique(segments);
  if (
    segments.length > 16 ||
    segments.reduce((sum, segment) => sum + segment.content.length, 0) >
      IMPORT_LIMITS.text
  )
    fail("IMPORT_SEGMENT_LIMIT");
  if (m.generationContext !== undefined)
    obj(m.generationContext, ["historyMessageIds", "attempt", "modelId"]);
  if (m.recipientTarget !== undefined) {
    const recipient = obj(m.recipientTarget, ["type", "agentIds", "groupId"]);
    if (!["auto", "agent", "group", "all"].includes(recipient.type)) fail();
    array(recipient.agentIds, 32, true).forEach(ident);
    if (recipient.groupId !== undefined) text(recipient.groupId, 100);
  }
  const attachments = array(m.attachments, 8, true).map(attachment);
  unique(attachments);
  return {
    oldId,
    role,
    personaOldId: m.agentId === undefined ? undefined : ident(m.agentId),
    content,
    segments,
    attachments,
    occurredAt: occurred.value,
    timeTrust: occurred.trust,
    incomplete,
    sourceDigest: hash(json(m)),
    recipient: m.recipientTarget,
  };
}
export function prepareLegacy(input: unknown): LegacyManifest {
  plain(input);
  const encoded = json(input);
  if (Buffer.byteLength(encoded) > IMPORT_LIMITS.bytes) fail("IMPORT_LIMIT");
  const source = obj(JSON.parse(encoded), ["sourceId", "rooms"]);
  const sourceId = ident(source.sourceId);
  const warnings = new Map<string, number>();
  const counts = {
    rooms: 0,
    personas: 0,
    messages: 0,
    revisions: 0,
    segments: 0,
    decisions: 0,
    reactions: 0,
    attachments: 0,
  };
  const rooms = array(source.rooms, IMPORT_LIMITS.rooms).map((raw) => {
    const r = obj(raw, [
      "id",
      "title",
      "description",
      "systemInstruction",
      "type",
      "agents",
      "messages",
      "decisionEvents",
      "reactions",
      "internalStateSettings",
      "updatedAt",
    ]);
    const oldId = ident(r.id),
      personas = array(r.agents, IMPORT_LIMITS.personasPerRoom).map(persona);
    unique(personas);
    const messages = array(r.messages, IMPORT_LIMITS.messages).map((m) =>
      message(m, warnings),
    );
    unique(messages);
    const personaIds = new Set(personas.map((p) => p.oldId)),
      messageIds = new Set(messages.map((m) => m.oldId));
    // A missing legacy agent is an immutable historical identity, never an executable config.
    const historicalIds = new Set<string>();
    const referencePersona = (value: unknown) => {
      const id = ident(value);
      if (!personaIds.has(id)) historicalIds.add(id);
    };
    for (const m of messages) {
      if (m.role === "user" && m.personaOldId !== undefined) fail();
      if (m.personaOldId !== undefined) referencePersona(m.personaOldId);
    }
    const decisions = array(r.decisionEvents, IMPORT_LIMITS.messages, true).map(
      (value) => {
        const d = obj(value, [
          "id",
          "turnId",
          "timestamp",
          "agentId",
          "agentName",
          "outcome",
          "source",
          "latencyMs",
          "decisionModel",
          "rawDecision",
          "errorCode",
          "errorDetail",
          "reaction",
        ]);
        ident(d.id);
        ident(d.turnId);
        referencePersona(d.agentId);
        if (!["RESPOND", "STAMP", "IGNORE", "ERROR"].includes(d.outcome))
          fail();
        text(d.source, 100);
        integer(d.latencyMs, 86400000);
        timestamp(d.timestamp);
        for (const k of [
          "agentName",
          "decisionModel",
          "errorCode",
          "rawDecision",
          "errorDetail",
        ])
          if (d[k] !== undefined) text(d[k]);
        return d;
      },
    );
    const reactions = array(r.reactions, IMPORT_LIMITS.messages, true).map(
      (value) => {
        const reaction = obj(value, [
          "id",
          "messageId",
          "agentId",
          "semantic",
          "timestamp",
          "turnId",
        ]);
        ident(reaction.id);
        ident(reaction.turnId);
        if (!messageIds.has(ident(reaction.messageId)))
          fail("IMPORT_REFERENCE_MISSING");
        referencePersona(reaction.agentId);
        if (
          !["ACK", "AGREE", "THINK", "AMUSED", "CARE", "DISAGREE"].includes(
            reaction.semantic,
          )
        )
          fail();
        timestamp(reaction.timestamp);
        return reaction;
      },
    );
    if (
      new Set(decisions.map((d) => d.id)).size !== decisions.length ||
      new Set(reactions.map((d) => d.id)).size !== reactions.length
    )
      fail("IMPORT_DUPLICATE_ID");
    const config = {
      title: text(r.title, 200),
      description: text(r.description, 4000, true),
      systemInstruction: text(r.systemInstruction, IMPORT_LIMITS.text, true),
      type: r.type ?? "Sandbox",
      internalStateSettings:
        r.internalStateSettings === undefined
          ? { enabled: false }
          : obj(r.internalStateSettings, [
              "enabled",
              "showPrivateState",
              "showDebugThoughts",
              "showGmLog",
              "showMemoryExport",
            ]),
    };
    if (!["Sandbox", "Recreation", "Hard"].includes(config.type)) fail();
    for (const value of Object.values(config.internalStateSettings))
      boolean(value, false);
    timestamp(r.updatedAt);
    for (const legacyPersonaId of historicalIds) {
      const config = {
        name: "Legacy Persona (deleted)",
        isEnabled: false,
        historicalIdentity: { legacyRoomId: oldId, legacyPersonaId },
      };
      personas.push({
        oldId: legacyPersonaId,
        config,
        attachments: [],
        sourceDigest: hash(json(config)),
      });
    }
    if (historicalIds.size)
      warnings.set(
        "DELETED_PERSONA_HISTORY_ONLY",
        (warnings.get("DELETED_PERSONA_HISTORY_ONLY") ?? 0) +
          historicalIds.size,
      );
    counts.rooms++;
    counts.personas += personas.length;
    counts.messages += messages.length;
    counts.revisions += messages.length;
    counts.segments += messages.reduce(
      (total, m) => total + m.segments.length,
      0,
    );
    counts.decisions += decisions.length;
    counts.reactions += reactions.length;
    counts.attachments +=
      messages.reduce((total, m) => total + m.attachments.length, 0) +
      personas.reduce((total, p) => total + p.attachments.length, 0);
    return {
      oldId,
      config,
      personas,
      messages,
      decisions,
      reactions,
      sourceDigest: hash(json(r)),
    };
  });
  unique(rooms);
  if (
    counts.messages > IMPORT_LIMITS.messages ||
    counts.personas > IMPORT_LIMITS.messages ||
    counts.attachments > IMPORT_LIMITS.attachments
  )
    fail("IMPORT_LIMIT");
  return {
    sourceId,
    rooms,
    digest: hash(encoded),
    counts,
    warnings: [...warnings].map(([code, count]) => ({ code, count })),
  };
}
