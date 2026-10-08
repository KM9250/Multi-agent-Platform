import { evaluateCommitmentGate } from '../completion';
import { findExhaustedBudget } from '../policy';
import { validateCoordinationSnapshot } from '../validation';
import { TERMINAL_WORKFLOW_STATUSES } from '../types';
import type { CoordinationEvent, CoordinationEventType, CoordinationSession, CoordinationSnapshot, CoordinationTask, WorkflowProgressOutcome, WorkflowResumePayload } from '../types';
import { runnerAudit, runnerPlanRequest, RUNNER_PROVIDER_SYSTEM_CONTRACT } from './context';
import { createRunnerEvent, runnerTimestamp } from './eventFactory';
import { runnerText, validatePreparedRunnerAction, validateRunnerExecution, validateRunnerPlan, validateRunnerUsage, validateRunnerVerification } from './model';
import { evaluateRunnerActionRisk, parseRunnerActionRef, runnerActionRef, runnerPendingApproval } from './policyGuard';
import { defaultRunnerIds } from './stores';
import type { CoordinationRunner, CoordinationRunnerDependencies, CoordinationRunnerStore, PreparedRunnerAction, RunnerClock, RunnerExecutionResult, RunnerIdGenerator, RunnerModelResult, RunnerPendingApproval, RunnerRunOptions, RunnerRunResult, RunnerStopReason } from './types';

const RUNNER_SESSION_PREFIX = 'map.runner.v1:';
const SECURITY_BLOCK_PREFIX = 'RUNNER_UNTRUSTED_CONTENT:';
// Shared across runner instances in this JS runtime; deliberately not a distributed lock.
const running = new Map<string, AbortController>();
// Results are ephemeral, shared by runners using the same store, and never authorize execution.
interface RetainedRunnerResult {
  sessionId: string;
  actionId: string;
  fingerprint: string;
  result: RunnerExecutionResult;
}
type RunnerResultMap = Map<string, Map<string, RetainedRunnerResult>>;
const collected = new WeakMap<CoordinationRunnerStore, RunnerResultMap>();
class ModelDispatchDeferred extends Error {}
class RegistrationCleanupError extends AggregateError {
  constructor(registrationError: unknown, cleanupError: unknown) {
    super([registrationError, cleanupError], 'Runner registration cleanup failed.', { cause: registrationError });
  }
}
interface RoundContext { id: string; key: string; signal: AbortSignal; completed: number }
const cursor = (s: CoordinationSnapshot): string => `${s.events.at(-1)!.sequence}:${s.events.at(-1)!.eventId}`;
const active = (s: CoordinationSession): boolean => s.state === 'OPEN' || s.state === 'SUSPENDED';
const owned = (s: CoordinationSession): boolean => !!s.contextRef?.startsWith(RUNNER_SESSION_PREFIX);

export class BoundedCoordinationRunner implements CoordinationRunner {
  private readonly deps: CoordinationRunnerDependencies;
  private readonly clock: RunnerClock;
  private readonly ids: RunnerIdGenerator;
  private readonly results: RunnerResultMap;
  constructor(deps: CoordinationRunnerDependencies) {
    this.deps = deps; this.clock = deps.clock ?? { now: Date.now }; this.ids = deps.ids ?? defaultRunnerIds;
    if (deps.scheduler) {
      runnerText(deps.supervisorProvider.scheduling?.provider);
      runnerText(deps.supervisorProvider.scheduling?.model);
    }
    let results = collected.get(deps.store);
    if (!results) { results = new Map(); collected.set(deps.store, results); }
    this.results = results;
  }
  isRunning(id: string): boolean { return running.has(id); }
  stop(id: string): void { running.get(id)?.abort(); }
  runOneRound(id: string, options: RunnerRunOptions = {}): Promise<RunnerRunResult> { return this.run(id, options, false); }
  runUntilStop(id: string, options: RunnerRunOptions = {}): Promise<RunnerRunResult> { return this.run(id, options, true); }

  private async run(id: string, options: RunnerRunOptions, loop: boolean): Promise<RunnerRunResult> {
    if (running.has(id)) throw new Error('RUNNER_ALREADY_RUNNING');
    const controller = new AbortController(); running.set(id, controller);
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    let ctx: RoundContext = { id, key: '', signal: controller.signal, completed: 0 };
    let rounds = 0;
    try {
      do {
        ctx = { id, key: this.ids.nextId('round'), signal: controller.signal, completed: 0 };
        const result = await this.round(ctx);
        rounds += ctx.completed;
        if (!loop || result.reason !== 'round_completed') return { ...result, roundsCompleted: rounds };
      } while (true); // Every new PLAN consumes budget; every completed round records Progress.
    } catch {
      const stopped = this.safePoint(ctx);
      if (stopped) return { ...stopped, roundsCompleted: rounds + ctx.completed };
      return { ...this.result(ctx, 'error', undefined, 'RUNNER_INTERNAL_ERROR'), roundsCompleted: rounds + ctx.completed };
    } finally {
      try { this.cleanupTerminal(this.snapshot(ctx)); } finally {
        options.signal?.removeEventListener('abort', abort);
        running.delete(id);
      }
    }
  }
  private snapshot(ctx: RoundContext): CoordinationSnapshot { return this.deps.store.getSnapshot(ctx.id); }
  private now(s: CoordinationSnapshot): number { return runnerTimestamp(s, this.clock); }
  private append(ctx: RoundContext, type: CoordinationEventType, payload: unknown, sessionId?: string, actorAgentId?: string, key?: string): CoordinationEvent {
    const event = createRunnerEvent(this.snapshot(ctx), type, payload, this.clock, this.ids,
      { sessionId, actorAgentId, idempotencyKey: key && `runner:${ctx.id}:${ctx.key}:${key}` });
    this.deps.store.append(event); return event;
  }
  private result(ctx: RoundContext, reason: RunnerStopReason, pendingApproval?: RunnerPendingApproval, errorCode?: string): RunnerRunResult {
    return { workflowRunId: ctx.id, reason, snapshot: this.snapshot(ctx), roundsCompleted: ctx.completed, pendingApproval, errorCode };
  }
  /** Validate ownership before policy, approval, execution, or deletion. */
  private pendingAction(s: CoordinationSnapshot, task: CoordinationTask): PreparedRunnerAction | undefined {
    if (task.workflowRunId !== s.run.runId || s.sessions[task.sessionId]?.workflowRunId !== s.run.runId) return;
    const ref = parseRunnerActionRef(task.inputRefs);
    const record = ref && this.deps.pendingActions.get(s.run.runId, ref.actionId);
    if (!record || record.workflowRunId !== s.run.runId || record.sessionId !== task.sessionId
      || record.taskId !== task.taskId || record.action.actionId !== ref!.actionId
      || record.action.fingerprint !== ref!.fingerprint) return;
    return record.action;
  }
  private pendingApproval(s: CoordinationSnapshot): RunnerPendingApproval | undefined {
    for (const task of Object.values(s.tasks)) {
      if (task.status !== 'ASSIGNED' || !owned(s.sessions[task.sessionId])) continue;
      const action = this.pendingAction(s, task);
      if (action) return runnerPendingApproval(s.run.runId, action);
    }
  }
  private setResult(workflowRunId: string, task: CoordinationTask, result: RunnerExecutionResult): void {
    const ref = parseRunnerActionRef(task.inputRefs);
    if (task.workflowRunId !== workflowRunId || !ref) throw new Error('Invalid result ownership.');
    const results = this.results.get(workflowRunId) ?? new Map<string, RetainedRunnerResult>();
    results.set(task.taskId, { sessionId: task.sessionId, ...ref, result });
    this.results.set(workflowRunId, results);
  }
  private getResult(workflowRunId: string, task: CoordinationTask): RunnerExecutionResult | undefined {
    const retained = this.results.get(workflowRunId)?.get(task.taskId);
    const ref = parseRunnerActionRef(task.inputRefs);
    if (task.workflowRunId !== workflowRunId || !retained || !ref || retained.sessionId !== task.sessionId
      || retained.actionId !== ref.actionId || retained.fingerprint !== ref.fingerprint) return;
    return retained.result;
  }
  private deleteResult(workflowRunId: string, taskId: string): void {
    const results = this.results.get(workflowRunId);
    results?.delete(taskId);
    if (!results?.size) this.results.delete(workflowRunId);
  }
  private cleanupTerminal(s: CoordinationSnapshot): void {
    if (!TERMINAL_WORKFLOW_STATUSES.has(s.run.status)) return;
    this.results.delete(s.run.runId);
    for (const task of Object.values(s.tasks)) {
      const action = this.pendingAction(s, task);
      if (action) this.deps.pendingActions.delete(s.run.runId, action.actionId);
    }
  }
  private safePoint(ctx: RoundContext): RunnerRunResult | undefined {
    const s = this.snapshot(ctx);
    if (TERMINAL_WORKFLOW_STATUSES.has(s.run.status)) {
      this.cleanupTerminal(s);
      return this.result(ctx, s.run.status === 'CANCELLED' ? 'cancelled' : 'terminal');
    }
    if (s.run.status !== 'RUNNING') {
      const reason = s.run.statusReason ?? '';
      return this.result(ctx, reason.startsWith('RUNNER_BUDGET_EXHAUSTED:') ? 'budget_exhausted' : s.run.status === 'BLOCKED' ? 'needs_user' : 'stopped',
        reason.startsWith('RUNNER_NEEDS_USER:') ? this.pendingApproval(s) : undefined);
    }
    if (ctx.signal.aborted) { this.append(ctx, 'WorkflowSuspended', {}); return this.result(ctx, 'cancelled'); }
    if (Object.values(s.sessions).some(session => active(session) && !owned(session))) return this.result(ctx, 'stopped', undefined, 'RUNNER_MANUAL_SESSION_ACTIVE');
  }
  private budget(ctx: RoundContext) {
    const s = this.snapshot(ctx);
    return findExhaustedBudget(s.run.budget, s.run.usage, Math.max(0, this.clock.now() - s.run.createdAt));
  }
  private block(ctx: RoundContext, reason: string, approval?: RunnerPendingApproval): RunnerRunResult {
    this.append(ctx, 'WorkflowBlocked', { reason });
    return this.result(ctx, reason.startsWith('RUNNER_BUDGET_EXHAUSTED:') ? 'budget_exhausted' : 'needs_user', approval);
  }
  private finalize(ctx: RoundContext): RunnerRunResult | undefined {
    let s = this.snapshot(ctx);
    if (!evaluateCommitmentGate(s, this.now(s)).allowed) return;
    if (s.commitment?.status !== 'REQUESTED') {
      // Use precisely the event timestamp for the gate, including a backwards clock.
      const event = createRunnerEvent(s, 'PolicyEvaluated', {}, this.clock, this.ids);
      event.payload = { scope: 'commitment', result: evaluateCommitmentGate(s, event.timestamp) };
      this.deps.store.append(event);
      this.append(ctx, 'CommitmentRequested', { commitmentId: this.ids.nextId('commitment'), summary: 'Acceptance gate satisfied.' });
    }
    s = this.snapshot(ctx);
    this.append(ctx, 'CommitmentAccepted', { commitmentId: s.commitment!.commitmentId });
    return this.result(ctx, 'completed');
  }
  private decide(ctx: RoundContext): RunnerRunResult {
    const stopped = this.safePoint(ctx); if (stopped) return stopped;
    const complete = this.finalize(ctx); if (complete) return complete;
    const exhausted = this.budget(ctx);
    return exhausted ? this.block(ctx, `RUNNER_BUDGET_EXHAUSTED:${exhausted}`) : this.result(ctx, 'round_completed');
  }
  private progress(ctx: RoundContext, outcome: WorkflowProgressOutcome, summary: string): void {
    const key = `runner:${ctx.id}:${ctx.key}:progress`;
    if (this.snapshot(ctx).events.some(event => event.idempotencyKey === key)) return;
    this.append(ctx, 'ProgressRecorded', { outcome, summary }, undefined, undefined, 'progress');
    ctx.completed++;
  }
  private close(ctx: RoundContext, task: CoordinationTask, outcome: WorkflowProgressOutcome, succeeded = false): void {
    this.append(ctx, 'SessionResolved', { outcome: succeeded ? 'SUCCEEDED' : 'FAILED' }, task.sessionId, undefined, 'resolve');
    this.progress(ctx, outcome, `Runner round ${outcome.toLowerCase()}.`);
    const action = this.pendingAction(this.snapshot(ctx), task);
    if (action) this.deps.pendingActions.delete(ctx.id, action.actionId);
    this.deleteResult(ctx.id, task.taskId);
  }
  private failTask(ctx: RoundContext, task: CoordinationTask, code: string, outcome: WorkflowProgressOutcome = 'ERROR'): RunnerRunResult {
    if (task.status === 'ASSIGNED') this.append(ctx, 'TaskFailed', { taskId: task.taskId, failureReason: code }, task.sessionId);
    this.close(ctx, task, outcome);
    return this.decide(ctx);
  }
  private cancelEmptyRunnerSession(ctx: RoundContext, sessionId: string): boolean {
    const s = this.snapshot(ctx); const session = s.sessions[sessionId];
    if (s.run.status !== 'RUNNING' || !session || session.workflowRunId !== ctx.id
      || !owned(session) || session.contextRef !== `${RUNNER_SESSION_PREFIX}${ctx.key}`
      || !ctx.key.trim() || session.state !== 'OPEN'
      || Object.values(s.tasks).some(task => task.sessionId === sessionId)) return false;
    this.append(ctx, 'SessionCancelled', {}, sessionId, undefined, 'registration-cancel');
    return true;
  }
  private cleanupFailedRegistration(ctx: RoundContext, sessionId: string, actionId: string): void {
    this.deps.pendingActions.delete(ctx.id, actionId);
    this.cancelEmptyRunnerSession(ctx, sessionId);
  }
  private async model<T>(ctx: RoundContext, phase: string, call: () => Promise<RunnerModelResult<T>>): Promise<{ value: T; stale: boolean; cursor: string }> {
    const base = cursor(this.snapshot(ctx));
    let response: RunnerModelResult<T>;
    try {
      response = this.deps.scheduler
        ? await this.deps.scheduler.schedule({ ...this.deps.supervisorProvider.scheduling!, kind: 'coordination', signal: ctx.signal,
          execute: async control => {
            // Retrying an entire adapter can lose its usage. The adapter owns bounded retries
            // and reports their aggregate usage, including known usage on errors.
            control.markOutputStarted();
            // Queue wait is also an async boundary: stale or exhausted work must not start.
            if (ctx.signal.aborted || cursor(this.snapshot(ctx)) !== base || this.budget(ctx)) {
              throw new ModelDispatchDeferred();
            }
            return call();
          } })
        : await call();
    } catch (error) {
      const usage = (error as { usage?: unknown } | null)?.usage;
      if (usage !== undefined) this.recordUsage(ctx, usage, phase);
      throw error;
    }
    const stale = cursor(this.snapshot(ctx)) !== base;
    this.recordUsage(ctx, response.usage, phase);
    runnerText(response.provider); runnerText(response.model);
    if (!Number.isFinite(response.latencyMs) || response.latencyMs < 0) throw new Error('Invalid model latency.');
    return { value: response.value, stale, cursor: cursor(this.snapshot(ctx)) };
  }
  private recordUsage(ctx: RoundContext, value: unknown, phase: string): void {
    const usage = validateRunnerUsage(value);
    // Kernel forbids all events after terminalization, including usage. Never reopen it.
    if (!TERMINAL_WORKFLOW_STATUSES.has(this.snapshot(ctx).run.status)) {
      this.append(ctx, 'UsageRecorded', { ...usage, sourceRef: `map.runner.model.v1:${ctx.key}:${phase}` });
    }
  }
  private async round(ctx: RoundContext): Promise<RunnerRunResult> {
    const s = this.snapshot(ctx); validateCoordinationSnapshot(s);
    if (s.run.executionMode !== 'supervised_autonomous') return this.result(ctx, 'stopped', undefined, 'RUNNER_EXECUTION_MODE');
    const stopped = this.safePoint(ctx); if (stopped) return stopped;
    const securityBlock = this.securityPreflight(ctx); if (securityBlock) return securityBlock;
    const sessions = Object.values(s.sessions).filter(active);
    if (sessions.length > 1) return this.result(ctx, 'stopped', undefined, 'RUNNER_AMBIGUOUS_PENDING_WORK');
    const session = sessions[0];
    if (session) {
      if (session.state !== 'OPEN' || session.mode !== 'map.coord.task.v1') return this.result(ctx, 'stopped');
      ctx.key = session.contextRef!.slice(RUNNER_SESSION_PREFIX.length);
      if (!ctx.key.trim()) return this.result(ctx, 'error', undefined, 'RUNNER_INVALID_PENDING_WORK');
      const tasks = Object.values(s.tasks).filter(task => task.sessionId === session.sessionId);
      if (tasks.length === 0) {
        if (!this.cancelEmptyRunnerSession(ctx, session.sessionId)) {
          return this.safePoint(ctx) ?? this.result(ctx, 'error', undefined, 'RUNNER_INVALID_PENDING_WORK');
        }
        this.progress(ctx, 'ERROR', 'Runner task registration did not complete.');
        return this.decide(ctx);
      }
      if (tasks.length !== 1) return this.result(ctx, 'error', undefined, 'RUNNER_INVALID_PENDING_WORK');
      const task = tasks[0];
      if (task.status === 'COMPLETED' || task.status === 'FAILED') return this.verify(ctx, task);
      if (task.status !== 'ASSIGNED') return this.failTask(ctx, task, 'RUNNER_TASK_CANCELLED');
      const result = this.getResult(ctx.id, task);
      if (result) return this.collect(ctx, task, result);
      const exhausted = this.budget(ctx); if (exhausted) return this.block(ctx, `RUNNER_BUDGET_EXHAUSTED:${exhausted}`);
      return this.execute(ctx, task, true);
    }
    const complete = this.finalize(ctx); if (complete) return complete;
    const exhausted = this.budget(ctx); if (exhausted) return this.block(ctx, `RUNNER_BUDGET_EXHAUSTED:${exhausted}`);
    return this.plan(ctx);
  }
  /** Only the first resume following the latest security block can resolve that review.
   * Later ordinary action approvals do not consume/reuse a security review authorization. */
  private securityPreflight(ctx: RoundContext): RunnerRunResult | undefined {
    const s = this.snapshot(ctx);
    // Recover a partially journaled hold before any VERIFY/PLAN, even across runner instances.
    const held = [...s.events].reverse().find(event => event.type === 'TaskFailed'
      && (event.payload as { failureReason?: string }).failureReason?.startsWith(SECURITY_BLOCK_PREFIX)
      && !!event.sessionId && owned(s.sessions[event.sessionId]));
    if (held) {
      const payload = held.payload as { taskId: string; failureReason: string };
      const recorded = s.events.some(event => event.type === 'WorkflowBlocked' && event.sequence > held.sequence
        && (event.payload as { reason?: string }).reason === payload.failureReason);
      if (!recorded) {
        const task = s.tasks[payload.taskId];
        const session = s.sessions[task.sessionId];
        ctx.key = session.contextRef!.slice(RUNNER_SESSION_PREFIX.length);
        if (active(session)) this.close(ctx, task, 'ERROR');
        else { this.progress(ctx, 'ERROR', 'Runner round error.'); this.deleteResult(ctx.id, task.taskId); }
        return this.block(ctx, payload.failureReason);
      }
    }
    const block = [...s.events].reverse().find(event => event.type === 'WorkflowBlocked'
      && (event.payload as { reason?: string }).reason?.startsWith(SECURITY_BLOCK_PREFIX));
    if (!block) return;
    const reason = (block.payload as { reason: string }).reason;
    const reviewRef = reason.slice(SECURITY_BLOCK_PREFIX.length);
    const resume = s.events.find(event => event.type === 'WorkflowResumed' && event.sequence > block.sequence);
    const auth = (resume?.payload as WorkflowResumePayload | undefined)?.authorization;
    if (!reviewRef.startsWith(`map.runner.security-review.v1:${encodeURIComponent(ctx.id)}:`)
      || auth?.type !== 'user' || auth.reference !== reviewRef) return this.block(ctx, reason);
    // The held task/session are already closed; PLAN sees the original goal and safe journal only.
  }
  private async plan(ctx: RoundContext): Promise<RunnerRunResult> {
    try {
      const s = this.snapshot(ctx);
      const response = await this.model(ctx, 'plan', () => this.deps.supervisorProvider.plan(runnerPlanRequest(s, this.now(s), ctx.signal)));
      const stopped = this.safePoint(ctx); if (stopped) return stopped;
      if (response.stale || cursor(this.snapshot(ctx)) !== response.cursor) return this.decide(ctx);
      const exhausted = this.budget(ctx); if (exhausted) return this.block(ctx, `RUNNER_BUDGET_EXHAUSTED:${exhausted}`);
      const proposal = validateRunnerPlan(response.value);
      if (proposal.kind !== 'execute') {
        this.progress(ctx, 'NO_PROGRESS', proposal.kind === 'finish' ? 'Planner finish did not satisfy the commitment gate.' : 'Planner requires user input.');
        return proposal.kind === 'needs_user' ? this.block(ctx, `RUNNER_INFORMATION_REQUIRED:${proposal.reason}`) : this.decide(ctx);
      }
      const executor = this.deps.executors.get(proposal.action.executorId);
      if (!executor || executor.id !== proposal.action.executorId) throw new Error('Unknown executor.');
      const assignee = proposal.assigneeAgentId ?? s.run.supervisorAgentId;
      if (!s.run.participantAgentIds.includes(assignee)) throw new Error('Unknown assignee.');
      const base = cursor(this.snapshot(ctx));
      const action = validatePreparedRunnerAction(await executor.prepare(proposal.action), executor.id);
      const after = this.safePoint(ctx); if (after) return after;
      if (cursor(this.snapshot(ctx)) !== base) return this.decide(ctx);
      const budget = this.budget(ctx); if (budget) return this.block(ctx, `RUNNER_BUDGET_EXHAUSTED:${budget}`);
      const current = this.snapshot(ctx);
      if (Object.values(current.tasks).some(task => parseRunnerActionRef(task.inputRefs)?.actionId === action.actionId)) throw new Error('Action ID already used.');
      const sessionId = this.ids.nextId('session'); const taskId = this.ids.nextId('task'); const now = this.now(current);
      this.deps.pendingActions.put({ workflowRunId: ctx.id, sessionId, taskId, action });
      try {
        this.append(ctx, 'SessionStarted', {
          sessionId, workflowRunId: ctx.id, mode: 'map.coord.task.v1', participants: [...current.run.participantAgentIds],
          initiator: current.run.supervisorAgentId, supervisor: current.run.supervisorAgentId, state: 'OPEN',
          policyId: current.run.policyId, policyVersion: current.run.policyVersion, goal: action.publicSummary,
          contextRef: `${RUNNER_SESSION_PREFIX}${ctx.key}`, createdAt: now, updatedAt: now,
        }, sessionId);
        this.append(ctx, 'TaskAssigned', {
          taskId, workflowRunId: ctx.id, sessionId, title: action.publicSummary, goal: action.publicSummary,
          assigneeAgentId: assignee, assignedByAgentId: current.run.supervisorAgentId,
          inputRefs: [runnerActionRef(action)], status: 'ASSIGNED', createdAt: now, updatedAt: now,
        }, sessionId);
      } catch (error) {
        try {
          this.cleanupFailedRegistration(ctx, sessionId, action.actionId);
        } catch (cleanupError) {
          // A stop/terminal race must respect Kernel guards; otherwise retain both errors.
          if (this.snapshot(ctx).run.status === 'RUNNING') throw new RegistrationCleanupError(error, cleanupError);
        }
        throw error;
      }
      return this.execute(ctx, this.snapshot(ctx).tasks[taskId], false);
    } catch (error) {
      const stopped = this.safePoint(ctx); if (stopped) return stopped;
      if (error instanceof ModelDispatchDeferred) return this.decide(ctx);
      this.progress(ctx, 'ERROR', 'Runner planning or preparation failed.');
      const result = this.decide(ctx);
      const cleanupFailed = error instanceof RegistrationCleanupError;
      return { ...result, reason: cleanupFailed && result.reason === 'round_completed' ? 'error' : result.reason,
        errorCode: cleanupFailed ? 'RUNNER_INTERNAL_ERROR' : 'RUNNER_PLAN_ERROR' };
    }
  }
  private async execute(ctx: RoundContext, task: CoordinationTask, continuation: boolean): Promise<RunnerRunResult> {
    const s = this.snapshot(ctx); const action = this.pendingAction(s, task);
    if (!action) return this.failTask(ctx, task, 'RUNNER_PENDING_ACTION_UNAVAILABLE');
    const risk = evaluateRunnerActionRisk(s, action);
    if (risk === 'DENY') return this.failTask(ctx, task, `POLICY_DENY:${action.actionClass}`, 'NO_PROGRESS');
    if (risk === 'NEEDS_USER') {
      const approval = runnerPendingApproval(ctx.id, action);
      const resume = [...s.events].reverse().find(event => event.type === 'WorkflowResumed');
      const block = [...s.events].reverse().find(event => event.type === 'WorkflowBlocked'
        && (event.payload as { reason?: string }).reason === `RUNNER_NEEDS_USER:${approval.approvalRef}`);
      const auth = (resume?.payload as WorkflowResumePayload | undefined)?.authorization;
      if (!continuation || !block || !resume || resume.sequence <= block.sequence || auth?.type !== 'user' || auth.reference !== approval.approvalRef) {
        return this.block(ctx, `RUNNER_NEEDS_USER:${approval.approvalRef}`, approval);
      }
    }
    const executor = this.deps.executors.get(action.executorId);
    if (!executor || executor.id !== action.executorId) return this.failTask(ctx, task, 'RUNNER_EXECUTOR_UNAVAILABLE');
    // Consume before crossing the external boundary. Even a throwing executor must not be retried.
    this.deps.pendingActions.delete(ctx.id, action.actionId);
    let result: RunnerExecutionResult;
    try {
      result = validateRunnerExecution(await executor.execute(structuredClone(action), { workflowRunId: ctx.id, sessionId: task.sessionId, taskId: task.taskId, signal: ctx.signal }));
    } catch {
      result = { status: 'uncertain', summary: 'Executor outcome could not be established.' };
    }
    if (result.status === 'aborted') result = { ...result, status: 'uncertain' };
    this.setResult(ctx.id, task, result);
    return this.collect(ctx, task, result);
  }
  private taskWritable(ctx: RoundContext, task: CoordinationTask): boolean {
    const s = this.snapshot(ctx);
    return s.run.status === 'RUNNING' && s.sessions[task.sessionId]?.state === 'OPEN' && s.tasks[task.taskId]?.status === task.status;
  }
  private async collect(ctx: RoundContext, task: CoordinationTask, result: RunnerExecutionResult): Promise<RunnerRunResult> {
    if (result.status === 'uncertain' && this.taskWritable(ctx, task)) {
      this.append(ctx, 'TaskFailed', { taskId: task.taskId, failureReason: 'EXECUTION_UNCERTAIN' }, task.sessionId);
      this.close(ctx, task, 'ERROR');
      return this.block(ctx, `RUNNER_EXECUTION_UNCERTAIN:${parseRunnerActionRef(task.inputRefs)?.actionId ?? task.taskId}`);
    }
    const stopped = this.safePoint(ctx); if (stopped) return stopped;
    if (!this.taskWritable(ctx, task)) return this.result(ctx, 'stopped', undefined, 'RUNNER_STALE_EXECUTION');
    if (result.safetyHold) {
      const prefix = `map.runner.security-review.v1:${encodeURIComponent(ctx.id)}:${encodeURIComponent(task.taskId)}:`;
      if (!result.safetyHold.reviewRef.startsWith(prefix)) {
        // An executor cannot transfer a review from another task or workflow.
        result = { status: 'uncertain', summary: 'Invalid security review ownership.' };
        this.setResult(ctx.id, task, result);
        return this.collect(ctx, task, result);
      }
      const reason = `${SECURITY_BLOCK_PREFIX}${result.safetyHold.reviewRef}`;
      this.append(ctx, 'TaskFailed', { taskId: task.taskId, failureReason: reason }, task.sessionId);
      this.close(ctx, task, 'ERROR');
      return this.block(ctx, reason);
    }
    try {
      // Raw summaries stay in evidence storage. The journal receives opaque references only.
      if (!result.resultRef) {
        const resultRef = await this.deps.evidenceStore.put({ kind: 'runner.execution', content: result, createdAt: this.clock.now() });
        result = { ...result, resultRef }; this.setResult(ctx.id, task, result);
      }
      const after = this.safePoint(ctx); if (after) return after;
      if (!this.taskWritable(ctx, task)) return this.result(ctx, 'stopped', undefined, 'RUNNER_STALE_EXECUTION');
      if (result.status === 'succeeded') {
        this.append(ctx, 'TaskCompleted', { taskId: task.taskId, resultRef: result.resultRef, evidenceRefs: result.evidenceRefs }, task.sessionId, task.assigneeAgentId);
      } else {
        this.append(ctx, 'TaskFailed', { taskId: task.taskId, failureReason: 'RUNNER_EXECUTION_FAILED', evidenceRefs: [...new Set([result.resultRef!, ...(result.evidenceRefs ?? [])])] }, task.sessionId);
      }
      this.deleteResult(ctx.id, task.taskId);
      return this.verify(ctx, this.snapshot(ctx).tasks[task.taskId]);
    } catch {
      const after = this.safePoint(ctx); if (after) return after;
      if (!this.taskWritable(ctx, task)) return this.result(ctx, 'stopped');
      return this.failTask(ctx, task, 'RUNNER_COLLECTION_ERROR');
    }
  }
  private async verify(ctx: RoundContext, task: CoordinationTask): Promise<RunnerRunResult> {
    const stopped = this.safePoint(ctx); if (stopped) return stopped;
    if (!this.taskWritable(ctx, task)) return this.result(ctx, 'stopped');
    const exhausted = this.budget(ctx);
    if (exhausted) { this.close(ctx, task, 'NO_PROGRESS'); return this.decide(ctx); }
    try {
      const base = cursor(this.snapshot(ctx));
      const evidence = [];
      for (const ref of new Set([task.resultRef, ...(task.evidenceRefs ?? [])].filter((ref): ref is string => !!ref))) {
        const item = await this.deps.evidenceStore.get(ref);
        const after = this.safePoint(ctx); if (after) return after;
        if (cursor(this.snapshot(ctx)) !== base) return this.decide(ctx);
        if (!item) throw new Error('Runner evidence unavailable.');
        evidence.push(item);
      }
      const budget = this.budget(ctx);
      if (budget) { this.close(ctx, task, 'NO_PROGRESS'); return this.decide(ctx); }
      const s = this.snapshot(ctx);
      const response = await this.model(ctx, 'verify', () => this.deps.supervisorProvider.verify({
        workflowRunId: ctx.id, goal: s.run.goal, acceptanceCriteria: [...s.run.acceptanceCriteria],
        task: structuredClone(task), evidence, audit: runnerAudit(s, this.now(s)), systemContract: RUNNER_PROVIDER_SYSTEM_CONTRACT, signal: ctx.signal,
      }));
      const after = this.safePoint(ctx); if (after) return after;
      if (response.stale || cursor(this.snapshot(ctx)) !== response.cursor || !this.taskWritable(ctx, task)) return this.decide(ctx);
      const verification = validateRunnerVerification(response.value, this.snapshot(ctx).run.acceptanceCriteria);
      const current = this.snapshot(ctx);
      const evaluation = this.append(ctx, 'EvaluationAdded', {
        evaluationId: this.ids.nextId('evaluation'), workflowRunId: ctx.id, sessionId: task.sessionId,
        evaluatorAgentId: current.run.supervisorAgentId, target: { type: 'task', id: task.taskId },
        outcome: verification.taskOutcome, summary: verification.summary, createdAt: this.now(current),
      }, task.sessionId);
      for (const criterion of verification.criteria) {
        if (criterion.outcome === 'UNCHANGED') continue;
        this.append(ctx, 'AcceptanceCriterionEvaluated', { ...criterion, evidenceEventIds: [evaluation.eventId] });
      }
      const passed = task.status === 'COMPLETED' && verification.taskOutcome === 'PASS';
      this.close(ctx, task, task.status === 'FAILED' ? 'ERROR' : passed ? 'PROGRESS' : 'NO_PROGRESS', passed);
      return this.decide(ctx);
    } catch (error) {
      const after = this.safePoint(ctx); if (after) return after;
      if (error instanceof ModelDispatchDeferred) return this.decide(ctx);
      if (!this.taskWritable(ctx, task)) return this.result(ctx, 'stopped');
      this.close(ctx, task, 'ERROR');
      return { ...this.decide(ctx), errorCode: 'RUNNER_VERIFY_ERROR' };
    }
  }
}
export const createCoordinationRunner = (dependencies: CoordinationRunnerDependencies): CoordinationRunner => new BoundedCoordinationRunner(dependencies);
