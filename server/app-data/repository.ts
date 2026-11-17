import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  AppError,
  APP_LIMITS,
  type Actor,
  type AuthorizationPort,
  type RoomDTO,
  type PersonaDTO,
  type MessageDTO,
  type MessagePage,
  type SegmentInput,
  type AttachmentDTO,
} from "../../shared/app-contracts/index.ts";
import { AppDatabase } from "./db.ts";
import {
  bool,
  canonical,
  digest,
  id,
  integer,
  object,
  string,
  securePolicy,
} from "./validation.ts";
const DEFAULT_SETTINGS = {
  enabled: false,
  showPrivateState: false,
  showDebugThoughts: false,
  showGmLog: false,
  showMemoryExport: false,
};
const ROOM_KEYS = [
  "title",
  "description",
  "type",
  "systemInstruction",
  "internalStateSettings",
  "expectedRevision",
];
const PERSONA_KEYS = [
  "name",
  "description",
  "systemInstruction",
  "model",
  "framework",
  "color",
  "avatar",
  "avatarType",
  "avatarAttachmentId",
  "isEnabled",
  "thinkingBudget",
  "historyWindow",
  "pinFirstMessage",
  "groups",
  "participationProfile",
  "subAgents",
  "subAgentPolicy",
  "contextAttachmentIds",
  "importedSystemInstruction",
  "importedSystemInstructionFileName",
  "expectedRevision",
];
const CHANNELS = [
  "public_message",
  "shared_summary",
  "private_state",
  "debug_thoughts",
  "gm_log",
  "memory_export",
];
const VISIBILITIES = [
  "public",
  "self_only",
  "self_and_gm",
  "gm_only",
  "developer_only",
];
type Row = Record<string, any>;
export interface MessageInput {
  role: "user" | "model";
  personaId?: string;
  content?: string;
  segments?: SegmentInput[];
  attachmentIds?: string[];
  occurredAt?: number;
  messageId?: string;
  reason?: string;
}
export const attachmentDTO = (row: Row): AttachmentDTO => ({
  id: row.attachment_id,
  name: row.name,
  mimeType: row.mime_type,
  size: row.size,
  digest: row.digest,
  url: `/api/app/v1/rooms/${encodeURIComponent(row.room_id)}/attachments/${encodeURIComponent(row.attachment_id)}/content`,
});
export class ConversationRepository {
  readonly app: AppDatabase;
  readonly policy: AuthorizationPort;
  #importBatch?: string;
  constructor(app: AppDatabase, policy: AuthorizationPort) {
    this.app = app;
    this.policy = securePolicy(policy);
  }
  withImport<T>(batchId: string, fn: () => T): T {
    if (this.#importBatch) throw new AppError("IMPORT_SCOPE_NESTING");
    this.#importBatch = batchId;
    try {
      const result = fn();
      if (result && typeof (result as any).then === "function")
        throw new AppError("ASYNC_IMPORT_SCOPE");
      return result;
    } finally {
      this.#importBatch = undefined;
    }
  }
  #assert(
    actor: Actor,
    operation: string,
    roomId?: string,
    personaId?: string,
  ) {
    this.policy.assert(actor, this.#importBatch ? "IMPORT_DATA" : operation, {
      roomId,
      personaId,
    });
  }
  #room(actor: Actor, roomId: string): Row {
    const row = this.app.db
      .prepare(
        "SELECT * FROM rooms WHERE workspace_id=? AND room_id=? AND deleted_at IS NULL",
      )
      .get(actor.workspaceId, roomId) as Row | undefined;
    if (!row) throw new AppError("NOT_FOUND", 404);
    if (
      row.import_batch_id &&
      row.import_batch_id !== this.#importBatch &&
      !this.app.db
        .prepare(
          "SELECT 1 FROM import_batches WHERE workspace_id=? AND batch_id=? AND status='COMPLETE'",
        )
        .get(actor.workspaceId, row.import_batch_id)
    )
      throw new AppError("NOT_FOUND", 404);
    return row;
  }
  #can(
    actor: Actor,
    operation: string,
    roomId: string,
    personaId?: string,
  ): boolean {
    try {
      this.policy.assert(actor, operation, { roomId, personaId });
      return true;
    } catch {
      return false;
    }
  }
  listRooms(actor: Actor): RoomDTO[] {
    if (this.policy.revision) this.policy.revision(actor);
    else this.policy.assert(actor, "READ_ROOM");
    const rows = this.app.db
      .prepare(
        "SELECT room_id FROM rooms r WHERE workspace_id=? AND deleted_at IS NULL AND (import_batch_id IS NULL OR EXISTS(SELECT 1 FROM import_batches b WHERE b.workspace_id=r.workspace_id AND b.batch_id=r.import_batch_id AND b.status='COMPLETE')) ORDER BY modified_at DESC LIMIT 200",
      )
      .all(actor.workspaceId) as Row[];
    return rows
      .filter((r) => this.#can(actor, "READ_ROOM", r.room_id))
      .map((r) => this.getRoom(actor, r.room_id));
  }
  #roomConfig(input: unknown, previous?: Row): Row {
    const x = object(input, ROOM_KEYS),
      cfg = {
        title: "New room",
        description: "",
        type: "Sandbox",
        systemInstruction: "",
        internalStateSettings: { ...DEFAULT_SETTINGS },
        ...previous,
      };
    if (x.title !== undefined) cfg.title = string(x.title, 200);
    if (x.description !== undefined)
      cfg.description = string(x.description, 4000, false);
    if (x.type !== undefined) {
      if (!["Sandbox", "Recreation", "Hard"].includes(x.type))
        throw new AppError("INVALID_INPUT");
      cfg.type = x.type;
    }
    if (x.systemInstruction !== undefined)
      cfg.systemInstruction = string(
        x.systemInstruction,
        APP_LIMITS.configChars,
        false,
      );
    if (x.internalStateSettings !== undefined) {
      const settings = object(
        x.internalStateSettings,
        Object.keys(DEFAULT_SETTINGS),
      );
      cfg.internalStateSettings = {
        ...DEFAULT_SETTINGS,
        ...cfg.internalStateSettings,
      };
      for (const key of Object.keys(settings))
        cfg.internalStateSettings[key] = bool(settings[key]);
    }
    return cfg;
  }
  createRoom(
    actor: Actor,
    input: unknown,
    options: {
      importBatchId?: string;
      roomId?: string;
      occurredAt?: number;
    } = {},
  ): RoomDTO {
    this.#assert(actor, "EDIT_ROOM");
    const cfg = this.#roomConfig(input);
    const roomId = options.roomId ?? id();
    if (
      options.importBatchId !== undefined &&
      options.importBatchId !== this.#importBatch
    )
      throw new AppError("INVALID_IMPORT_SCOPE");
    return this.app.transaction(() => {
      const now = Date.now();
      this.app.db
        .prepare(
          "INSERT INTO rooms(workspace_id,room_id,title,revision,config_json,created_by,created_at,modified_at,import_batch_id) VALUES(?,?,?,1,?,?,?,?,?)",
        )
        .run(
          actor.workspaceId,
          roomId,
          cfg.title,
          canonical(cfg),
          actor.actorId,
          options.occurredAt ?? now,
          now,
          options.importBatchId ?? this.#importBatch ?? null,
        );
      this.app.db
        .prepare("INSERT INTO room_memberships VALUES(?,?,?,?)")
        .run(actor.workspaceId, roomId, actor.actorId, now);
      this.app.audit(actor.actorId, actor.workspaceId, "CREATE_ROOM", roomId);
      this.app.change(actor.workspaceId, roomId, "ROOM", roomId, 1, "CREATE");
      return this.getRoom(actor, roomId);
    });
  }
  getRoom(actor: Actor, roomId: string): RoomDTO {
    this.#assert(actor, "READ_ROOM", roomId);
    const row = this.#room(actor, roomId),
      cfg = JSON.parse(row.config_json);
    const personas = this.app.db
      .prepare(
        "SELECT rp.persona_id FROM room_personas rp JOIN personas p USING(workspace_id,persona_id) JOIN persona_revisions pr ON pr.workspace_id=p.workspace_id AND pr.persona_id=p.persona_id AND pr.revision=rp.persona_revision WHERE rp.workspace_id=? AND rp.room_id=? AND p.deleted_at IS NULL AND json_extract(pr.config_json,'$.historicalIdentity') IS NULL ORDER BY p.created_at",
      )
      .all(actor.workspaceId, roomId) as Row[];
    if (
      !this.#can(actor, "EDIT_ROOM", roomId) &&
      !this.#can(actor, "GENERATE", roomId)
    )
      delete cfg.systemInstruction;
    const diagnostics = this.#can(actor, "READ_CONVERSATION", roomId)
      ? this.#legacyDiagnostics(actor, roomId)
      : {};
    return {
      ...cfg,
      ...diagnostics,
      id: roomId,
      workspaceId: actor.workspaceId,
      revision: row.revision,
      agents: personas.map((p) => this.getPersona(actor, roomId, p.persona_id)),
      historicalPersonas: this.app.db
        .prepare(
          "SELECT p.persona_id,pr.config_json FROM room_personas rp JOIN personas p USING(workspace_id,persona_id) JOIN persona_revisions pr ON pr.workspace_id=p.workspace_id AND pr.persona_id=p.persona_id AND pr.revision=rp.persona_revision WHERE rp.workspace_id=? AND rp.room_id=? AND p.deleted_at IS NULL AND json_extract(pr.config_json,'$.historicalIdentity') IS NOT NULL",
        )
        .all(actor.workspaceId, roomId)
        .map((p) => ({
          id: String(p.persona_id),
          ...JSON.parse(String(p.config_json)).historicalIdentity,
        })),
      updatedAt: row.modified_at,
    };
  }
  #legacyDiagnostics(
    actor: Actor,
    roomId: string,
  ): { legacyDecisions: any[]; legacyReactions: any[] } {
    const decisions = this.app.db
      .prepare(
        "SELECT d.* FROM import_decisions d JOIN import_batches b ON b.workspace_id=d.workspace_id AND b.batch_id=d.batch_id JOIN personas p ON p.workspace_id=d.workspace_id AND p.persona_id=d.persona_id WHERE d.workspace_id=? AND d.room_id=? AND b.status='COMPLETE' AND p.deleted_at IS NULL ORDER BY d.rowid DESC LIMIT 200",
      )
      .all(actor.workspaceId, roomId) as Row[];
    const reactions = this.app.db
      .prepare(
        "SELECT r.* FROM import_reactions r JOIN import_batches b ON b.workspace_id=r.workspace_id AND b.batch_id=r.batch_id JOIN personas p ON p.workspace_id=r.workspace_id AND p.persona_id=r.persona_id JOIN messages m ON m.workspace_id=r.workspace_id AND m.room_id=r.room_id AND m.message_id=r.message_id WHERE r.workspace_id=? AND r.room_id=? AND b.status='COMPLETE' AND p.deleted_at IS NULL AND m.deleted_at IS NULL AND EXISTS(SELECT 1 FROM message_segments s WHERE s.workspace_id=m.workspace_id AND s.room_id=m.room_id AND s.message_id=m.message_id AND s.revision=m.current_revision AND s.visibility='public') ORDER BY r.rowid DESC LIMIT 200",
      )
      .all(actor.workspaceId, roomId) as Row[];
    return {
      legacyDecisions: decisions.map((d) => {
        const payload = JSON.parse(d.payload_json);
        return {
          id: d.decision_id,
          personaId: d.persona_id,
          legacyTurnId: d.legacy_turn_id,
          outcome: payload.outcome,
          source: payload.source,
          latencyMs: payload.latencyMs,
          timestamp: payload.timestamp,
          ...(payload.reaction ? { reaction: payload.reaction } : {}),
          legacy: true,
        };
      }),
      legacyReactions: reactions.map((r) => ({
        id: r.reaction_id,
        messageId: r.message_id,
        personaId: r.persona_id,
        legacyTurnId: r.legacy_turn_id,
        semantic: r.semantic,
        timestamp: r.occurred_at,
        legacy: true,
      })),
    };
  }
  updateRoom(actor: Actor, roomId: string, input: unknown): RoomDTO {
    this.#assert(actor, "EDIT_ROOM", roomId);
    const x = object(input, ROOM_KEYS);
    integer(x.expectedRevision);
    return this.app.transaction(() => {
      const row = this.#room(actor, roomId);
      if (row.revision !== x.expectedRevision)
        throw new AppError("REVISION_CONFLICT", 409);
      const cfg = this.#roomConfig(input, JSON.parse(row.config_json));
      this.app.db
        .prepare(
          "UPDATE rooms SET title=?,config_json=?,revision=revision+1,modified_at=? WHERE workspace_id=? AND room_id=? AND revision=?",
        )
        .run(
          cfg.title,
          canonical(cfg),
          Date.now(),
          actor.workspaceId,
          roomId,
          x.expectedRevision,
        );
      this.app.audit(actor.actorId, actor.workspaceId, "UPDATE_ROOM", roomId);
      this.app.change(
        actor.workspaceId,
        roomId,
        "ROOM",
        roomId,
        row.revision + 1,
        "UPDATE",
      );
      return this.getRoom(actor, roomId);
    });
  }
  deleteRoom(
    actor: Actor,
    roomId: string,
    input: { expectedRevision: number },
  ): void {
    this.#assert(actor, "EDIT_ROOM", roomId);
    object(input, ["expectedRevision"]);
    this.app.transaction(() => {
      const row = this.#room(actor, roomId);
      if (row.revision !== integer(input.expectedRevision))
        throw new AppError("REVISION_CONFLICT", 409);
      this.app.db
        .prepare(
          "UPDATE rooms SET deleted_at=?,revision=revision+1 WHERE workspace_id=? AND room_id=?",
        )
        .run(Date.now(), actor.workspaceId, roomId);
      this.app.audit(actor.actorId, actor.workspaceId, "DELETE_ROOM", roomId);
      this.app.change(
        actor.workspaceId,
        roomId,
        "ROOM",
        roomId,
        row.revision + 1,
        "DELETE",
      );
    });
  }
  #personaConfig(input: unknown, previous?: Row): Row {
    const x = object(input, PERSONA_KEYS),
      cfg: Row = {
        name: "Persona",
        description: "",
        systemInstruction: "",
        model: "",
        framework: "standard",
        color: "#6366f1",
        avatar: "🤖",
        avatarType: "emoji",
        isEnabled: true,
        thinkingBudget: 0,
        historyWindow: 50,
        pinFirstMessage: true,
        groups: [],
        subAgents: [],
        subAgentPolicy: { mode: "off" },
        contextAttachmentIds: [],
        ...previous,
      };
    for (const key of [
      "name",
      "description",
      "systemInstruction",
      "importedSystemInstruction",
      "importedSystemInstructionFileName",
      "model",
      "color",
      "avatar",
      "participationProfile",
      "avatarAttachmentId",
    ])
      if (x[key] !== undefined)
        cfg[key] = string(
          x[key],
          ["systemInstruction", "importedSystemInstruction"].includes(key)
            ? APP_LIMITS.configChars
            : key === "description"
              ? 4000
              : key === "participationProfile"
                ? 4000
                : 200,
          key === "name",
        );
    if (x.avatarType === "emoji") delete cfg.avatarAttachmentId;
    if (
      x.avatar?.startsWith("data:") ||
      x.avatar?.startsWith("http:") ||
      x.avatar?.startsWith("https:")
    )
      throw new AppError("UPLOAD_REQUIRED");
    if (x.framework !== undefined) {
      if (!["standard", "cot", "react"].includes(x.framework))
        throw new AppError("INVALID_INPUT");
      cfg.framework = x.framework;
    }
    if (x.avatarType !== undefined) {
      if (!["emoji", "image"].includes(x.avatarType))
        throw new AppError("INVALID_INPUT");
      cfg.avatarType = x.avatarType;
    }
    for (const key of ["isEnabled", "pinFirstMessage"])
      if (x[key] !== undefined) cfg[key] = bool(x[key]);
    for (const key of ["thinkingBudget", "historyWindow"])
      if (x[key] !== undefined)
        cfg[key] = integer(x[key], 0, key === "historyWindow" ? 200 : 32768);
    for (const key of ["groups", "contextAttachmentIds"])
      if (x[key] !== undefined) {
        if (!Array.isArray(x[key]) || x[key].length > 16)
          throw new AppError("INVALID_INPUT");
        cfg[key] = x[key].map((v) => string(v, 100));
      }
    if (x.subAgentPolicy !== undefined) {
      object(x.subAgentPolicy, ["mode"]);
      if (!["off", "fixed_serial"].includes(x.subAgentPolicy.mode))
        throw new AppError("INVALID_INPUT");
      cfg.subAgentPolicy = x.subAgentPolicy;
    }
    if (x.subAgents !== undefined) {
      if (!Array.isArray(x.subAgents) || x.subAgents.length > 4)
        throw new AppError("INVALID_INPUT");
      cfg.subAgents = x.subAgents.map((v) => {
        const s = object(v, [
          "id",
          "name",
          "description",
          "provider",
          "model",
          "systemInstruction",
          "isEnabled",
          "thinkingBudget",
          "maxOutputTokens",
          "maxCallsPerTurn",
          "capabilities",
        ]);
        for (const k of [
          "id",
          "name",
          "provider",
          "model",
          "systemInstruction",
        ])
          string(
            s[k],
            k === "systemInstruction" ? APP_LIMITS.configChars : 200,
            k !== "systemInstruction",
          );
        bool(s.isEnabled);
        if (s.maxCallsPerTurn !== undefined) integer(s.maxCallsPerTurn, 1, 1);
        if (s.maxOutputTokens !== undefined)
          integer(s.maxOutputTokens, 1, 8192);
        if (s.thinkingBudget !== undefined) integer(s.thinkingBudget, 0, 32768);
        if (s.capabilities !== undefined) {
          if (!Array.isArray(s.capabilities) || s.capabilities.length > 8)
            throw new AppError("INVALID_INPUT");
          s.capabilities = s.capabilities.map((v) => string(v, 100));
        }
        return s;
      });
    }
    if (canonical(cfg).length > APP_LIMITS.configChars)
      throw new AppError("INPUT_TOO_LARGE", 413);
    return cfg;
  }
  #personaLinks(
    actor: Actor,
    roomId: string,
    personaId: string,
    revision: number,
    cfg: Row,
  ): void {
    const refs = [
      ...(cfg.avatarAttachmentId
        ? [{ id: cfg.avatarAttachmentId, purpose: "AVATAR" }]
        : []),
      ...(cfg.contextAttachmentIds ?? []).map((a) => ({
        id: a,
        purpose: "CONTEXT",
      })),
    ];
    for (const ref of refs) {
      const attachment = this.app.db
        .prepare(
          "SELECT owner_actor_id FROM attachments WHERE workspace_id=? AND room_id=? AND attachment_id=? AND state='AVAILABLE' AND deleted_at IS NULL",
        )
        .get(actor.workspaceId, roomId, ref.id);
      if (!attachment || attachment.owner_actor_id !== actor.actorId)
        throw new AppError("ATTACHMENT_NOT_AVAILABLE", 404);
      this.app.db
        .prepare("INSERT INTO persona_attachment_links VALUES(?,?,?,?,?,?)")
        .run(
          actor.workspaceId,
          roomId,
          personaId,
          revision,
          ref.id,
          ref.purpose,
        );
    }
  }
  createPersona(
    actor: Actor,
    roomId: string,
    input: unknown,
    options: { personaId?: string } = {},
  ): PersonaDTO {
    this.#assert(actor, "EDIT_PERSONA", roomId);
    const cfg = this.#personaConfig(input);
    return this.app.transaction(() => {
      this.#room(actor, roomId);
      const count = this.app.db
        .prepare(
          "SELECT count(*) n FROM room_personas rp JOIN personas p USING(workspace_id,persona_id) JOIN persona_revisions pr ON pr.workspace_id=p.workspace_id AND pr.persona_id=p.persona_id AND pr.revision=rp.persona_revision WHERE rp.workspace_id=? AND rp.room_id=? AND p.deleted_at IS NULL AND json_extract(pr.config_json,'$.historicalIdentity') IS NULL",
        )
        .get(actor.workspaceId, roomId)!.n;
      if (Number(count) >= APP_LIMITS.personasPerRoom)
        throw new AppError("PERSONA_LIMIT", 413);
      const personaId = options.personaId ?? id(),
        now = Date.now(),
        json = canonical(cfg);
      this.app.db
        .prepare("INSERT INTO personas VALUES(?,?,1,?,?,?,NULL)")
        .run(actor.workspaceId, personaId, actor.actorId, now, now);
      this.app.db
        .prepare("INSERT INTO persona_revisions VALUES(?,?,1,?,?,?)")
        .run(actor.workspaceId, personaId, json, digest(json), now);
      this.app.db
        .prepare("INSERT INTO room_personas VALUES(?,?,?,1,1)")
        .run(actor.workspaceId, roomId, personaId);
      this.#personaLinks(actor, roomId, personaId, 1, cfg);
      this.app.audit(
        actor.actorId,
        actor.workspaceId,
        "CREATE_PERSONA",
        personaId,
      );
      this.app.change(
        actor.workspaceId,
        roomId,
        "PERSONA",
        personaId,
        1,
        "CREATE",
      );
      return this.getPersona(actor, roomId, personaId);
    });
  }
  /** Only trusted ImportService may create immutable identities for absent legacy agents. */
  createHistoricalPersona(
    actor: Actor,
    roomId: string,
    identity: { legacyRoomId: string; legacyPersonaId: string },
  ) {
    if (!this.#importBatch) throw new AppError("INVALID_IMPORT_SCOPE");
    this.#assert(actor, "IMPORT_DATA", roomId);
    object(identity, ["legacyRoomId", "legacyPersonaId"]);
    string(identity.legacyRoomId, 200);
    string(identity.legacyPersonaId, 200);
    return this.app.transaction(() => {
      this.#room(actor, roomId);
      const personaId = id(),
        now = Date.now();
      const json = canonical({
        name: "Legacy Persona (deleted)",
        isEnabled: false,
        historicalIdentity: identity,
      });
      this.app.db
        .prepare("INSERT INTO personas VALUES(?,?,1,?,?,?,NULL)")
        .run(actor.workspaceId, personaId, actor.actorId, now, now);
      this.app.db
        .prepare("INSERT INTO persona_revisions VALUES(?,?,1,?,?,?)")
        .run(actor.workspaceId, personaId, json, digest(json), now);
      this.app.db
        .prepare("INSERT INTO room_personas VALUES(?,?,?,1,1)")
        .run(actor.workspaceId, roomId, personaId);
      this.app.audit(
        actor.actorId,
        actor.workspaceId,
        "IMPORT_HISTORICAL_PERSONA",
        personaId,
      );
      this.app.change(
        actor.workspaceId,
        roomId,
        "PERSONA",
        personaId,
        1,
        "HISTORY_ONLY",
      );
      return this.getPersona(actor, roomId, personaId);
    });
  }
  getPersona(actor: Actor, roomId: string, personaId: string): PersonaDTO {
    this.#assert(actor, "READ_ROOM", roomId);
    this.#room(actor, roomId);
    const row = this.app.db
      .prepare(
        "SELECT pr.* FROM room_personas rp JOIN personas p USING(workspace_id,persona_id) JOIN persona_revisions pr ON pr.workspace_id=rp.workspace_id AND pr.persona_id=rp.persona_id AND pr.revision=rp.persona_revision WHERE rp.workspace_id=? AND rp.room_id=? AND rp.persona_id=? AND p.deleted_at IS NULL",
      )
      .get(actor.workspaceId, roomId, personaId) as Row | undefined;
    if (!row) throw new AppError("NOT_FOUND", 404);
    const cfg = JSON.parse(row.config_json);
    if (
      !this.#can(actor, "EDIT_PERSONA", roomId, personaId) &&
      !this.#can(actor, "GENERATE", roomId, personaId)
    ) {
      cfg.systemInstruction = "";
      delete cfg.subAgents;
      delete cfg.contextAttachmentIds;
      delete cfg.participationProfile;
      delete cfg.importedSystemInstruction;
      delete cfg.importedSystemInstructionFileName;
    }
    if (cfg.avatarAttachmentId)
      cfg.avatar = `/api/app/v1/rooms/${encodeURIComponent(roomId)}/attachments/${encodeURIComponent(cfg.avatarAttachmentId)}/content`;
    return { ...cfg, id: personaId, revision: row.revision };
  }
  updatePersona(
    actor: Actor,
    roomId: string,
    personaId: string,
    input: unknown,
  ): PersonaDTO {
    this.#assert(actor, "EDIT_PERSONA", roomId, personaId);
    const x = object(input, PERSONA_KEYS);
    integer(x.expectedRevision);
    return this.app.transaction(() => {
      this.#room(actor, roomId);
      const row = this.app.db
        .prepare(
          "SELECT pr.* FROM room_personas rp JOIN personas p USING(workspace_id,persona_id) JOIN persona_revisions pr ON pr.workspace_id=rp.workspace_id AND pr.persona_id=rp.persona_id AND pr.revision=rp.persona_revision WHERE rp.workspace_id=? AND rp.room_id=? AND rp.persona_id=? AND p.deleted_at IS NULL",
        )
        .get(actor.workspaceId, roomId, personaId) as Row | undefined;
      if (!row) throw new AppError("NOT_FOUND", 404);
      if (row.revision !== x.expectedRevision)
        throw new AppError("REVISION_CONFLICT", 409);
      if (JSON.parse(row.config_json).historicalIdentity)
        throw new AppError("HISTORICAL_PERSONA_IMMUTABLE", 409);
      const cfg = this.#personaConfig(input, JSON.parse(row.config_json)),
        rev = row.revision + 1,
        json = canonical(cfg),
        now = Date.now();
      this.app.db
        .prepare("INSERT INTO persona_revisions VALUES(?,?,?,?,?,?)")
        .run(actor.workspaceId, personaId, rev, json, digest(json), now);
      this.app.db
        .prepare(
          "UPDATE personas SET current_revision=?,modified_at=? WHERE workspace_id=? AND persona_id=?",
        )
        .run(rev, now, actor.workspaceId, personaId);
      this.app.db
        .prepare(
          "UPDATE room_personas SET persona_revision=? WHERE workspace_id=? AND room_id=? AND persona_id=?",
        )
        .run(rev, actor.workspaceId, roomId, personaId);
      this.#personaLinks(actor, roomId, personaId, rev, cfg);
      this.app.audit(
        actor.actorId,
        actor.workspaceId,
        "UPDATE_PERSONA",
        personaId,
      );
      this.app.change(
        actor.workspaceId,
        roomId,
        "PERSONA",
        personaId,
        rev,
        "UPDATE",
      );
      return this.getPersona(actor, roomId, personaId);
    });
  }
  deletePersona(
    actor: Actor,
    roomId: string,
    personaId: string,
    input: { expectedRevision: number },
  ): void {
    this.#assert(actor, "EDIT_PERSONA", roomId, personaId);
    object(input, ["expectedRevision"]);
    this.app.transaction(() => {
      const p = this.getPersona(actor, roomId, personaId);
      if (p.revision !== integer(input.expectedRevision))
        throw new AppError("REVISION_CONFLICT", 409);
      this.app.db
        .prepare(
          "UPDATE personas SET deleted_at=? WHERE workspace_id=? AND persona_id=?",
        )
        .run(Date.now(), actor.workspaceId, personaId);
      this.app.audit(
        actor.actorId,
        actor.workspaceId,
        "DELETE_PERSONA",
        personaId,
      );
      this.app.change(
        actor.workspaceId,
        roomId,
        "PERSONA",
        personaId,
        p.revision,
        "DELETE",
      );
    });
  }
  #segments(
    input: { content?: string; segments?: SegmentInput[] },
    role: "user" | "model",
  ): SegmentInput[] {
    if (input.segments !== undefined && input.content !== undefined)
      throw new AppError("AMBIGUOUS_CONTENT");
    const list = input.segments ?? [
      {
        channel: "public_message",
        visibility: "public",
        content: string(input.content ?? "", APP_LIMITS.messageChars, false),
      },
    ];
    if (
      !Array.isArray(list) ||
      list.length > APP_LIMITS.segmentsPerRevision ||
      list.length === 0
    )
      throw new AppError("INVALID_SEGMENTS");
    let size = 0;
    for (const s of list) {
      object(s, ["channel", "visibility", "content"]);
      string(s.content, APP_LIMITS.messageChars, false);
      size += s.content.length;
      if (
        !CHANNELS.includes(s.channel) ||
        !VISIBILITIES.includes(s.visibility) ||
        ["public_message", "shared_summary"].includes(s.channel) !==
          (s.visibility === "public")
      )
        throw new AppError("INVALID_SEGMENTS");
      if (
        role === "user" &&
        !this.#importBatch &&
        (s.channel !== "public_message" || s.visibility !== "public")
      )
        throw new AppError("INVALID_SEGMENTS");
    }
    if (size > APP_LIMITS.messageChars)
      throw new AppError("INPUT_TOO_LARGE", 413);
    return list;
  }
  #writeRevision(
    actor: Actor,
    roomId: string,
    message: Row,
    segments: SegmentInput[],
    revision: number,
    parent: number | null,
    reason: string,
    attachmentIds: string[] = [],
  ): void {
    if (
      attachmentIds.length > APP_LIMITS.attachmentsPerMessage ||
      new Set(attachmentIds).size !== attachmentIds.length
    )
      throw new AppError("ATTACHMENT_LIMIT", 413);
    this.app.db
      .prepare("INSERT INTO message_revisions VALUES(?,?,?,?,?,?,?,?,?)")
      .run(
        actor.workspaceId,
        roomId,
        message.message_id,
        revision,
        id(),
        parent,
        digest(canonical(segments)),
        reason,
        Date.now(),
      );
    for (const s of segments)
      this.app.db
        .prepare("INSERT INTO message_segments VALUES(?,?,?,?,?,?,?,?,?,?)")
        .run(
          actor.workspaceId,
          roomId,
          message.message_id,
          revision,
          id(),
          s.channel,
          s.visibility,
          message.persona_id ?? null,
          s.content,
          digest(s.content),
        );
    for (const attachmentId of attachmentIds) {
      const a = this.app.db
        .prepare(
          "SELECT * FROM attachments WHERE workspace_id=? AND room_id=? AND attachment_id=? AND state='AVAILABLE' AND deleted_at IS NULL",
        )
        .get(actor.workspaceId, roomId, string(attachmentId, 100));
      if (!a || a.owner_actor_id !== actor.actorId)
        throw new AppError("ATTACHMENT_NOT_AVAILABLE", 404);
      this.app.db
        .prepare("INSERT INTO attachment_links VALUES(?,?,?,?,?)")
        .run(
          actor.workspaceId,
          roomId,
          message.message_id,
          revision,
          attachmentId,
        );
    }
  }
  appendMessage(actor: Actor, roomId: string, input: MessageInput): MessageDTO {
    this.#assert(
      actor,
      input.role === "model" ? "GENERATE" : "WRITE_MESSAGE",
      roomId,
      input.personaId,
    );
    if (
      !["user", "model"].includes(input.role) ||
      (input.role === "model" && !input.personaId && !this.#importBatch) ||
      (input.role === "user" && input.personaId)
    )
      throw new AppError("INVALID_INPUT");
    const segments = this.#segments(input, input.role);
    return this.app.transaction(() => {
      const room = this.#room(actor, roomId);
      if (input.personaId) this.getPersona(actor, roomId, input.personaId);
      const messageId = input.messageId ?? id(),
        now = Date.now(),
        occurredAt =
          input.occurredAt === undefined
            ? now
            : integer(input.occurredAt, 0, 8640000000000000);
      this.app.db
        .prepare("INSERT INTO messages VALUES(?,?,?,?,1,?,?,?,?,?,NULL)")
        .run(
          actor.workspaceId,
          roomId,
          messageId,
          room.next_seq,
          input.role,
          input.personaId ?? null,
          occurredAt,
          now,
          now,
        );
      this.app.db
        .prepare(
          "UPDATE rooms SET next_seq=next_seq+1,modified_at=? WHERE workspace_id=? AND room_id=?",
        )
        .run(now, actor.workspaceId, roomId);
      this.#writeRevision(
        actor,
        roomId,
        { message_id: messageId, persona_id: input.personaId },
        segments,
        1,
        null,
        input.reason ?? "initial",
        input.attachmentIds,
      );
      this.app.audit(
        actor.actorId,
        actor.workspaceId,
        "WRITE_MESSAGE",
        messageId,
      );
      this.app.change(
        actor.workspaceId,
        roomId,
        "MESSAGE",
        messageId,
        1,
        "CREATE",
      );
      return this.#dto(actor, this.#messageRow(actor, roomId, messageId));
    }, "message_accept");
  }
  #messageRow(actor: Actor, roomId: string, messageId: string): Row {
    const row = this.app.db
      .prepare(
        "SELECT m.* FROM messages m WHERE workspace_id=? AND room_id=? AND message_id=? AND deleted_at IS NULL AND (persona_id IS NULL OR EXISTS(SELECT 1 FROM personas p WHERE p.workspace_id=m.workspace_id AND p.persona_id=m.persona_id AND p.deleted_at IS NULL))",
      )
      .get(actor.workspaceId, roomId, messageId) as Row | undefined;
    if (!row) throw new AppError("NOT_FOUND", 404);
    return row;
  }
  #dto(actor: Actor, row: Row, revision?: number): MessageDTO {
    const rev = this.app.db
      .prepare(
        "SELECT * FROM message_revisions WHERE workspace_id=? AND room_id=? AND message_id=? AND revision=?",
      )
      .get(
        actor.workspaceId,
        row.room_id,
        row.message_id,
        revision ?? row.current_revision,
      ) as Row | undefined;
    if (!rev) throw new AppError("NOT_FOUND", 404);
    const segments = this.app.db
      .prepare(
        "SELECT segment_id,channel,visibility,content,digest FROM message_segments WHERE workspace_id=? AND room_id=? AND message_id=? AND revision=? AND visibility='public' ORDER BY rowid",
      )
      .all(
        actor.workspaceId,
        row.room_id,
        row.message_id,
        rev.revision,
      ) as Row[];
    const attachments = this.app.db
      .prepare(
        "SELECT a.* FROM attachment_links l JOIN attachments a USING(workspace_id,room_id,attachment_id) WHERE l.workspace_id=? AND l.room_id=? AND l.message_id=? AND l.revision=? AND a.state='AVAILABLE' AND a.deleted_at IS NULL",
      )
      .all(
        actor.workspaceId,
        row.room_id,
        row.message_id,
        rev.revision,
      ) as Row[];
    return {
      id: row.message_id,
      revision: rev.revision,
      revisionId: rev.revision_id,
      ...(rev.parent_revision ? { parentRevision: rev.parent_revision } : {}),
      role: row.role,
      ...(row.persona_id ? { agentId: row.persona_id } : {}),
      content: segments
        .filter((s) => s.channel === "public_message")
        .map((s) => s.content)
        .join("\n"),
      timestamp: row.occurred_at,
      occurredAt: row.occurred_at,
      ingestedAt: row.ingested_at,
      modifiedAt: row.modified_at,
      segments: segments.map((s) => ({
        id: s.segment_id,
        channel: s.channel,
        visibility: s.visibility,
        content: s.content,
        digest: s.digest,
      })),
      attachments:
        segments.length && this.#can(actor, "READ_ATTACHMENT", row.room_id)
          ? attachments.map(attachmentDTO)
          : [],
    };
  }
  getMessage(
    actor: Actor,
    roomId: string,
    messageId: string,
    revision?: number,
  ): MessageDTO {
    this.#assert(actor, "READ_CONVERSATION", roomId);
    this.#room(actor, roomId);
    if (revision !== undefined) integer(revision);
    const dto = this.#dto(
      actor,
      this.#messageRow(actor, roomId, messageId),
      revision,
    );
    if (!dto.segments.length) throw new AppError("NOT_FOUND", 404);
    return dto;
  }
  #acl(actor: Actor): number {
    return Number(
      this.app.db
        .prepare("SELECT acl_revision FROM workspaces WHERE workspace_id=?")
        .get(actor.workspaceId)?.acl_revision ?? 0,
    );
  }
  #cursor(actor: Actor, roomId: string, seq: number): string {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.app.cursorKey, iv),
      data = Buffer.from(
        JSON.stringify({
          actorId: actor.actorId,
          workspaceId: actor.workspaceId,
          roomId,
          acl: this.#acl(actor),
          seq,
          expires: Date.now() + 1800000,
        }),
      );
    const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
      "base64url",
    );
  }
  #decodeCursor(actor: Actor, roomId: string, cursor: string): number {
    try {
      string(cursor, 2000);
      const b = Buffer.from(cursor, "base64url"),
        decipher = createDecipheriv(
          "aes-256-gcm",
          this.app.cursorKey,
          b.subarray(0, 12),
        );
      decipher.setAuthTag(b.subarray(12, 28));
      const parsed = JSON.parse(
        Buffer.concat([
          decipher.update(b.subarray(28)),
          decipher.final(),
        ]).toString(),
      );
      if (
        parsed.actorId !== actor.actorId ||
        parsed.workspaceId !== actor.workspaceId ||
        parsed.roomId !== roomId ||
        parsed.acl !== this.#acl(actor) ||
        parsed.expires < Date.now()
      )
        throw new Error();
      return integer(parsed.seq);
    } catch {
      throw new AppError("INVALID_CURSOR", 409);
    }
  }
  listMessages(
    actor: Actor,
    roomId: string,
    options: { limit?: number; cursor?: string } = {},
  ): MessagePage {
    this.#assert(actor, "READ_CONVERSATION", roomId);
    this.#room(actor, roomId);
    object(options, ["limit", "cursor"]);
    const limit =
        options.limit === undefined
          ? APP_LIMITS.pageSize
          : integer(options.limit, 1, APP_LIMITS.maxPageSize),
      seq = options.cursor
        ? this.#decodeCursor(actor, roomId, options.cursor)
        : Number.MAX_SAFE_INTEGER;
    const rows = this.app.db
      .prepare(
        "SELECT m.* FROM messages m WHERE workspace_id=? AND room_id=? AND deleted_at IS NULL AND seq<? AND (persona_id IS NULL OR EXISTS(SELECT 1 FROM personas p WHERE p.workspace_id=m.workspace_id AND p.persona_id=m.persona_id AND p.deleted_at IS NULL)) AND EXISTS(SELECT 1 FROM message_segments s WHERE s.workspace_id=m.workspace_id AND s.room_id=m.room_id AND s.message_id=m.message_id AND s.revision=m.current_revision AND s.visibility='public') ORDER BY seq DESC LIMIT ?",
      )
      .all(actor.workspaceId, roomId, seq, limit + 1) as Row[];
    const shown = rows.slice(0, limit);
    return {
      messages: shown.map((r) => this.#dto(actor, r)).reverse(),
      ...(rows.length > limit
        ? { cursor: this.#cursor(actor, roomId, shown.at(-1)!.seq) }
        : {}),
    };
  }
  history(actor: Actor, roomId: string, messageId: string): MessageDTO[] {
    this.#assert(actor, "READ_CONVERSATION", roomId);
    this.#room(actor, roomId);
    const row = this.#messageRow(actor, roomId, messageId);
    const revisions = this.app.db
      .prepare(
        "SELECT revision FROM message_revisions WHERE workspace_id=? AND room_id=? AND message_id=? ORDER BY revision DESC LIMIT 200",
      )
      .all(actor.workspaceId, roomId, messageId) as Row[];
    return revisions
      .map((r) => this.#dto(actor, row, r.revision))
      .filter((r) => r.segments.length > 0);
  }
  readSegments(
    actor: Actor,
    roomId: string,
    messageId: string,
    revision?: number | string,
  ) {
    let number = revision;
    if (typeof revision === "string") {
      const row = this.app.db
        .prepare(
          "SELECT revision FROM message_revisions WHERE workspace_id=? AND room_id=? AND message_id=? AND revision_id=?",
        )
        .get(actor.workspaceId, roomId, messageId, revision);
      if (!row) throw new AppError("NOT_FOUND", 404);
      number = Number(row.revision);
    }
    return this.readPrivateSegments(
      actor,
      roomId,
      messageId,
      number as number | undefined,
    );
  }
  readPrivateSegments(
    actor: Actor,
    roomId: string,
    messageId: string,
    revision?: number,
  ) {
    this.policy.assert(actor, "READ_CONVERSATION", { roomId });
    this.#room(actor, roomId);
    const message = this.#messageRow(actor, roomId, messageId);
    const rev = revision ?? message.current_revision;
    integer(rev);
    const rows = this.app.db
      .prepare(
        "SELECT * FROM message_segments WHERE workspace_id=? AND room_id=? AND message_id=? AND revision=? AND visibility<>'public'",
      )
      .all(actor.workspaceId, roomId, messageId, rev) as Row[];
    return rows
      .filter((s) =>
        this.policy.canReadSegment(actor, {
          workspaceId: actor.workspaceId,
          roomId,
          ownerPersonaId: s.owner_persona_id ?? undefined,
          channel: s.channel,
          visibility: s.visibility,
        }),
      )
      .map((s) => ({
        id: s.segment_id,
        channel: s.channel,
        visibility: s.visibility,
        content: s.content,
        digest: s.digest,
      }));
  }
  appendRevision(
    actor: Actor,
    roomId: string,
    messageId: string,
    input: {
      expectedRevision: number;
      content?: string;
      segments?: SegmentInput[];
      reason: "regeneration" | "correction";
      attachmentIds?: string[];
    },
  ): MessageDTO {
    const row = this.#messageRow(actor, roomId, messageId);
    this.#assert(
      actor,
      row.role === "model" ? "GENERATE" : "WRITE_MESSAGE",
      roomId,
      row.persona_id ?? undefined,
    );
    object(input, [
      "expectedRevision",
      "content",
      "segments",
      "reason",
      "attachmentIds",
    ]);
    const segments = this.#segments(input, row.role);
    return this.app.transaction(() => {
      this.#room(actor, roomId);
      const current = this.#messageRow(actor, roomId, messageId);
      if (current.current_revision !== integer(input.expectedRevision))
        throw new AppError("REVISION_CONFLICT", 409);
      const revision = current.current_revision + 1;
      const attachments =
        input.attachmentIds ??
        (
          this.app.db
            .prepare(
              "SELECT attachment_id FROM attachment_links WHERE workspace_id=? AND room_id=? AND message_id=? AND revision=?",
            )
            .all(
              actor.workspaceId,
              roomId,
              messageId,
              current.current_revision,
            ) as Row[]
        ).map((a) => a.attachment_id);
      this.#writeRevision(
        actor,
        roomId,
        current,
        segments,
        revision,
        current.current_revision,
        input.reason,
        attachments,
      );
      this.app.db
        .prepare(
          "UPDATE messages SET current_revision=?,modified_at=? WHERE workspace_id=? AND room_id=? AND message_id=?",
        )
        .run(revision, Date.now(), actor.workspaceId, roomId, messageId);
      this.app.audit(
        actor.actorId,
        actor.workspaceId,
        "REVISE_MESSAGE",
        messageId,
      );
      this.app.change(
        actor.workspaceId,
        roomId,
        "MESSAGE",
        messageId,
        revision,
        "UPDATE",
      );
      return this.#dto(actor, this.#messageRow(actor, roomId, messageId));
    }, "message_revision");
  }
  correctMessage(
    actor: Actor,
    roomId: string,
    messageId: string,
    input: { expectedRevision: number; content: string },
  ): MessageDTO {
    object(input, ["expectedRevision", "content"]);
    const current = this.getMessage(actor, roomId, messageId);
    if (current.role !== "user") throw new AppError("USE_REGENERATION", 409);
    return this.appendRevision(actor, roomId, messageId, {
      ...input,
      reason: "correction",
    });
  }
  deleteMessage(
    actor: Actor,
    roomId: string,
    messageId: string,
    input: { expectedRevision: number },
  ): void {
    this.#assert(actor, "WRITE_MESSAGE", roomId);
    object(input, ["expectedRevision"]);
    this.app.transaction(() => {
      this.#room(actor, roomId);
      const row = this.#messageRow(actor, roomId, messageId);
      if (row.current_revision !== integer(input.expectedRevision))
        throw new AppError("REVISION_CONFLICT", 409);
      this.app.db
        .prepare(
          "UPDATE messages SET deleted_at=? WHERE workspace_id=? AND room_id=? AND message_id=?",
        )
        .run(Date.now(), actor.workspaceId, roomId, messageId);
      this.app.audit(
        actor.actorId,
        actor.workspaceId,
        "DELETE_MESSAGE",
        messageId,
      );
      this.app.change(
        actor.workspaceId,
        roomId,
        "MESSAGE",
        messageId,
        row.current_revision,
        "DELETE",
      );
    });
  }
}
