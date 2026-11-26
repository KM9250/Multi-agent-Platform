import type { AiSearchBinding } from "../search/ai-binding.ts";
import { DenseError } from "../search/embedding.ts";
import type { Actor, AppDatabasePort } from "./types.ts";
import { GenerationError } from "./types.ts";

export interface RunBudget {
  calls: number;
  providerCalls: number;
  searchCalls: number;
  answerHolds: number;
  tokens: number;
  costMicros: number;
}

/** Two cost ledgers plus unconsumed answer reservations; no duplicated actual charges. */
export function runBudgetStatus(
  app: AppDatabasePort,
  runId: string,
  options: { excludePlanId?: string } = {},
): RunBudget {
  const generation = app.db.prepare(`SELECT COUNT(*) calls,
    COALESCE(SUM(CASE WHEN usage_state='COMPLETE' THEN
      COALESCE(json_extract(usage_json,'$.totalTokens'),reserved_input_tokens+reserved_output_tokens)
      ELSE reserved_input_tokens+reserved_output_tokens END),0) tokens,
    COALESCE(SUM(CASE WHEN usage_state='COMPLETE' THEN COALESCE(actual_cost_micros,reserved_cost_micros)
      ELSE reserved_cost_micros END),0) cost FROM app_provider_calls WHERE run_id=?`).get(runId)!;
  const search = app.db.prepare(`SELECT COUNT(*) calls,
    COALESCE(SUM(CASE WHEN o.state='SUCCEEDED' AND json_extract(o.usage_json,'$.completeness')='COMPLETE'
      THEN json_extract(o.usage_json,'$.quantity') ELSE o.reserved_tokens END),0) tokens,
    COALESCE(SUM(CASE WHEN o.state='SUCCEEDED' AND json_extract(o.usage_json,'$.completeness')='COMPLETE'
      THEN COALESCE(o.estimated_cost_micros,o.reserved_cost_micros) ELSE o.reserved_cost_micros END),0) cost
    FROM search_operations o JOIN search_operation_bindings b USING(operation_id)
    JOIN app_context_answer_holds h USING(plan_id) WHERE h.run_id=?
      AND (o.state!='REJECTED' OR o.dispatched_at IS NOT NULL)`).get(runId)!;
  const holds = app.db.prepare(`SELECT COUNT(*) calls,
    COALESCE(SUM(reserved_input_tokens+reserved_output_tokens),0) tokens,
    COALESCE(SUM(reserved_cost_micros),0) cost FROM app_context_answer_holds
    WHERE run_id=? AND state='HELD' AND plan_id<>?`).get(runId, options.excludePlanId ?? "")!;
  return {
    calls: Number(generation.calls) + Number(search.calls) + Number(holds.calls),
    providerCalls: Number(generation.calls), searchCalls: Number(search.calls), answerHolds: Number(holds.calls),
    tokens: Number(generation.tokens) + Number(search.tokens) + Number(holds.tokens),
    costMicros: Number(generation.cost) + Number(search.cost) + Number(holds.cost),
  };
}

/** Dispatch-only gate. Never apply the start deadline to receipt/Usage collection. */
export function assertSearchRunDispatch(app: AppDatabasePort, actor: Actor, binding: AiSearchBinding, at?: number) {
  const run = app.db.prepare(`SELECT * FROM app_generation_runs
    WHERE run_id=? AND workspace_id=? AND room_id=? AND actor_id=?`).get(
      binding.runId, actor.workspaceId, binding.roomId, actor.actorId,
    );
  if (binding.workspaceId !== actor.workspaceId || binding.actorId !== actor.actorId ||
      binding.purpose !== "answer" || binding.audience !== "room")
    throw new DenseError("invalid_run_binding");
  if (!run || run.state !== "RUNNING" || run.cancelled_at !== null)
    throw new GenerationError("CANCELLED", 409);
  const now = at ?? Date.now();
  if (now > Number(run.deadline_at)) throw new GenerationError("DEADLINE_EXCEEDED", 409);
  if (now > Number(run.dispatch_before)) throw new GenerationError("DISPATCH_EXPIRED", 409);
  return run;
}
function runLimits(app: AppDatabasePort, actor: Actor, binding: AiSearchBinding, now: number) {
  const run = assertSearchRunDispatch(app, actor, binding, now);
  return JSON.parse(String(run.limits_json));
}
function fits(used: RunBudget, limits: any, tokens: number, cost: number) {
  return used.calls + 1 <= limits.maxCalls && used.tokens + tokens <= limits.maxTotalTokens &&
    used.costMicros + cost <= limits.maxCostMicros;
}
export interface AnswerHoldInput {
  binding: AiSearchBinding;
  reservedInputTokens: number;
  reservedOutputTokens: number;
  reservedCostMicros: number;
  pricingVersion: string;
  currency?: string;
  now?: number;
}
/** Call for all responding Personas in one outer transaction before any paid prepare. */
export function reserveAnswerHold(app: AppDatabasePort, actor: Actor, input: AnswerHoldInput) {
  return app.transaction(() => {
    const b = input.binding, now = input.now ?? Date.now();
    const limits = runLimits(app, actor, b, now);
    const searchProfileVersion = app.db.prepare(`SELECT version FROM search_profiles
      WHERE workspace_id=? AND actor_id=? AND room_id=? AND active=1`)
      .get(actor.workspaceId, actor.actorId, b.roomId)?.version ?? null;
    if (![input.reservedInputTokens, input.reservedOutputTokens, input.reservedCostMicros].every(Number.isSafeInteger) ||
        input.reservedInputTokens < 1 || input.reservedOutputTokens < 1 || input.reservedCostMicros < 0 ||
        !input.pricingVersion || input.pricingVersion.length > 256 ||
        (input.currency !== undefined && !/^[A-Z]{3}$/.test(input.currency)))
      throw new GenerationError("INVALID_ANSWER_RESERVATION");
    const prior = app.db.prepare("SELECT * FROM app_context_answer_holds WHERE plan_id=?").get(b.planId);
    if (prior) {
      if (prior.state !== "HELD" || prior.binding_digest !== b.bindingDigest || prior.run_id !== b.runId ||
          prior.reserved_input_tokens !== input.reservedInputTokens || prior.reserved_output_tokens !== input.reservedOutputTokens ||
          prior.reserved_cost_micros !== input.reservedCostMicros || prior.pricing_version !== input.pricingVersion ||
          prior.currency !== (input.currency ?? null) || prior.search_profile_version !== searchProfileVersion)
        throw new GenerationError("ANSWER_RESERVATION_CONFLICT", 409);
      return;
    }
    // A Run has one Host accounting currency; even independently prepared Personas cannot mix units.
    if (app.db.prepare(`SELECT 1 FROM app_context_answer_holds WHERE run_id=? AND currency IS NOT ? LIMIT 1`)
      .get(b.runId, input.currency ?? null)) throw new GenerationError("CURRENCY_MISMATCH");
    if (app.db.prepare(`SELECT 1 FROM app_context_answer_holds WHERE run_id=? AND search_profile_version IS NOT ? LIMIT 1`)
      .get(b.runId, searchProfileVersion)) throw new GenerationError("SEARCH_PROFILE_CHANGED");
    if (!fits(runBudgetStatus(app, b.runId), limits,
      input.reservedInputTokens + input.reservedOutputTokens, input.reservedCostMicros))
      throw new GenerationError("BUDGET_EXCEEDED");
    app.db.prepare(`INSERT INTO app_context_answer_holds
      (plan_id,workspace_id,room_id,run_id,actor_id,consumer_persona_id,provider,model,binding_digest,state,
      reserved_input_tokens,reserved_output_tokens,reserved_cost_micros,pricing_version,currency,search_profile_version,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,'HELD',?,?,?,?,?,?,?)`).run(
        b.planId, b.workspaceId, b.roomId, b.runId, b.actorId, b.consumerPersonaId, b.provider, b.model,
        b.bindingDigest, input.reservedInputTokens, input.reservedOutputTokens, input.reservedCostMicros,
        input.pricingVersion, input.currency ?? null, searchProfileVersion, now,
      );
  });
}
/** Must share the search operation reservation transaction. */
export function reserveSearchRunBinding(
  app: AppDatabasePort, actor: Actor, binding: AiSearchBinding, operationId: string,
  tokens: number, costMicros: number, currency?: string,
) {
  const limits = runLimits(app, actor, binding, Date.now());
  const hold = app.db.prepare(`SELECT * FROM app_context_answer_holds WHERE plan_id=? AND run_id=?
    AND workspace_id=? AND room_id=? AND actor_id=? AND consumer_persona_id=? AND state='HELD'`).get(
      binding.planId, binding.runId, actor.workspaceId, binding.roomId, actor.actorId, binding.consumerPersonaId,
    );
  if (!hold || hold.binding_digest !== binding.bindingDigest || hold.provider !== binding.provider || hold.model !== binding.model)
    throw new DenseError("run_answer_unreserved");
  if (!currency || !/^[A-Z]{3}$/.test(currency) || currency !== hold.currency)
    throw new DenseError("currency_unconfigured_or_mismatched");
  const operation = app.db.prepare("SELECT profile_version FROM search_operations WHERE operation_id=?").get(operationId);
  if (!operation || hold.search_profile_version === null || operation.profile_version !== hold.search_profile_version)
    throw new DenseError("search_profile_changed");
  if (!fits(runBudgetStatus(app, binding.runId), limits, tokens, costMicros))
    throw new DenseError("run_budget_exhausted");
  app.db.prepare(`INSERT INTO search_operation_bindings(operation_id,plan_id,purpose,binding_digest)
    VALUES(?,?,'answer',?)`).run(operationId, binding.planId, binding.bindingDigest);
}
/** Provider call INSERT and this transfer belong to one transaction. */
export function consumeAnswerHold(app: AppDatabasePort, planId: string, callId: string, now = Date.now()) {
  const result = app.db.prepare(`UPDATE app_context_answer_holds SET state='CONSUMED',call_id=?,finished_at=?
    WHERE plan_id=? AND state='HELD'`).run(callId, now, planId);
  return Number(result.changes) === 1;
}
export function releaseAnswerHolds(app: AppDatabasePort, runId: string, now = Date.now()) {
  return app.db.prepare(`UPDATE app_context_answer_holds SET state='RELEASED',finished_at=?
    WHERE run_id=? AND state='HELD'`).run(now, runId);
}
export function markSearchOutcomeUnknown(app: AppDatabasePort, operationId: string, now = Date.now()) {
  app.db.prepare(`UPDATE app_generation_runs SET state='NEEDS_REVIEW',error_code='SEARCH_OUTCOME_UNKNOWN',completed_at=?
    WHERE run_id IN (SELECT h.run_id FROM search_operation_bindings b JOIN app_context_answer_holds h USING(plan_id)
      WHERE b.operation_id=?) AND state IN ('QUEUED','RUNNING')`).run(now, operationId);
}
/** Safe receipt projection: no query, original SourceRef, private ancestor, or Vault path. */
export function getRunSearchUsage(app: AppDatabasePort, actor: Actor, runId: string) {
  return app.db.prepare(`SELECT o.*,b.plan_id,h.consumer_persona_id,h.currency FROM search_operations o
    JOIN search_operation_bindings b USING(operation_id) JOIN app_context_answer_holds h USING(plan_id)
    WHERE h.run_id=? AND h.workspace_id=? AND h.actor_id=? ORDER BY o.created_at,o.operation_id`).all(
      runId, actor.workspaceId, actor.actorId,
    ).map(row => ({
      operationId: String(row.operation_id), planId: String(row.plan_id), consumerPersonaId: String(row.consumer_persona_id),
      purpose: String(row.purpose), state: String(row.state),
      reservedTokens: Number(row.reserved_tokens), reservedCostMicros: Number(row.reserved_cost_micros),
      ...(row.currency ? { currency: String(row.currency) } : {}),
      estimatedCostMicros: row.estimated_cost_micros === null ? null : Number(row.estimated_cost_micros),
      usage: row.usage_json ? JSON.parse(String(row.usage_json)) : { completeness: "UNKNOWN", unit: "input_token" },
    }));
}
