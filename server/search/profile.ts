import type { AppDatabase } from "../app-data/db.ts";
import { AuthorizationPolicy, type Actor } from "../auth/authorization.ts";
import { assertAiSearchBinding, type AiSearchBinding } from "./ai-binding.ts";
import { markSearchOutcomeUnknown, reserveSearchRunBinding } from "../generation/search-budget.ts";
import {
  DenseError,
  EMBEDDING_SPACE,
  formattedInput,
  hash,
  spaceId,
  unitVector,
  type EmbeddingProvider,
  type EmbeddingPurpose,
  type SearchPurpose,
  type SearchUsage,
} from "./embedding.ts";

export type MemoryScope = "room_shared" | "persona_private";
export interface ProfileConfig {
  personaId: string;
  scopes: MemoryScope[];
  purposes: SearchPurpose[];
  maxCalls: number;
  maxTokens: number;
  maxCostMicros: number;
  priceMicrosPerThousandTokens: number;
  aiContext?: {
    queryEmbedding: boolean;
    consumerPersonaIds: string[];
    currency?: string;
  };
}
export interface SearchProfile extends ProfileConfig {
  version: number;
  spaceId: string;
  configDigest: string;
}
const binding = (actor: Actor, roomId: string): [string, string, string] => [
  actor.workspaceId,
  actor.actorId,
  roomId,
];
const match = "workspace_id=? AND actor_id=? AND room_id=?";
const invalid = () => new DenseError("invalid_profile");

function boundedSet<T extends string>(
  input: unknown,
  allowed: readonly T[],
): T[] {
  if (
    !Array.isArray(input) ||
    !input.length ||
    input.length > allowed.length ||
    new Set(input).size !== input.length ||
    input.some((v) => !allowed.includes(v))
  )
    throw invalid();
  return [...input].sort();
}
function integer(input: unknown, maximum: number) {
  if (
    typeof input !== "number" ||
    !Number.isSafeInteger(input) ||
    input < 1 ||
    input > maximum
  )
    throw invalid();
  return input;
}
function parseConfig(input: unknown): ProfileConfig {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw invalid();
  const config = input as Record<string, unknown>;
  if (
    Object.keys(config).some(
      (k) =>
        ![
          "personaId",
          "scopes",
          "purposes",
          "maxCalls",
          "maxTokens",
          "maxCostMicros",
          "priceMicrosPerThousandTokens",
          "aiContext",
        ].includes(k),
    ) ||
    typeof config.personaId !== "string" ||
    !config.personaId ||
    config.personaId === "*" ||
    config.personaId.length > 128
  )
    throw invalid();
  let aiContext: ProfileConfig["aiContext"];
  if (config.aiContext !== undefined) {
    const ai = config.aiContext as Record<string, unknown>;
    if (!ai || typeof ai !== "object" || Array.isArray(ai) ||
        Object.keys(ai).some(k => !["queryEmbedding", "consumerPersonaIds", "currency"].includes(k)) ||
        typeof ai.queryEmbedding !== "boolean" || !Array.isArray(ai.consumerPersonaIds) ||
        ai.consumerPersonaIds.length > 128 ||
        new Set(ai.consumerPersonaIds).size !== ai.consumerPersonaIds.length ||
        ai.consumerPersonaIds.some(id => typeof id !== "string" || !id || id === "*" || id.length > 128) ||
        (ai.queryEmbedding && !ai.consumerPersonaIds.length) ||
        (ai.currency !== undefined && (typeof ai.currency !== "string" || !/^[A-Z]{3}$/.test(ai.currency)))) throw invalid();
    aiContext = { queryEmbedding: ai.queryEmbedding, consumerPersonaIds: [...ai.consumerPersonaIds].sort(),
      ...(ai.currency ? { currency: ai.currency as string } : {}) };
  }
  return {
    personaId: config.personaId,
    scopes: boundedSet(config.scopes, ["room_shared", "persona_private"]),
    purposes: boundedSet(config.purposes, [
      "DOCUMENT_EMBEDDING",
      "QUERY_EMBEDDING",
      "RERANK",
    ]),
    maxCalls: integer(config.maxCalls, 1_000_000),
    maxTokens: integer(config.maxTokens, 10_000_000_000),
    maxCostMicros: integer(config.maxCostMicros, 1_000_000_000_000),
    priceMicrosPerThousandTokens: integer(
      config.priceMicrosPerThousandTokens,
      1_000_000,
    ),
    ...(aiContext ? { aiContext } : {}),
  };
}

function liveBinding(
  app: AppDatabase,
  actor: Actor,
  roomId: string,
  personaId: string,
) {
  const row = app.db
    .prepare(
      `SELECT 1 FROM rooms r JOIN room_personas rp USING(workspace_id,room_id)
    JOIN personas p USING(workspace_id,persona_id) JOIN principals a USING(workspace_id)
    JOIN persona_revisions pr ON pr.workspace_id=p.workspace_id AND pr.persona_id=p.persona_id AND pr.revision=rp.persona_revision
    WHERE r.workspace_id=? AND r.room_id=? AND rp.persona_id=? AND a.actor_id=? AND a.active=1
      AND r.deleted_at IS NULL AND p.deleted_at IS NULL
      AND COALESCE(json_extract(pr.config_json,'$.isEnabled'),1)!=0
      AND EXISTS(SELECT 1 FROM app_operational_state WHERE singleton=1 AND maintenance=0 AND restored=0)`,
    )
    .get(actor.workspaceId, roomId, personaId, actor.actorId);
  if (!row) throw new DenseError("scope_unavailable");
}
/** Host administration only. A new explicit version opens a new budget. Prior receipts remain. */
export function configureSearchProfile(
  app: AppDatabase,
  actor: Actor,
  roomId: string,
  input: unknown,
) {
  const config = parseConfig(input);
  const args = binding(actor, roomId);
  return app.transaction(() => {
    liveBinding(app, actor, roomId, config.personaId);
    for (const consumer of config.aiContext?.consumerPersonaIds ?? [])
      liveBinding(app, actor, roomId, consumer);
    const version = Number(
      app.db
        .prepare(
          `SELECT COALESCE(MAX(version),0)+1 AS v FROM search_profiles WHERE ${match}`,
        )
        .get(...args)!.v,
    );
    app.db
      .prepare(
        `UPDATE search_profiles SET active=0 WHERE ${match} AND active=1`,
      )
      .run(...args);
    const json = JSON.stringify(config);
    app.db
      .prepare("INSERT INTO search_profiles VALUES(?,?,?,?,1,?,?,?,?,?,?)")
      .run(
        ...args,
        version,
        EMBEDDING_SPACE.provider,
        EMBEDDING_SPACE.model,
        spaceId,
        json,
        hash(json),
        Date.now(),
      );
    app.audit(
      actor.actorId,
      actor.workspaceId,
      "SEARCH_PROFILE_CONFIGURED",
      roomId,
    );
    return getSearchProfile(app, actor, roomId)!;
  });
}
export function stopSearchProfile(
  app: AppDatabase,
  actor: Actor,
  roomId: string,
) {
  app.transaction(() => {
    app.db
      .prepare(
        `UPDATE search_profiles SET active=0 WHERE ${match} AND active=1`,
      )
      .run(...binding(actor, roomId));
    app.audit(
      actor.actorId,
      actor.workspaceId,
      "SEARCH_PROFILE_STOPPED",
      roomId,
    );
  });
}
export function getSearchProfile(
  app: AppDatabase,
  actor: Actor,
  roomId: string,
): SearchProfile | null {
  const row = app.db
    .prepare(`SELECT * FROM search_profiles WHERE ${match} AND active=1`)
    .get(...binding(actor, roomId));
  return row ? decodeProfile(row) : null;
}

/** Decode the immutable historical config using the same contract as today's dispatch profile. */
export function decodeProfile(row: Record<string, unknown>): SearchProfile {
  const json = String(row.config_json);
  if (
    row.space_id !== spaceId ||
    row.provider !== EMBEDDING_SPACE.provider ||
    row.model !== EMBEDDING_SPACE.model ||
    row.config_digest !== hash(json)
  )
    throw new DenseError("incompatible_profile");
  return {
    ...parseConfig(JSON.parse(json)),
    version: Number(row.version),
    spaceId,
    configDigest: String(row.config_digest),
  };
}

export function assertDispatchScope(
  app: AppDatabase,
  policy: AuthorizationPolicy,
  actor: Actor,
  roomId: string,
  profile: SearchProfile,
  purpose: EmbeddingPurpose,
  scopes: readonly MemoryScope[],
) {
  const current = getSearchProfile(app, actor, roomId);
  if (
    !current ||
    current.version !== profile.version ||
    current.configDigest !== profile.configDigest ||
    !current.purposes.includes(purpose)
  )
    throw new DenseError("profile_changed_or_disabled");
  if (!scopes.length || scopes.some((scope) => !current.scopes.includes(scope)))
    throw new DenseError("scope_unavailable");
  liveBinding(app, actor, roomId, current.personaId);
  policy.assert(actor, "READ_ROOM", { workspaceId: actor.workspaceId, roomId });
  for (const visibility of scopes) {
    const target = {
      workspaceId: actor.workspaceId,
      roomId,
      personaId: current.personaId,
      visibility,
    };
    policy.assert(actor, "READ_MEMORY", target);
    policy.assert(actor, "SEND_TO_PROVIDER", { ...target, provider: "google" });
  }
}
/** An enabled human profile never implicitly permits paid AI retrieval. */
export function assertAiDispatchScope(
  app: AppDatabase, policy: AuthorizationPolicy, actor: Actor, roomId: string,
  profile: SearchProfile, ai: AiSearchBinding,
) {
  assertAiSearchBinding(app, policy, actor, roomId, ai);
  if (!profile.aiContext?.queryEmbedding ||
      !profile.aiContext.consumerPersonaIds.includes(ai.consumerPersonaId) ||
      !profile.purposes.includes("QUERY_EMBEDDING") || !profile.scopes.includes("room_shared"))
    throw new DenseError("ai_query_disabled");
  liveBinding(app, actor, roomId, ai.consumerPersonaId);
  assertDispatchScope(app, policy, actor, roomId, profile, "QUERY_EMBEDDING", ["room_shared"]);
  // The query is accepted user input; sending it uses the consumer's destination grant.
  policy.assert(actor, "SEND_TO_PROVIDER", {
    workspaceId: actor.workspaceId, roomId, personaId: ai.consumerPersonaId, provider: EMBEDDING_SPACE.provider,
  });
}
/** Revalidates a frozen plan's paid-query receipts; never runs search or reserves a new call. */
export function revalidateAiSearchOperations(
  app: AppDatabase, policy: AuthorizationPolicy, actor: Actor, roomId: string,
  ai: AiSearchBinding, operationIds: readonly string[],
) {
  if (operationIds.length > 1 || new Set(operationIds).size !== operationIds.length)
    throw new DenseError("source_changed");
  for (const operationId of operationIds) {
    const operation = app.db.prepare(`SELECT o.*,b.plan_id,b.binding_digest,h.run_id,h.currency
      FROM search_operations o JOIN search_operation_bindings b USING(operation_id)
      JOIN app_context_answer_holds h USING(plan_id) WHERE o.operation_id=?`).get(operationId);
    if (!operation || operation.workspace_id !== actor.workspaceId || operation.actor_id !== actor.actorId ||
        operation.room_id !== roomId || operation.run_id !== ai.runId || operation.plan_id !== ai.planId ||
        operation.binding_digest !== ai.bindingDigest || operation.purpose !== "QUERY_EMBEDDING")
      throw new DenseError("source_changed");
    if (operation.state === "OUTCOME_UNKNOWN" || operation.state === "DISPATCH_INTENT")
      throw new DenseError("SEARCH_OUTCOME_UNKNOWN");
    if (operation.state === "REJECTED") continue;
    if (operation.state !== "SUCCEEDED") throw new DenseError("source_changed");
    const profile = getSearchProfile(app, actor, roomId);
    if (!profile || profile.version !== operation.profile_version)
      throw new DenseError("profile_changed_or_disabled");
    assertAiDispatchScope(app, policy, actor, roomId, profile, ai);
    if (!operation.currency || profile.aiContext?.currency !== operation.currency)
      throw new DenseError("profile_changed_or_disabled");
  }
}
export const OP_TOKEN_RESERVATION = 8192;
interface DispatchInput {
  actor: Actor;
  roomId: string;
  profile: SearchProfile;
  scopes: MemoryScope[];
  purpose: EmbeddingPurpose;
  operationKey: string;
  sourceRef?: string;
  signal: AbortSignal;
  /** Reads the current source (including live Vault checks) immediately before send. */
  readText: () => string;
  aiBinding?: AiSearchBinding;
}
export function operationId(
  actor: Actor,
  roomId: string,
  purpose: EmbeddingPurpose,
  key: string,
) {
  return hash(JSON.stringify([...binding(actor, roomId), purpose, key]));
}
export function budgetStatus(
  app: AppDatabase,
  actor: Actor,
  roomId: string,
  version: number,
) {
  const row = app.db
    .prepare(
      `SELECT COUNT(*) AS calls,
    COALESCE(SUM(CASE WHEN state='SUCCEEDED' AND json_extract(usage_json,'$.completeness')='COMPLETE'
      THEN json_extract(usage_json,'$.quantity') ELSE reserved_tokens END),0) AS tokens,
    COALESCE(SUM(COALESCE(estimated_cost_micros,reserved_cost_micros)),0) AS cost
    FROM search_operations WHERE ${match} AND profile_version=? AND (state!='REJECTED' OR dispatched_at IS NOT NULL)`,
    )
    .get(...binding(actor, roomId), version)!;
  return {
    calls: Number(row.calls),
    tokens: Number(row.tokens),
    costMicros: Number(row.cost),
  };
}
export async function dispatchEmbedding(
  app: AppDatabase,
  policy: AuthorizationPolicy,
  provider: EmbeddingProvider,
  input: DispatchInput,
) {
  const { actor, roomId, profile, purpose, signal } = input;
  const check = () => {
    signal.throwIfAborted();
    if (provider.spaceId !== profile.spaceId)
      throw new DenseError("incompatible_provider");
    assertDispatchScope(
      app,
      policy,
      actor,
      roomId,
      profile,
      purpose,
      input.scopes,
    );
    if (input.aiBinding) {
      if (purpose !== "QUERY_EMBEDDING" || input.scopes.length !== 1 || input.scopes[0] !== "room_shared")
        throw new DenseError("invalid_ai_purpose");
      assertAiDispatchScope(app, policy, actor, roomId, profile, input.aiBinding);
    }
  };
  check();
  const text = input.readText();
  const payloadDigest = hash(formattedInput(purpose, text));
  const op = operationId(actor, roomId, purpose, input.operationKey);
  const cost = Math.ceil(
    (OP_TOKEN_RESERVATION * profile.priceMicrosPerThousandTokens) / 1000,
  );
  app.transaction(() => {
    check();
    if (
      app.db
        .prepare("SELECT state FROM search_operations WHERE operation_id=?")
        .get(op)
    )
      throw new DenseError("operation_already_recorded");
    const used = budgetStatus(app, actor, roomId, profile.version);
    if (
      used.calls + 1 > profile.maxCalls ||
      used.tokens + OP_TOKEN_RESERVATION > profile.maxTokens ||
      used.costMicros + cost > profile.maxCostMicros
    )
      throw new DenseError("budget_exhausted");
    app.db
      .prepare(
        `INSERT INTO search_operations(operation_id,workspace_id,actor_id,room_id,profile_version,
      purpose,source_ref,payload_digest,state,reserved_tokens,reserved_cost_micros,created_at)
      VALUES(?,?,?,?,?,?,?,?,'RESERVED',?,?,?)`,
      )
      .run(
        op,
        ...binding(actor, roomId),
        profile.version,
        purpose,
        input.sourceRef ?? null,
        payloadDigest,
        OP_TOKEN_RESERVATION,
        cost,
        Date.now(),
      );
    if (input.aiBinding)
      reserveSearchRunBinding(app, actor, input.aiBinding, op, OP_TOKEN_RESERVATION, cost, profile.aiContext?.currency);
  }, "search-reserve");

  try {
    // readNote is allowed to commit an observed live-file drift independently of a failed dispatch.
    const fresh = input.readText();
    if (hash(formattedInput(purpose, fresh)) !== payloadDigest)
      throw new DenseError("source_changed");
    app.transaction(() => {
      check();
      if (hash(formattedInput(purpose, input.readText())) !== payloadDigest)
        throw new DenseError("source_changed");
      const changed = app.db
        .prepare(
          "UPDATE search_operations SET state='DISPATCH_INTENT',dispatched_at=? WHERE operation_id=? AND state='RESERVED'",
        )
        .run(Date.now(), op).changes;
      if (!changed) throw new DenseError("operation_already_recorded");
    }, "search-intent");
  } catch (error) {
    app.transaction(() =>
      app.db
        .prepare(
          // This stack has not called the transport, including a lost Intent COMMIT acknowledgement.
          "UPDATE search_operations SET state='REJECTED',dispatched_at=NULL,estimated_cost_micros=0,finished_at=? WHERE operation_id=? AND state IN ('RESERVED','DISPATCH_INTENT')",
        )
        .run(Date.now(), op),
    );
    throw error;
  }
  // A concurrent writer or a live-file change can invalidate an intent immediately after COMMIT.
  // Only this running dispatcher can attest that its transport has still never been invoked.
  try {
    if (hash(formattedInput(purpose, input.readText())) !== payloadDigest)
      throw new DenseError("source_changed");
    check();
  } catch (error) {
    app.transaction(() => {
      const rejected = app.db
        .prepare(
          `UPDATE search_operations SET state='REJECTED', dispatched_at=NULL,
        finished_at=?, estimated_cost_micros=0 WHERE operation_id=? AND state='DISPATCH_INTENT'`,
        )
        .run(Date.now(), op);
      if (rejected.changes)
        app.audit(
          actor.actorId,
          actor.workspaceId,
          "SEARCH_REJECTED_BEFORE_SEND",
          op,
        );
    }, "search-local-rejection");
    throw error;
  }
  let vector: Float32Array;
  let usage: SearchUsage;
  try {
    const result = await provider.embed({ purpose, text, signal });
    vector = unitVector(result.vector);
    usage = result.usage;
    if (
      !usage ||
      usage.unit !== "input_token" ||
      !["COMPLETE", "PARTIAL", "UNKNOWN"].includes(usage.completeness) ||
      (usage.completeness === "COMPLETE" &&
        (!Number.isSafeInteger(usage.quantity) ||
          usage.quantity! < 0 ||
          usage.quantity! > OP_TOKEN_RESERVATION))
    )
      throw new DenseError("invalid_usage");
  } catch (error) {
    const state =
      error instanceof DenseError && error.message === "provider_rejected"
        ? "REJECTED"
        : "OUTCOME_UNKNOWN";
    app.transaction(
      () => {
        app.db
          .prepare(
            "UPDATE search_operations SET state=?,finished_at=? WHERE operation_id=? AND state='DISPATCH_INTENT'",
          )
          .run(state, Date.now(), op);
        if (state === "OUTCOME_UNKNOWN") markSearchOutcomeUnknown(app, op);
      },
      "search-receipt",
    );
    throw error;
  }
  app.transaction(
    () =>
      app.db
        .prepare(
          `UPDATE search_operations SET state='SUCCEEDED',usage_json=?,estimated_cost_micros=?,finished_at=?
    WHERE operation_id=? AND state='DISPATCH_INTENT'`,
        )
        .run(
          JSON.stringify(usage),
          usage.completeness === "COMPLETE"
            ? Math.ceil(
                (usage.quantity! * profile.priceMicrosPerThousandTokens) / 1000,
              )
            : null,
          Date.now(),
          op,
        ),
    "search-receipt",
  );
  check();
  if (hash(formattedInput(purpose, input.readText())) !== payloadDigest)
    throw new DenseError("source_changed");
  return { vector, usage, operationId: op };
}

/** Only while holding the exclusive Host lock, before starting HTTP or workers. */
export function recoverSearchDispatches(app: AppDatabase) {
  app.transaction(
    () => {
      app.db
        .prepare(
          `UPDATE search_operations
    SET state=CASE state WHEN 'RESERVED' THEN 'REJECTED' ELSE 'OUTCOME_UNKNOWN' END, finished_at=?
    WHERE state IN ('RESERVED','DISPATCH_INTENT')`,
        )
        .run(Date.now());
      for (const row of app.db.prepare(`SELECT o.operation_id FROM search_operations o
        JOIN search_operation_bindings b USING(operation_id) WHERE o.state='OUTCOME_UNKNOWN'`).all())
        markSearchOutcomeUnknown(app, String(row.operation_id));
      app.db.prepare(`UPDATE app_context_answer_holds SET state='RELEASED',finished_at=? WHERE state='HELD'`).run(Date.now());
    },
    "search-recover",
  );
}
