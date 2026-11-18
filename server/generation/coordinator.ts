import { randomUUID } from "node:crypto";
import { securePolicy } from "../app-data/validation";
import { performance } from "node:perf_hooks";
import {
  ContextCompiler,
  digest,
  type CompiledContext,
  type PrivateReportRef,
} from "./context";
import {
  DEFAULT_GENERATION_LIMITS,
  GenerationError,
  stable,
  exact,
  safeInput,
  type Actor,
  type AppDatabasePort,
  type PolicyPort,
  type RepositoryPort,
  type CoordinatorOptions,
  type GenerationLimits,
  type TurnRequest,
} from "./types";
import type { ProviderRequest, ProviderResult } from "./provider";
import { applyInitialUserTurnFallback } from "../../utils/responseFallback";

const terminal = new Set([
  "COMPLETED",
  "PARTIAL",
  "FAILED",
  "CANCELLED",
  "NEEDS_REVIEW",
]);
const reactions = new Set([
  "ACK",
  "AGREE",
  "THINK",
  "AMUSED",
  "CARE",
  "DISAGREE",
]);
function immutable<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (v: any) => {
    if (v && typeof v === "object") {
      for (const child of Object.values(v)) freeze(child);
      Object.freeze(v);
    }
  };
  freeze(copy);
  return copy;
}
function validId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
function outputSegments(
  raw: string,
  memory: boolean,
  separated: boolean,
): any[] {
  if (raw.length > 131072 || !raw.trim())
    throw new GenerationError("INVALID_OUTPUT");
  if (!memory && !separated) {
    if (raw.length > 32768) throw new GenerationError("INVALID_OUTPUT");
    return [{ channel: "public_message", visibility: "public", content: raw }];
  }
  let object: any;
  try {
    object = JSON.parse(raw);
  } catch {
    throw new GenerationError("INVALID_OUTPUT");
  }
  exact(
    object,
    memory
      ? ["memory_export"]
      : [
          "public_message",
          "private_state",
          "shared_summary",
          "debug_thoughts",
          "gm_log",
          "memory_export",
        ],
  );
  const segments: any[] = [];
  for (const [channel, visibility] of [
    ["public_message", "public"],
    ["private_state", "self_only"],
    ["shared_summary", "public"],
    ["debug_thoughts", "developer_only"],
    ["gm_log", "gm_only"],
  ]) {
    const value = object[channel];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.length > 65536)
      throw new GenerationError("INVALID_OUTPUT");
    if (value.trim()) segments.push({ channel, visibility, content: value });
  }
  if (!memory && !segments.some((s) => s.channel === "public_message"))
    throw new GenerationError("INVALID_OUTPUT");
  if (object.memory_export !== undefined) {
    if (
      !Array.isArray(object.memory_export) ||
      object.memory_export.length > 16
    )
      throw new GenerationError("INVALID_OUTPUT");
    for (const entry of object.memory_export) {
      exact(entry, ["visibility", "content"]);
      if (
        !["self_only", "self_and_gm", "gm_only"].includes(entry.visibility) ||
        (memory && entry.visibility !== "self_only") ||
        typeof entry.content !== "string" ||
        !entry.content.trim() ||
        entry.content.length > 65536
      )
        throw new GenerationError("INVALID_OUTPUT");
      segments.push({
        channel: "memory_export",
        visibility: entry.visibility,
        content: entry.content,
      });
    }
  }
  if (
    segments.length > 16 ||
    segments.reduce((sum, segment) => sum + segment.content.length, 0) > 32768
  )
    throw new GenerationError("INVALID_OUTPUT");
  if (memory && !segments.length) throw new GenerationError("INVALID_OUTPUT");
  return segments;
}
export class GenerationCoordinator {
  readonly limits: GenerationLimits;
  readonly compiler: ContextCompiler;
  private closing = false;
  private stopped = false;
  private readonly completions = new Map<
    string,
    { promise: Promise<void>; resolve: () => void }
  >();
  private readonly owner = randomUUID();
  private readonly pending = new Set<string>();
  private pendingTimer?: ReturnType<typeof setTimeout>;
  private readonly running = new Map<string, AbortController>();
  private readonly wall: () => number;
  private readonly mono: () => number;
  constructor(
    private app: AppDatabasePort,
    private repository: RepositoryPort,
    private policy: PolicyPort,
    private options: CoordinatorOptions,
  ) {
    this.policy = securePolicy(policy) as PolicyPort;
    this.limits = { ...DEFAULT_GENERATION_LIMITS, ...options.limits };
    for (const [key, value] of Object.entries(this.limits)) {
      if (
        !Number.isSafeInteger(value) ||
        value <= 0 ||
        value > (DEFAULT_GENERATION_LIMITS as any)[key]
      )
        throw new GenerationError("INVALID_LIMIT_CONFIGURATION");
    }
    if (!options.provider.supports(options.defaultModel))
      throw new GenerationError("MODEL_NOT_ALLOWED");
    if (
      options.pricing &&
      (!options.pricing.version ||
        ![
          options.pricing.inputMicrosPerMillion,
          options.pricing.outputMicrosPerMillion,
        ].every((v) => Number.isFinite(v) && v >= 0))
    )
      throw new GenerationError("INVALID_PRICING");
    this.wall = options.now ?? Date.now;
    this.mono = options.monotonic ?? (() => performance.now());
    this.compiler = new ContextCompiler(
      app,
      repository,
      this.policy,
      this.limits,
      options.attachmentStore,
    );
  }
  private assert(
    actor: Actor,
    operation: string,
    roomId: string,
    personaId?: string,
  ) {
    this.policy.assert(
      immutable(actor),
      operation,
      immutable({ workspaceId: actor.workspaceId, roomId, personaId }),
    );
  }
  private audit(actor: Actor, roomId: string, event: string, target: string) {
    // Fixed codes and references only. Owned schema separate from conversation audit.
    this.app.db
      .prepare(
        "INSERT INTO app_generation_audit(audit_id,workspace_id,room_id,actor_id,event,target_id,created_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        randomUUID(),
        actor.workspaceId,
        roomId,
        actor.actorId,
        event,
        target,
        this.wall(),
      );
  }
  private normalizeRequest(input: TurnRequest): TurnRequest {
    safeInput(input);
    exact(input, [
      "requestId",
      "expectedRoomRevision",
      "content",
      "attachmentIds",
      "recipient",
    ]);
    if (
      !validId(input.requestId) ||
      !Number.isSafeInteger(input.expectedRoomRevision) ||
      input.expectedRoomRevision < 1 ||
      typeof input.content !== "string" ||
      input.content.length > 32768 ||
      (!input.content.trim() && !input.attachmentIds?.length)
    )
      throw new GenerationError("INVALID_INPUT");
    if (
      input.attachmentIds !== undefined &&
      (!Array.isArray(input.attachmentIds) ||
        input.attachmentIds.length > 8 ||
        input.attachmentIds.some((id) => !validId(id)) ||
        new Set(input.attachmentIds).size !== input.attachmentIds.length)
    )
      throw new GenerationError("INVALID_INPUT");
    if (input.recipient) {
      exact(input.recipient, ["type", "agentIds", "groupId"]);
      if (
        !["auto", "agent", "group", "all"].includes(input.recipient.type) ||
        (input.recipient.agentIds !== undefined &&
          (!Array.isArray(input.recipient.agentIds) ||
            input.recipient.agentIds.length > 8 ||
            input.recipient.agentIds.some((id) => !validId(id)))) ||
        (input.recipient.groupId !== undefined &&
          (typeof input.recipient.groupId !== "string" ||
            input.recipient.groupId.length > 80))
      )
        throw new GenerationError("INVALID_INPUT");
    }
    return structuredClone(input);
  }
  accept(actor: Actor, roomId: string, input: TurnRequest): any {
    if (this.closing) throw new GenerationError("SERVER_STOPPING", 503);
    input = this.normalizeRequest(input);
    this.assert(actor, "WRITE_MESSAGE", roomId);
    this.assert(actor, "READ_CONVERSATION", roomId);
    this.assert(actor, "GENERATE", roomId);
    const payloadDigest = digest(stable({ roomId, ...input }));
    let newlyAccepted = false;
    const runId = this.app.transaction(() => {
      const old = this.app.db
        .prepare(
          "SELECT t.input_digest,r.run_id FROM app_turns t JOIN app_generation_runs r USING(workspace_id,room_id,turn_id) WHERE t.workspace_id=? AND t.actor_id=? AND t.operation=? AND t.request_id=?",
        )
        .get(actor.workspaceId, actor.actorId, "turn", input.requestId) as any;
      if (old) {
        if (old.input_digest !== payloadDigest)
          throw new GenerationError("REQUEST_CONFLICT", 409);
        return old.run_id;
      }
      const room = this.repository.getRoom(actor, roomId);
      if (room.revision !== input.expectedRoomRevision)
        throw new GenerationError("REVISION_CONFLICT", 409);
      const personas = room.agents;
      if (personas.length > this.limits.maxPersonas)
        throw new GenerationError("PERSONA_LIMIT", 413);
      const active = personas.filter(
        (p: any) => p.isEnabled !== false && !p.historicalIdentity,
      );

      for (const persona of active) {
        this.assert(actor, "GENERATE", roomId, persona.id);
        this.policy.assert(
          immutable(actor),
          "SEND_TO_PROVIDER",
          immutable({
            workspaceId: actor.workspaceId,
            roomId,
            personaId: persona.id,
            provider: this.options.provider.name,
          }),
        );
        const model = persona.model || this.options.defaultModel;
        if (!this.options.provider.supports(model))
          throw new GenerationError("MODEL_NOT_ALLOWED", 409);
      }
      const recipient = input.recipient ?? { type: "auto" };
      if (recipient.type === "group") {
        const group = active.filter((p) =>
          p.groups?.includes(recipient.groupId),
        );
        if (!group.length)
          throw new GenerationError("RECIPIENT_NOT_FOUND", 404);
        recipient.agentIds = group.map((p) => p.id);
      }
      if (recipient.type === "all")
        recipient.agentIds = active.map((p) => p.id);
      if (
        recipient.type === "agent" &&
        (!recipient.agentIds?.length ||
          recipient.agentIds.some((id) => !active.some((p) => p.id === id)))
      )
        throw new GenerationError("RECIPIENT_NOT_FOUND", 404);
      const outstanding = this.app.db
        .prepare(
          "SELECT COUNT(*) n FROM app_generation_runs WHERE workspace_id=? AND state IN ('QUEUED','RUNNING')",
        )
        .get(actor.workspaceId) as any;
      if (Number(outstanding.n) >= 64)
        throw new GenerationError("QUEUE_FULL", 429);
      const now = this.wall();
      const id = randomUUID();
      const turnId = randomUUID();
      const message = this.repository.appendMessage(actor, roomId, {
        role: "user",
        content: input.content,
        attachmentIds: input.attachmentIds ?? [],
      });
      const source = this.app.db
        .prepare(
          "SELECT seq,current_revision FROM messages WHERE workspace_id=? AND room_id=? AND message_id=?",
        )
        .get(actor.workspaceId, roomId, message.id) as any;
      this.app.db
        .prepare("INSERT INTO app_turns VALUES(?,?,?,?,?,?,?,?,?)")
        .run(
          actor.workspaceId,
          roomId,
          turnId,
          actor.actorId,
          input.requestId,
          "turn",
          payloadDigest,
          message.id,
          now,
        );
      this.app.db
        .prepare(
          `INSERT INTO app_generation_runs(workspace_id,room_id,run_id,turn_id,actor_id,session_id,state,request_json,accepted_at,dispatch_before,deadline_at,collect_before,limits_json) VALUES(?,?,?,?,?,?,'QUEUED',?,?,?,?,?,?)`,
        )
        .run(
          actor.workspaceId,
          roomId,
          id,
          turnId,
          actor.actorId,
          actor.sessionId ?? null,
          stable({
            ...input,
            recipient,
            personaIds: active.map((p) => p.id),
            personaRevisions: Object.fromEntries(
              active.map((p) => [p.id, p.revision]),
            ),
            inputBinding: {
              messageId: message.id,
              revision: Number(source.current_revision),
              seq: Number(source.seq),
            },
          }),
          now,
          now + this.limits.dispatchMs,
          now + this.limits.deadlineMs,
          now + this.limits.collectionMs,
          stable(this.limits),
        );
      this.audit(actor, roomId, "TURN_ACCEPTED", id);
      this.options.hooks?.beforeAcceptCommit?.();
      newlyAccepted = true;
      return id;
    });
    if (newlyAccepted) this.options.hooks?.afterAcceptCommit?.();
    return { ...this.get(actor, roomId, runId), newlyAccepted };
  }
  get(actor: Actor, roomId: string, runId: string): any {
    this.assert(actor, "READ_CONVERSATION", roomId);
    this.repository.getRoom(actor, roomId);
    const outputAcl = this.policy.revision(actor);
    const run = this.app.db
      .prepare(
        "SELECT r.*,t.input_message_id FROM app_generation_runs r JOIN app_turns t USING(workspace_id,room_id,turn_id) WHERE r.workspace_id=? AND r.room_id=? AND r.run_id=?",
      )
      .get(actor.workspaceId, roomId, runId) as any;
    if (!run) throw new GenerationError("NOT_FOUND", 404);
    // The same public output reader serves first acknowledgement, polls and repeats.
    const canSeePersona = (personaId: string) => {
      try {
        this.repository.getPersona(actor, roomId, personaId);
        return true;
      } catch {
        return false;
      }
    };
    const calls = (
      this.app.db
        .prepare(
          "SELECT call_id,persona_id,purpose,provider,model,state,usage_state,usage_json,reserved_input_tokens,reserved_output_tokens,reserved_cost_micros,actual_cost_micros,pricing_version,reason FROM app_provider_calls WHERE workspace_id=? AND room_id=? AND run_id=? ORDER BY ordinal",
        )
        .all(actor.workspaceId, roomId, runId) as any[]
    ).filter(
      (c) =>
        canSeePersona(c.persona_id) &&
        ((c.purpose !== "subagent" && c.purpose !== "memory") ||
          this.policy.canReadSegment(
            immutable(actor),
            immutable({
              workspaceId: actor.workspaceId,
              roomId,
              ownerPersonaId: c.persona_id,
              channel:
                c.purpose === "memory" ? "memory_export" : "debug_thoughts",
              visibility:
                c.purpose === "memory" ? "self_only" : "developer_only",
            }),
          )),
    );
    const results: any[] = [];
    for (const row of this.app.db
      .prepare(
        "SELECT message_id,revision FROM app_generation_receipts WHERE workspace_id=? AND room_id=? AND run_id=? AND message_id IS NOT NULL",
      )
      .all(actor.workspaceId, roomId, runId) as any[]) {
      try {
        results.push(
          this.repository.getMessage(
            actor,
            roomId,
            row.message_id,
            row.revision,
          ),
        );
      } catch (error) {
        if (
          (error as any).status !== 404 &&
          !["NOT_FOUND", "FORBIDDEN"].includes((error as any).code)
        )
          throw error;
      }
    }
    const decisions = (
      this.app.db
        .prepare(
          "SELECT decision_id,persona_id,outcome,source,reaction,created_at FROM app_decisions WHERE workspace_id=? AND room_id=? AND run_id=?",
        )
        .all(actor.workspaceId, roomId, runId) as any[]
    )
      .filter((d) => canSeePersona(d.persona_id))
      .map((d) => ({
        id: d.decision_id,
        agentId: d.persona_id,
        outcome: d.outcome,
        source: d.source,
        reaction: d.reaction,
        timestamp: d.created_at,
        turnId: run.turn_id,
      }));
    const stamps = (
      this.app.db
        .prepare(
          "SELECT reaction_id,message_id,persona_id,semantic,created_at FROM app_reactions WHERE workspace_id=? AND room_id=? AND run_id=?",
        )
        .all(actor.workspaceId, roomId, runId) as any[]
    )
      .filter((r) => canSeePersona(r.persona_id))
      .map((r) => ({
        id: r.reaction_id,
        messageId: r.message_id,
        agentId: r.persona_id,
        semantic: r.semantic,
        timestamp: r.created_at,
        turnId: run.turn_id,
      }));
    this.assert(actor, "READ_CONVERSATION", roomId);
    if (this.policy.revision(actor) !== outputAcl)
      throw new GenerationError("AUTHORIZATION_CHANGED", 409);
    return immutable({
      id: runId,
      runId,
      turnId: run.turn_id,
      roomId,
      inputMessageId: run.input_message_id,
      status: run.state,
      newlyAccepted: false,
      errorCode: run.error_code ?? undefined,
      callCount: calls.length,
      usage: calls.map((c) => ({
        callId: c.call_id,
        personaId: c.persona_id,
        purpose: c.purpose,
        provider: c.provider,
        model: c.model,
        state: c.state,
        completeness: c.usage_state,
        usage: c.usage_json ? JSON.parse(c.usage_json) : null,
        reservedInputTokens: c.reserved_input_tokens,
        reservedOutputTokens: c.reserved_output_tokens,
        reservedCostMicros: c.reserved_cost_micros,
        actualCostMicros: c.actual_cost_micros,
        pricingVersion: c.pricing_version,
        reason: c.reason,
      })),
      results,
      decisions,
      reactions: stamps,
    });
  }
  readInternal(actor: Actor, roomId: string, runId: string) {
    this.assert(actor, "READ_CONVERSATION", roomId);
    this.repository.getRoom(actor, roomId);
    const acl = this.policy.revision(actor);
    const run = this.app.db
      .prepare(
        "SELECT 1 FROM app_generation_runs WHERE workspace_id=? AND room_id=? AND run_id=?",
      )
      .get(actor.workspaceId, roomId, runId);
    if (!run) throw new GenerationError("NOT_FOUND", 404);
    const rows = this.app.db
      .prepare(
        `SELECT s.*,r.revision_id FROM app_generation_receipts receipt JOIN messages m ON m.workspace_id=receipt.workspace_id AND m.room_id=receipt.room_id AND m.message_id=receipt.message_id JOIN message_revisions r ON r.workspace_id=receipt.workspace_id AND r.room_id=receipt.room_id AND r.message_id=receipt.message_id AND r.revision=receipt.revision JOIN message_segments s ON s.workspace_id=r.workspace_id AND s.room_id=r.room_id AND s.message_id=r.message_id AND s.revision=r.revision JOIN personas p ON p.workspace_id=m.workspace_id AND p.persona_id=m.persona_id WHERE receipt.workspace_id=? AND receipt.room_id=? AND receipt.run_id=? AND m.deleted_at IS NULL AND p.deleted_at IS NULL AND s.visibility<>'public' LIMIT 641`,
      )
      .all(actor.workspaceId, roomId, runId) as any[];
    if (rows.length > 640) throw new GenerationError("RESULT_LIMIT", 413);
    const segments = rows
      .filter((s) =>
        this.policy.canReadSegment(
          immutable(actor),
          immutable({
            workspaceId: actor.workspaceId,
            roomId,
            ownerPersonaId: s.owner_persona_id,
            channel: s.channel,
            visibility: s.visibility,
          }),
        ),
      )
      .map((s) => ({
        id: s.segment_id,
        messageId: s.message_id,
        revision: s.revision,
        revisionId: s.revision_id,
        ownerPersonaId: s.owner_persona_id,
        channel: s.channel,
        visibility: s.visibility,
        content: s.content,
        digest: s.digest,
      }));
    this.assert(actor, "READ_CONVERSATION", roomId);
    if (this.policy.revision(actor) !== acl)
      throw new GenerationError("AUTHORIZATION_CHANGED", 409);
    return immutable({ runId, segments });
  }
  list(actor: Actor, roomId: string) {
    this.assert(actor, "READ_CONVERSATION", roomId);
    return (
      this.app.db
        .prepare(
          "SELECT run_id FROM app_generation_runs WHERE workspace_id=? AND room_id=? ORDER BY accepted_at DESC LIMIT 50",
        )
        .all(actor.workspaceId, roomId) as any[]
    ).map((r) => this.get(actor, roomId, r.run_id));
  }
  cancel(actor: Actor, roomId: string, runId: string) {
    this.assert(actor, "CANCEL_GENERATION", roomId);
    this.assert(actor, "READ_CONVERSATION", roomId);
    this.repository.getRoom(actor, roomId);
    this.app.transaction(() => {
      const run = this.app.db
        .prepare(
          "SELECT state FROM app_generation_runs WHERE workspace_id=? AND room_id=? AND run_id=?",
        )
        .get(actor.workspaceId, roomId, runId) as any;
      if (!run) throw new GenerationError("NOT_FOUND", 404);
      if (!terminal.has(run.state)) {
        this.app.db
          .prepare(
            "UPDATE app_generation_runs SET state='CANCELLED',cancelled_at=? WHERE workspace_id=? AND room_id=? AND run_id=?",
          )
          .run(this.wall(), actor.workspaceId, roomId, runId);
        this.audit(actor, roomId, "GENERATION_CANCELLED", runId);
      }
    });
    this.running.get(runId)?.abort();
    return this.get(actor, roomId, runId);
  }
  regenerate(
    actor: Actor,
    roomId: string,
    messageId: string,
    input: { requestId: string; expectedRevision: number },
  ) {
    if (this.closing) throw new GenerationError("SERVER_STOPPING", 503);
    safeInput(input);
    exact(input, ["requestId", "expectedRevision"]);
    if (
      !validId(input.requestId) ||
      !Number.isSafeInteger(input.expectedRevision)
    )
      throw new GenerationError("INVALID_INPUT");
    this.assert(actor, "GENERATE", roomId);
    let newlyAccepted = false;
    const requestDigest = digest(stable({ roomId, messageId, ...input }));
    const id = this.app.transaction(() => {
      const prior = this.app.db
        .prepare(
          "SELECT t.input_digest,r.run_id FROM app_turns t JOIN app_generation_runs r USING(workspace_id,room_id,turn_id) WHERE t.workspace_id=? AND t.actor_id=? AND t.operation=? AND t.request_id=?",
        )
        .get(
          actor.workspaceId,
          actor.actorId,
          "regenerate",
          input.requestId,
        ) as any;
      if (prior) {
        if (prior.input_digest !== requestDigest)
          throw new GenerationError("REQUEST_CONFLICT", 409);
        return prior.run_id;
      }
      const outstanding = this.app.db
        .prepare(
          "SELECT COUNT(*) n FROM app_generation_runs WHERE workspace_id=? AND state IN ('QUEUED','RUNNING')",
        )
        .get(actor.workspaceId) as any;
      if (Number(outstanding.n) >= 64)
        throw new GenerationError("QUEUE_FULL", 429);
      const message = this.repository.getMessage(actor, roomId, messageId);
      if (
        message.role !== "model" ||
        message.revision !== input.expectedRevision
      )
        throw new GenerationError("REVISION_CONFLICT", 409);
      const row = this.app.db
        .prepare(
          "SELECT persona_id FROM messages WHERE workspace_id=? AND room_id=? AND message_id=? AND deleted_at IS NULL",
        )
        .get(actor.workspaceId, roomId, messageId) as any;
      if (!row?.persona_id) throw new GenerationError("NOT_FOUND", 404);
      this.assert(actor, "GENERATE", roomId, row.persona_id);
      const parent = this.app.db
        .prepare(
          "SELECT run_id FROM app_generation_receipts WHERE workspace_id=? AND room_id=? AND message_id=? ORDER BY created_at DESC LIMIT 1",
        )
        .get(actor.workspaceId, roomId, messageId) as any;
      const priorRun = parent ? this.runRow(parent.run_id) : undefined;
      const priorRequest = priorRun
        ? JSON.parse(priorRun.request_json)
        : undefined;
      const source = this.app.db
        .prepare(
          "SELECT message_id,current_revision,seq FROM messages WHERE workspace_id=? AND room_id=? AND role='user' AND deleted_at IS NULL AND seq<(SELECT seq FROM messages WHERE workspace_id=? AND room_id=? AND message_id=?) ORDER BY seq DESC LIMIT 1",
        )
        .get(
          actor.workspaceId,
          roomId,
          actor.workspaceId,
          roomId,
          messageId,
        ) as any;
      const original = priorRequest?.inputBinding
        ? (this.app.db
            .prepare(
              "SELECT message_id,current_revision,seq FROM messages WHERE workspace_id=? AND room_id=? AND message_id=? AND deleted_at IS NULL",
            )
            .get(
              actor.workspaceId,
              roomId,
              priorRequest.inputBinding.messageId,
            ) as any)
        : source;
      const inputBinding = original
        ? {
            messageId: original.message_id,
            revision: Number(original.current_revision),
            seq: Number(original.seq),
          }
        : undefined;
      if (!inputBinding)
        throw new GenerationError("ORIGINAL_INPUT_NOT_FOUND", 409);
      const currentInput = this.repository.getMessage(
        actor,
        roomId,
        inputBinding.messageId,
      );
      const turnId = randomUUID(),
        runId = randomUUID(),
        now = this.wall();
      this.app.db
        .prepare("INSERT INTO app_turns VALUES(?,?,?,?,?,?,?,?,?)")
        .run(
          actor.workspaceId,
          roomId,
          turnId,
          actor.actorId,
          input.requestId,
          "regenerate",
          requestDigest,
          messageId,
          now,
        );
      this.app.db
        .prepare(
          `INSERT INTO app_generation_runs(workspace_id,room_id,run_id,turn_id,actor_id,session_id,state,request_json,target_message_id,parent_run_id,accepted_at,dispatch_before,deadline_at,collect_before,limits_json) VALUES(?,?,?,?,?,?,'QUEUED',?,?,?,?,?,?,?,?)`,
        )
        .run(
          actor.workspaceId,
          roomId,
          runId,
          turnId,
          actor.actorId,
          actor.sessionId ?? null,
          stable({
            ...input,
            content: currentInput.content,
            expectedRoomRevision: this.repository.getRoom(actor, roomId)
              .revision,
            personaRevisions: {
              [row.persona_id]: this.repository.getPersona(
                actor,
                roomId,
                row.persona_id,
              ).revision,
            },
            inputBinding,
            personaIds: [row.persona_id],
            recipient: { type: "agent", agentIds: [row.persona_id] },
          }),
          messageId,
          parent?.run_id ?? null,
          now,
          now + this.limits.dispatchMs,
          now + this.limits.deadlineMs,
          now + this.limits.collectionMs,
          stable(this.limits),
        );
      this.audit(actor, roomId, "REGENERATION_ACCEPTED", runId);
      newlyAccepted = true;
      return runId;
    });
    return { ...this.get(actor, roomId, id), newlyAccepted };
  }
  async shutdown(waitMs = 5000): Promise<void> {
    if (this.stopped) return;
    this.closing = true;
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = undefined;
    this.pending.clear();
    for (const controller of this.running.values()) controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all([...this.completions.values()].map((item) => item.promise)),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(1, Math.min(waitMs, 10000)));
      }),
    ]);
    if (timer) clearTimeout(timer);
    this.stopped = true;
    this.app.transaction(() => {
      this.app.db
        .prepare(
          "UPDATE app_provider_calls SET state='OUTCOME_UNKNOWN',reason='SERVER_STOPPED' WHERE owner_id=? AND state='DISPATCH_INTENT'",
        )
        .run(this.owner);
      this.app.db
        .prepare(
          "UPDATE app_generation_runs SET state='NEEDS_REVIEW',error_code='SERVER_STOPPED',completed_at=? WHERE (owner_id=? OR state='QUEUED') AND state IN ('RUNNING','QUEUED')",
        )
        .run(this.wall(), this.owner);
    });
  }
  /** Host startup diagnosis only. It never rebuilds send authority from saved intent. */
  recoverInterrupted() {
    this.app.transaction(() => {
      this.app.db
        .prepare(
          "UPDATE app_provider_calls SET state='OUTCOME_UNKNOWN',reason='PROCESS_INTERRUPTED' WHERE state='DISPATCH_INTENT'",
        )
        .run();
      this.app.db
        .prepare(
          "UPDATE app_generation_runs SET state='NEEDS_REVIEW',error_code='PROCESS_INTERRUPTED',completed_at=? WHERE state IN ('RUNNING','QUEUED')",
        )
        .run(this.wall());
    });
  }
  private runRow(runId: string): any {
    return this.app.db
      .prepare(
        "SELECT r.*,t.input_message_id FROM app_generation_runs r JOIN app_turns t USING(workspace_id,room_id,turn_id) WHERE r.run_id=?",
      )
      .get(runId);
  }
  private verifyManifest(actor: Actor, context: CompiledContext): void {
    const m = context.manifest;
    const room = this.app.db
      .prepare(
        "SELECT revision,deleted_at FROM rooms WHERE workspace_id=? AND room_id=?",
      )
      .get(actor.workspaceId, m.roomId) as any;
    if (
      !room ||
      room.deleted_at !== null ||
      Number(room.revision) !== m.roomRevision
    )
      throw new GenerationError("CONTEXT_CHANGED", 409);
    const persona = this.app.db
      .prepare(
        "SELECT p.deleted_at,rp.persona_revision FROM personas p JOIN room_personas rp USING(workspace_id,persona_id) WHERE p.workspace_id=? AND rp.room_id=? AND p.persona_id=?",
      )
      .get(actor.workspaceId, m.roomId, m.personaId) as any;
    if (
      !persona ||
      persona.deleted_at !== null ||
      Number(persona.persona_revision) !== m.personaRevision
    )
      throw new GenerationError("CONTEXT_CHANGED", 409);
    for (const ref of m.messages) {
      const source = this.app.db
        .prepare(
          "SELECT current_revision,deleted_at FROM messages m WHERE workspace_id=? AND room_id=? AND message_id=? AND (persona_id IS NULL OR EXISTS(SELECT 1 FROM personas p WHERE p.workspace_id=m.workspace_id AND p.persona_id=m.persona_id AND p.deleted_at IS NULL))",
        )
        .get(actor.workspaceId, m.roomId, ref.id) as any;
      if (
        !source ||
        source.deleted_at !== null ||
        Number(source.current_revision) !== ref.revision
      )
        throw new GenerationError("CONTEXT_CHANGED", 409);
      if (ref.speaker?.personaId) {
        const speaker = this.app.db
          .prepare(
            "SELECT rp.persona_revision FROM room_personas rp JOIN personas p USING(workspace_id,persona_id) WHERE rp.workspace_id=? AND rp.room_id=? AND rp.persona_id=? AND p.deleted_at IS NULL",
          )
          .get(actor.workspaceId, m.roomId, ref.speaker.personaId);
        if (Number(speaker?.persona_revision) !== ref.speaker.revision)
          throw new GenerationError("CONTEXT_CHANGED", 409);
      }
      for (const segment of ref.segments) {
        const saved = this.app.db
          .prepare(
            "SELECT digest FROM message_segments WHERE workspace_id=? AND room_id=? AND message_id=? AND revision=? AND segment_id=?",
          )
          .get(actor.workspaceId, m.roomId, ref.id, ref.revision, segment.id);
        if (saved?.digest !== segment.digest)
          throw new GenerationError("CONTEXT_CHANGED", 409);
      }
    }
    for (const ref of m.attachments) {
      const attachment = this.app.db
        .prepare(
          "SELECT digest FROM attachments WHERE workspace_id=? AND room_id=? AND attachment_id=? AND state='AVAILABLE' AND deleted_at IS NULL",
        )
        .get(actor.workspaceId, m.roomId, ref.id);
      if (attachment?.digest !== ref.digest)
        throw new GenerationError("CONTEXT_CHANGED", 409);
    }
  }
  private active(run: any, actor: Actor, started: number) {
    const current = this.runRow(run.run_id);
    if (
      current.state !== "RUNNING" ||
      current.owner_id !== this.owner ||
      current.cancelled_at
    )
      throw new GenerationError("CANCELLED", 409);
    if (
      this.wall() > run.deadline_at ||
      this.mono() - started > this.limits.deadlineMs
    )
      throw new GenerationError("DEADLINE_EXCEEDED", 409);
    this.assert(actor, "GENERATE", run.room_id);
  }
  private retryPending() {
    if (this.closing || this.pendingTimer || !this.pending.size) return;
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = undefined;
      const next = this.pending.values().next().value;
      if (next) {
        this.pending.delete(next);
        void this.execute(next).catch(() => {});
      }
    }, 100);
    this.pendingTimer.unref();
  }
  async execute(runId: string): Promise<void> {
    if (this.closing) return;
    if (this.running.size >= this.limits.maxConcurrentRuns) {
      if (this.pending.size < 64) this.pending.add(runId);
      this.retryPending();
      return;
    }
    const claimed = this.app.transaction(() => {
      // A retry can schedule an unstarted acceptance, never a saved call intent.
      // Any call record makes a QUEUED run inconsistent and requires host review.
      this.app.db
        .prepare(
          "UPDATE app_generation_runs SET state='NEEDS_REVIEW',error_code='QUEUED_CALL_REQUIRES_REVIEW',completed_at=? WHERE run_id=? AND state='QUEUED' AND EXISTS(SELECT 1 FROM app_provider_calls c WHERE c.run_id=app_generation_runs.run_id)",
        )
        .run(this.wall(), runId);
      const active = this.app.db
        .prepare(
          "SELECT COUNT(*) n FROM app_generation_runs WHERE state='RUNNING'",
        )
        .get() as any;
      if (Number(active.n) >= this.limits.maxConcurrentRuns) {
        if (this.pending.size < 64) this.pending.add(runId);
        return false;
      }
      const result = this.app.db
        .prepare(
          "UPDATE app_generation_runs SET state='RUNNING',owner_id=? WHERE run_id=? AND state='QUEUED' AND cancelled_at IS NULL",
        )
        .run(this.owner, runId);
      return Number(result.changes) === 1;
    });
    if (!claimed) {
      this.retryPending();
      return;
    }
    let resolveCompletion: () => void = () => {};
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    this.completions.set(runId, {
      promise: completion,
      resolve: resolveCompletion,
    });
    const run = this.runRow(runId);
    const actor: Actor = {
      actorId: run.actor_id,
      workspaceId: run.workspace_id,
      ...(run.session_id ? { sessionId: run.session_id } : {}),
    };
    const request = JSON.parse(run.request_json);
    const controller = new AbortController();
    this.running.set(runId, controller);
    const start = this.mono();
    const timer = setTimeout(
      () => controller.abort(),
      Math.max(1, run.deadline_at - this.wall()),
    );
    timer.unref();
    try {
      this.active(run, actor, start);
      if (this.wall() > run.dispatch_before)
        throw new GenerationError("DISPATCH_EXPIRED", 409);
      const personas = request.personaIds.map((id: string) =>
        this.repository.getPersona(actor, run.room_id, id),
      );
      const memory =
        request.content?.trim() === "/memory" &&
        !!this.repository.getRoom(actor, run.room_id).internalStateSettings
          ?.enabled;
      let decisions: any[] = [];
      const decisionCallIds = new Map<string, string>();
      for (const persona of personas) {
        this.active(run, actor, start);
        let decision: any;
        const target = request.recipient;
        if (memory) decision = { outcome: "RESPOND", source: "broadcast" };
        else if (
          run.target_message_id ||
          (target?.type !== "auto" && target?.agentIds?.includes(persona.id))
        )
          decision = { outcome: "RESPOND", source: "recipient_target" };
        else if (
          target?.type === "auto" &&
          String(request.content)
            .toLowerCase()
            .replace(/\s/g, "")
            .includes("@" + persona.name.toLowerCase().replace(/\s/g, ""))
        )
          decision = { outcome: "RESPOND", source: "mentioned" };
        else {
          const result = await this.call(
            run,
            actor,
            persona,
            "decision",
            start,
            controller.signal,
          );
          decisionCallIds.set(persona.id, result.callId);
          const text = result.text.trim();
          const stamp = text.match(
            /^STAMP:(ACK|AGREE|THINK|AMUSED|CARE|DISAGREE)$/,
          );
          if (text === "RESPOND" || text === "IGNORE")
            decision = { outcome: text, source: "llm_decision" };
          else if (stamp)
            decision = {
              outcome: "STAMP",
              source: "llm_decision",
              reaction: stamp[1],
            };
          else throw new GenerationError("INVALID_DECISION");
        }
        decisions.push({ agent: persona, decision });
      }
      decisions = applyInitialUserTurnFallback(
        decisions,
        [
          {
            id: run.input_message_id,
            role: "user",
            content: request.content ?? "",
            attachments: request.attachmentIds?.map((id: string) => ({ id })),
            timestamp: this.wall(),
          } as any,
        ],
        0,
      );
      this.app.transaction(() => {
        for (const { agent, decision } of decisions) {
          this.app.db
            .prepare("INSERT INTO app_decisions VALUES(?,?,?,?,?,?,?,?,?,?)")
            .run(
              run.workspace_id,
              run.room_id,
              runId,
              randomUUID(),
              agent.id,
              decision.outcome,
              decision.source,
              decision.reaction ?? null,
              decisionCallIds.get(agent.id) ?? null,
              this.wall(),
            );
          if (decision.outcome === "STAMP" && reactions.has(decision.reaction))
            this.app.db
              .prepare("INSERT INTO app_reactions VALUES(?,?,?,?,?,?,?,?)")
              .run(
                run.workspace_id,
                run.room_id,
                runId,
                randomUUID(),
                run.input_message_id,
                agent.id,
                decision.reaction,
                this.wall(),
              );
        }
      });
      for (const { agent, decision } of decisions) {
        if (decision.outcome !== "RESPOND") continue;
        this.active(run, actor, start);
        if (!memory && agent.subAgentPolicy?.mode === "fixed_serial") {
          const workers = (agent.subAgents ?? []).filter(
            (w: any) => w.isEnabled !== false,
          );
          if (workers.length > this.limits.maxSubAgents)
            throw new GenerationError("SUBAGENT_LIMIT");
          const privateReports: PrivateReportRef[] = [];
          for (const worker of workers) {
            if (
              worker.provider !== this.options.provider.name &&
              !(
                worker.provider === "google" &&
                this.options.provider.name === "synthetic"
              )
            )
              throw new GenerationError("PROVIDER_NOT_ALLOWED");
            const report = await this.call(
              run,
              actor,
              agent,
              "subagent",
              start,
              controller.signal,
              worker,
              privateReports,
            );
            if (report.privateSource) privateReports.push(report.privateSource);
          }
        }
        await this.call(
          run,
          actor,
          agent,
          memory ? "memory" : "answer",
          start,
          controller.signal,
        );
      }
      this.app.transaction(() => {
        this.active(run, actor, start);
        this.app.db
          .prepare(
            "UPDATE app_generation_runs SET state='COMPLETED',completed_at=? WHERE run_id=? AND state='RUNNING'",
          )
          .run(this.wall(), runId);
        this.audit(actor, run.room_id, "GENERATION_COMPLETED", runId);
      });
    } catch (error) {
      if (this.stopped) return;
      const code =
        error instanceof GenerationError ? error.code : "GENERATION_FAILED";
      this.app.transaction(() => {
        const current = this.runRow(runId);
        if (current.state === "CANCELLED") return;
        const unknown = this.app.db
          .prepare(
            "SELECT 1 FROM app_provider_calls WHERE run_id=? AND state IN ('DISPATCH_INTENT','OUTCOME_UNKNOWN') LIMIT 1",
          )
          .get(runId);
        const saved = this.app.db
          .prepare(
            "SELECT 1 FROM app_generation_receipts WHERE run_id=? AND message_id IS NOT NULL LIMIT 1",
          )
          .get(runId);
        this.app.db
          .prepare(
            "UPDATE app_provider_calls SET state='OUTCOME_UNKNOWN',reason='COLLECTION_INTERRUPTED' WHERE run_id=? AND state='DISPATCH_INTENT'",
          )
          .run(runId);
        this.app.db
          .prepare(
            "UPDATE app_generation_runs SET state=?,error_code=?,completed_at=? WHERE run_id=?",
          )
          .run(
            unknown ? "NEEDS_REVIEW" : saved ? "PARTIAL" : "FAILED",
            code,
            this.wall(),
            runId,
          );
        this.audit(actor, run.room_id, "GENERATION_STOPPED", runId);
      });
    } finally {
      clearTimeout(timer);
      this.running.delete(runId);
      this.completions.get(runId)?.resolve();
      this.completions.delete(runId);
      const next = this.closing
        ? undefined
        : this.pending.values().next().value;
      if (next) {
        this.pending.delete(next);
        queueMicrotask(() => void this.execute(next).catch(() => {}));
      }
    }
  }
  private async call(
    run: any,
    actor: Actor,
    persona: any,
    purpose: ProviderRequest["purpose"],
    start: number,
    signal: AbortSignal,
    worker?: any,
    privateReports: PrivateReportRef[] = [],
  ): Promise<
    ProviderResult & { callId: string; privateSource?: PrivateReportRef }
  > {
    this.active(run, actor, start);
    if (this.options.provider.available === false)
      throw new GenerationError("PROVIDER_NOT_CONFIGURED", 503);
    const model = worker?.model || persona.model || this.options.defaultModel;
    if (!this.options.provider.supports(model))
      throw new GenerationError("MODEL_NOT_ALLOWED");
    const binding = {
      ...JSON.parse(run.request_json).inputBinding,
      recipient: JSON.parse(run.request_json).recipient,
      runId: run.run_id,
      privateReports,
    };
    const context = await this.compiler.compile(
      actor,
      run.room_id,
      persona.id,
      purpose,
      this.options.provider.name,
      model,
      worker,
      binding,
    );
    const accepted = JSON.parse(run.request_json);
    if (
      context.manifest.roomRevision !== accepted.expectedRoomRevision ||
      context.manifest.personaRevision !==
        accepted.personaRevisions?.[persona.id]
    )
      throw new GenerationError("CONFIGURATION_REVISION_CHANGED", 409);
    const budget = context.manifest.thinkingBudget;
    try {
      if (this.options.provider.validateThinkingBudget)
        this.options.provider.validateThinkingBudget(model, budget);
      else if (budget !== undefined && budget > 0)
        throw new Error("unsupported");
    } catch {
      throw new GenerationError("THINKING_BUDGET_UNSUPPORTED", 409);
    }
    this.options.hooks?.afterContext?.();
    const callId = randomUUID();
    const pricing = this.options.pricing ?? {
      version: "synthetic-v1",
      inputMicrosPerMillion: 0,
      outputMicrosPerMillion: 0,
    };
    if (this.options.provider.name !== "synthetic" && !this.options.pricing)
      throw new GenerationError("PRICING_REQUIRED");
    const reserveCost = Math.ceil(
      (context.manifest.estimatedInputTokens * pricing.inputMicrosPerMillion +
        context.manifest.maxOutputTokens * pricing.outputMicrosPerMillion) /
        1_000_000,
    );
    this.app.transaction(() => {
      this.active(run, actor, start);
      const used = this.app.db
        .prepare(
          `SELECT COUNT(*) AS calls,COALESCE(SUM(CASE WHEN usage_state='COMPLETE' THEN COALESCE(json_extract(usage_json,'$.totalTokens'),reserved_input_tokens+reserved_output_tokens) ELSE reserved_input_tokens+reserved_output_tokens END),0) AS tokens,COALESCE(SUM(CASE WHEN usage_state=\'COMPLETE\' THEN actual_cost_micros ELSE reserved_cost_micros END),0) AS cost FROM app_provider_calls WHERE run_id=?`,
        )
        .get(run.run_id) as any;
      if (
        Number(used.calls) >= this.limits.maxCalls ||
        Number(used.tokens) +
          context.manifest.estimatedInputTokens +
          context.manifest.maxOutputTokens >
          this.limits.maxTotalTokens ||
        Number(used.cost) + reserveCost > this.limits.maxCostMicros
      )
        throw new GenerationError("BUDGET_EXCEEDED");
      this.app.db
        .prepare(
          `INSERT INTO app_provider_calls(workspace_id,room_id,run_id,call_id,ordinal,persona_id,purpose,worker_id,provider,model,state,owner_id,manifest_json,manifest_digest,reserved_input_tokens,reserved_output_tokens,reserved_cost_micros,pricing_version,usage_state,reserved_at) VALUES(?,?,?,?,?,?,?,?,?,?,'RESERVED',?,?,?,?,?,?,?,'UNKNOWN',?)`,
        )
        .run(
          run.workspace_id,
          run.room_id,
          run.run_id,
          callId,
          Number(used.calls) + 1,
          persona.id,
          purpose,
          worker?.id ?? null,
          this.options.provider.name,
          model,
          this.owner,
          stable(context.manifest),
          context.fingerprint,
          context.manifest.estimatedInputTokens,
          context.manifest.maxOutputTokens,
          reserveCost,
          pricing.version,
          this.wall(),
        );
    });
    // Compile again immediately before send; reference changes/ACL changes invalidate prepared bytes.
    const fresh = await this.compiler.compile(
      actor,
      run.room_id,
      persona.id,
      purpose,
      this.options.provider.name,
      model,
      worker,
      binding,
    );
    if (fresh.fingerprint !== context.fingerprint)
      throw new GenerationError("CONTEXT_CHANGED", 409);
    this.app.transaction(() => {
      this.active(run, actor, start);
      this.policy.assert(
        immutable(actor),
        "SEND_TO_PROVIDER",
        immutable({
          workspaceId: actor.workspaceId,
          roomId: run.room_id,
          personaId: persona.id,
          provider: this.options.provider.name,
        }),
      );
      if (this.policy.revision(actor) !== context.manifest.aclRevision)
        throw new GenerationError("AUTHORIZATION_CHANGED", 409);
      this.verifyManifest(actor, context);
      const result = this.app.db
        .prepare(
          "UPDATE app_provider_calls SET state='DISPATCH_INTENT',dispatched_at=? WHERE call_id=? AND state='RESERVED' AND owner_id=?",
        )
        .run(this.wall(), callId, this.owner);
      if (Number(result.changes) !== 1)
        throw new GenerationError("CALL_CONFLICT", 409);
      this.options.hooks?.beforeIntentCommit?.();
    });
    // A throwing/lost COMMIT acknowledgement produces no permit and no HTTP call.
    this.options.hooks?.afterIntentCommit?.();
    this.active(run, actor, start);
    if (this.closing || this.wall() > run.dispatch_before)
      throw new GenerationError("DISPATCH_EXPIRED");
    this.policy.assert(
      immutable(actor),
      "SEND_TO_PROVIDER",
      immutable({
        workspaceId: actor.workspaceId,
        roomId: run.room_id,
        personaId: persona.id,
        provider: this.options.provider.name,
      }),
    );
    if (this.policy.revision(actor) !== context.manifest.aclRevision)
      throw new GenerationError("AUTHORIZATION_CHANGED");
    this.verifyManifest(actor, context);
    let sendPermit = true;
    if (!sendPermit) throw new GenerationError("SEND_NOT_AUTHORIZED");
    sendPermit = false;
    let result: ProviderResult;
    try {
      result = await this.options.provider.generate({
        ...immutable({
          model,
          purpose,
          systemInstruction: context.systemInstruction,
          contents: context.contents,
          maxOutputTokens: context.manifest.maxOutputTokens,
          ...(context.manifest.thinkingBudget !== undefined
            ? { thinkingBudget: context.manifest.thinkingBudget }
            : {}),
          structured:
            purpose === "memory" ||
            (purpose === "answer" && context.persona.separationEnabled),
        }),
        signal,
      });
    } catch {
      if (this.stopped) throw new GenerationError("SERVER_STOPPED");
      this.app.transaction(() => {
        this.app.db
          .prepare(
            "UPDATE app_provider_calls SET state='OUTCOME_UNKNOWN',reason='TRANSPORT_OUTCOME_UNKNOWN',completed_at=? WHERE call_id=? AND state='DISPATCH_INTENT'",
          )
          .run(this.wall(), callId);
      });
      throw new GenerationError("PROVIDER_OUTCOME_UNKNOWN");
    }
    if (this.stopped) throw new GenerationError("SERVER_STOPPED");
    this.options.hooks?.afterProvider?.();
    this.options.hooks?.afterProviderResponse?.();
    // Collection capability belongs only to this started call; authorization is not needed to retain usage.
    let segments: any[] = [];
    let failure: string | undefined;
    try {
      if (result.finish !== "STOP")
        throw new GenerationError(
          result.finish === "REJECTED"
            ? "PROVIDER_REJECTED"
            : result.finish === "SAFETY"
              ? "PROVIDER_SAFETY"
              : "INCOMPLETE_OUTPUT",
        );
      if (purpose === "answer" || purpose === "memory")
        segments = outputSegments(
          result.text,
          purpose === "memory",
          context.persona.separationEnabled,
        );
      if (purpose === "subagent") {
        if (
          typeof result.text !== "string" ||
          !result.text.trim() ||
          result.text.length > 32768
        )
          throw new GenerationError("INVALID_OUTPUT");
        segments = [
          {
            channel: "debug_thoughts",
            visibility: "developer_only",
            content: result.text,
          },
        ];
      }
      this.active(run, actor, start);
      this.assert(actor, "READ_CONVERSATION", run.room_id);
      if (this.wall() > run.collect_before)
        throw new GenerationError("COLLECTION_EXPIRED");
      if (this.policy.revision(actor) !== context.manifest.aclRevision)
        throw new GenerationError("AUTHORIZATION_CHANGED");
      this.verifyManifest(actor, context);
    } catch (error) {
      failure =
        error instanceof GenerationError ? error.code : "OUTPUT_NOT_AUTHORIZED";
    }
    if (
      result.usage?.completeness === "COMPLETE" &&
      [
        result.usage.inputTokens,
        result.usage.outputTokens,
        result.usage.totalTokens,
      ].some((value) => !Number.isSafeInteger(value) || Number(value) < 0)
    )
      result = {
        ...result,
        usage: { ...result.usage, completeness: "PARTIAL" },
      };
    const usage = result.usage;
    const validUsage =
      usage &&
      ["UNKNOWN", "PARTIAL", "COMPLETE"].includes(usage.completeness) &&
      [
        "inputTokens",
        "outputTokens",
        "thoughtsTokens",
        "cachedInputTokens",
        "totalTokens",
      ].every(
        (k) =>
          (usage as any)[k] === undefined ||
          (Number.isSafeInteger((usage as any)[k]) && (usage as any)[k] >= 0),
      );
    if (!validUsage) {
      failure = "INVALID_USAGE";
      result = {
        ...result,
        usage: { completeness: "UNKNOWN", semantics: "invalid-provider-usage" },
      };
    }
    const actual =
      result.usage.completeness === "COMPLETE" &&
      result.usage.inputTokens !== undefined &&
      result.usage.outputTokens !== undefined
        ? Math.ceil(
            (result.usage.inputTokens * pricing.inputMicrosPerMillion +
              (result.usage.outputTokens + (result.usage.thoughtsTokens ?? 0)) *
                pricing.outputMicrosPerMillion) /
              1_000_000,
          )
        : null;
    let privateSource: PrivateReportRef | undefined;
    this.app.transaction(() => {
      const call = this.app.db
        .prepare(
          "SELECT state,owner_id FROM app_provider_calls WHERE call_id=?",
        )
        .get(callId) as any;
      if (call.state !== "DISPATCH_INTENT" || call.owner_id !== this.owner)
        throw new GenerationError("CALL_CONFLICT", 409);
      let message: any;
      if (!failure) {
        try {
          this.active(run, actor, start);
          this.assert(actor, "READ_CONVERSATION", run.room_id);
          if (this.policy.revision(actor) !== context.manifest.aclRevision)
            throw new GenerationError("AUTHORIZATION_CHANGED");
          this.verifyManifest(actor, context);
        } catch (error) {
          failure =
            error instanceof GenerationError
              ? error.code
              : "OUTPUT_NOT_AUTHORIZED";
        }
      }
      if (!failure && run.target_message_id && purpose !== "subagent") {
        const target = this.app.db
          .prepare(
            "SELECT current_revision,persona_id,deleted_at FROM messages WHERE workspace_id=? AND room_id=? AND message_id=?",
          )
          .get(actor.workspaceId, run.room_id, run.target_message_id) as any;
        if (!target || target.deleted_at !== null) failure = "TARGET_DELETED";
        else if (target.persona_id !== persona.id)
          failure = "OUTPUT_NOT_AUTHORIZED";
        else if (
          Number(target.current_revision) !==
          JSON.parse(run.request_json).expectedRevision
        )
          failure = "REVISION_CONFLICT";
      }
      if (!failure && segments.length) {
        if (run.target_message_id && purpose !== "subagent")
          message = this.repository.appendRevision(
            actor,
            run.room_id,
            run.target_message_id,
            {
              expectedRevision: JSON.parse(run.request_json).expectedRevision,
              segments,
              reason: "regeneration",
            },
          );
        else
          message = this.repository.appendMessage(actor, run.room_id, {
            role: "model",
            personaId: persona.id,
            segments,
            reason: purpose,
          });
      }
      if (message && purpose === "subagent") {
        const segment = this.app.db
          .prepare(
            "SELECT segment_id,digest FROM message_segments WHERE workspace_id=? AND room_id=? AND message_id=? AND revision=? AND channel='debug_thoughts'",
          )
          .get(
            actor.workspaceId,
            run.room_id,
            message.id,
            message.revision,
          ) as any;
        privateSource = {
          messageId: message.id,
          revision: message.revision,
          revisionId: message.revisionId,
          segmentId: segment.segment_id,
          digest: segment.digest,
        };
      }
      this.app.db
        .prepare(
          "UPDATE app_provider_calls SET state=?,usage_state=?,usage_json=?,actual_cost_micros=?,reason=?,completed_at=?,response_digest=? WHERE call_id=?",
        )
        .run(
          failure
            ? result.finish === "REJECTED"
              ? "REJECTED"
              : result.finish === "STOP"
                ? "DISCARDED"
                : "INVALID"
            : "COMPLETED",
          result.usage.completeness,
          stable(result.usage),
          actual,
          failure ?? null,
          this.wall(),
          digest(result.text ?? ""),
          callId,
        );
      this.app.db
        .prepare("INSERT INTO app_generation_receipts VALUES(?,?,?,?,?,?,?,?)")
        .run(
          run.workspace_id,
          run.room_id,
          run.run_id,
          callId,
          message?.id ?? null,
          message?.revision ?? null,
          failure ?? "COMPLETED",
          this.wall(),
        );
      this.audit(actor, run.room_id, "PROVIDER_RESULT_RECORDED", callId);
      this.options.hooks?.beforeResultCommit?.();
    });
    this.options.hooks?.afterResultCommit?.();
    if (failure) throw new GenerationError(failure);
    const totals = this.app.db
      .prepare(
        `SELECT COALESCE(SUM(COALESCE(actual_cost_micros,reserved_cost_micros)),0) AS cost,COALESCE(SUM(CASE WHEN usage_state='COMPLETE' THEN COALESCE(json_extract(usage_json,'$.totalTokens'),reserved_input_tokens+reserved_output_tokens) ELSE reserved_input_tokens+reserved_output_tokens END),0) AS tokens FROM app_provider_calls WHERE run_id=?`,
      )
      .get(run.run_id) as any;
    if (
      Number(totals.cost) > this.limits.maxCostMicros ||
      Number(totals.tokens) > this.limits.maxTotalTokens
    )
      throw new GenerationError("ACTUAL_BUDGET_EXCEEDED");
    if (result.usage.completeness !== "COMPLETE")
      throw new GenerationError("USAGE_INCOMPLETE");
    return { ...result, callId, ...(privateSource ? { privateSource } : {}) };
  }
}
