# Autonomous coordination architecture

MAP keeps four responsibilities separate:

1. **Conversation** carries persona interaction and non-binding signals.
2. **Coordination** owns bounded workflows, sessions, governance, decisions, and commitments.
3. **Task execution** keeps Private SubAgents inside their owning Persona boundary.
4. **MACP-Command** is asynchronous human I/O, not the workflow engine.

The initial kernel is **MACP-Coord Level 1 adapter-ready**, not wire-compatible. It uses the local mode identifiers `map.coord.task.v1`, `map.coord.decision.v1`, and `map.coord.quorum.v1`; an adapter may later map these to draft external identifiers without coupling the core to that draft.

## Invariants implemented by the domain kernel

- Every Workflow owns an immutable policy snapshot captured at creation time. Its policy ID and version remain an identity projection, while decisions use the captured content; every Session must bind the same identity.
- Autonomous budgets contain only finite, positive limits. Zero never means unlimited.
- Unknown action classes evaluate to `NEEDS_USER`.
- Only Persona IDs listed on the Workflow may participate in a coordination Session or receive a Coordination Task. Private SubAgent execution remains private to its owning Persona. SubAgent output may become Task evidence, but a SubAgent never becomes a Coordination participant.
- The journal is append-only, ordered, idempotent for repeated external actions, and insulated from mutation of caller-owned event payloads.
- A Workflow may own multiple active Sessions. Each Session is suspended, resumed, cancelled, expired, or resolved independently.
- Tasks are first-class Session state and move from `ASSIGNED` to `COMPLETED`, `FAILED`, or `CANCELLED`. `TaskCompleted` supplies evidence but never resolves its Session or Workflow.
- `Session.state = RESOLVED` means that the Session lifecycle is complete. `Session.resolution.outcome` describes whether its result `SUCCEEDED` or `FAILED`; a failed outcome does not automatically fail the Workflow, so a later Session may retry the work.
- Task-mode Session resolution requires at least one Task and requires every Task to be terminal. A successful result additionally requires at least one completed Task. Decision and Quorum Sessions apply equivalent mode-specific terminal checks.
- Commitment is Workflow-scoped. Only the configured Supervisor can accept a valid pending commitment, and acceptance succeeds only when the current completion gate passes.
- New Sessions must be open, policy-bound, owned and initiated by Workflow participants, and include the configured Supervisor; duplicate Session IDs are rejected.
- Terminal Workflows (`RESOLVED`, `CANCELLED`, and `FAILED`) reject all later events except an exact idempotent retry. `BLOCKED` and `SUSPENDED` are non-terminal stopped states in which no coordination work proceeds.
- A `SUSPENDED` or `BLOCKED` Workflow never resumes implicitly. `WorkflowResumed` requires an explicit user authorization carried by a Supervisor event. Stopping suspends every open Session, and resuming reopens suspended Sessions without changing terminal Sessions.
- `CommitmentAccepted` is the sole event that resolves a Workflow. It does not resolve or clean up Sessions, Tasks, Decisions, or Quorums; those objects must already satisfy the gate.
- Suspension, blocking, resumption, and cancellation are explicit durable events. Cancellation closes all active Sessions and assigned Tasks while preserving already-terminal Tasks.

## Delivery roadmap

- **COORD-0:** typed conversation recipients, participation profiles, and non-triggering STAMP outcomes.
- **COORD-1:** provider/model scheduler, backpressure, bounded retry with jitter, and queue cancellation.
- **COORD-2A:** multiple Session and Task lifecycles, immutable policy snapshots, explicit stop/resume, snapshot validation, and journal mutation protection.
- **COORD-2B:** Decision, Quorum, acceptance-criterion evaluation, and the Workflow-level commitment gate.
- **COORD-2C:** deterministic audit projection, event-driven usage/progress accounting, and runtime/snapshot invariant hardening.
- **COORD-3A:** bounded autonomous runner core with injected executors.
- **COORD-3B:** browser PoC executor implementing the Runner executor contract.
- **COORD-4:** terminal and `NEEDS_USER` notifications through MACP-Command.
- **COORD-5:** UI-independent durable runtime, checkpoint recovery, and idempotent restart.
- **COORD-6:** SA-2 private-worker routing and risk-classified tools.

Browser hosting is only a PoC. Formal unattended operation requires the durable runtime because reloads, OS sleep, browser crashes, and background throttling cannot be controlled by React state or `localStorage`.

Persistent stores, checkpoint restore, browser execution, MACP bridges, and durable runtime remain future responsibilities.

## COORD-2B1: decisions, quorum, and evaluations

Coordination separates its principal objects by session mode: `map.coord.task.v1` contains work Tasks, `map.coord.decision.v1` contains Decisions, and `map.coord.quorum.v1` contains Quorums. Principal objects are not mixed between these modes; Evaluations may accompany any session as advisory evidence.

A **Decision** is a single-authority coordination judgment. Only the workflow supervisor opens or cancels it, while only its named authority resolves it. A **Quorum** is an explicit multi-Persona vote. Votes may change while the Quorum is `OPEN`; `APPROVED` may resolve as soon as its threshold is reached, while `REJECTED` requires every eligible voter to have cast a vote with approvals still below the threshold. Quorum approval is neither policy allowance, human approval, nor workflow completion.

An **Evaluation** records advisory evidence about a task, decision, quorum, or artifact. An Evaluation `PASS` does not complete its target, Session, or Workflow. Conversation `STAMP` reactions are never interpreted as Decision resolution or Quorum votes; the Conversation and Coordination planes remain separate.

## COORD-2B2: acceptance and Workflow commitment

Acceptance Criteria are Supervisor-owned, authoritative completion evaluations. A `SATISFIED` evaluation must cite allowed, prior journal events; a later `UNSATISFIED` evaluation can reverse it. The durable `satisfiedCriteria` projection is checked by replaying these evaluations in journal order. Task completion, Decision resolution, Quorum approval, Session resolution, and Evaluation results are evidence only: none completes a Workflow by itself.

The deterministic commitment gate requires a running Workflow, no open or suspended Sessions, and—when policy requires them—all Acceptance Criteria to be satisfied. Budget exhaustion is reported by the gate but is not a finalization blocker: budgets stop further autonomous work, not the commitment of work that is already complete.

`PolicyEvaluated` is audit evidence only. The kernel recomputes and compares its result at append time. A Workflow participant may make a workflow-scoped `CommitmentRequested` only immediately after a passing policy evaluation, and the kernel recomputes the gate on both request and acceptance. A request does not freeze the Workflow; later work may make the gate fail. The Supervisor can explicitly reject the request, or accept it while the current gate still passes. Only `CommitmentAccepted` by the Supervisor resolves the Workflow.

Conversation responses, STAMP reactions, Quorum votes, Acceptance Criteria, and Commitments remain distinct domain concepts. The kernel never automatically converts one into another.

## COORD-2C: usage, progress, and audit projection

`UsageRecorded` is a Supervisor-owned, Workflow-scoped record of LLM resources that have already been consumed. It may therefore be appended while a Workflow is `SUSPENDED` or `BLOCKED`, and may reach or exceed a budget without being rejected or changing Workflow state. The Runner must inspect `findExhaustedBudget` before starting another round; budget exhaustion is not Workflow failure or commitment rejection.

`ProgressRecorded` records the result of exactly one coordination round. `PROGRESS` resets both the error and no-progress streaks; `NO_PROGRESS` increments the no-progress streak and resets consecutive errors; `ERROR` increments both streaks. Unlike generic audit-oriented `ErrorRecorded`, only `ProgressRecorded(ERROR)` changes round-level budget counters. Progress never satisfies Acceptance Criteria or completes the Workflow.

Workflow usage is replayed from `UsageRecorded` and `ProgressRecorded` journal events during snapshot validation, preventing forged counters. Event timestamps are finite, non-negative, monotonic, and anchor `run.updatedAt`; runtime enum, array, object timestamp, current-session, and policy structure invariants fail closed.

`buildCoordinationAuditView(snapshot, now)` validates authoritative state and derives a deterministic, read-only-by-isolation view of Workflow metadata, counts, acceptance, usage, budget exhaustion, latest progress, commitment, and the event trail. It performs no LLM summarization and persists no audit state.

Runtime and restored journals share a closed event-type allowlist and minimal Workflow lifecycle checks for usage and progress. Domain-object timestamps remain within the Workflow journal timeline. Audit wall-time continues through running and stopped states, but freezes at `run.updatedAt` once a Workflow is terminal.


## COORD-3A: bounded autonomous runner core

`createCoordinationRunner(dependencies)` exports `runOneRound(runId, { signal? })`,
`runUntilStop(runId, { signal? })`, `stop(runId)`, and `isRunning(runId)` through
`services/coordination/index.ts`. The runner is orchestration, not authoritative
state: every state change passes through the store's `append`, which applies
`appendEvent` to the latest snapshot. In-memory stores clone their inputs and
outputs. Runner code never edits snapshot projections.

A round follows PRECHECK → PLAN → PREPARE/ASSIGN → POLICY → EXECUTE → COLLECT →
VERIFY → DECIDE. It performs at most one external action. `runUntilStop` repeats
rounds until completion, a stop, user intervention, an error, or a budget limit.
A process-local lock rejects simultaneous starts for the same workflow ID across
runner instances and is released in `finally`. Only `supervised_autonomous`
workflows run. Active manual sessions prevent autonomous work; a single runner
session takes precedence over new planning. Multiple active runner sessions are
ambiguous and stop execution.

Before new work and after completed rounds, the runner checks the commitment
gate before the budget. A passing gate deterministically appends
`PolicyEvaluated` → `CommitmentRequested` → `CommitmentAccepted`, or accepts an
existing request. No model decides completion. Budgets prevent new autonomous
work but do not prevent finalization. Exhaustion blocks with
`RUNNER_BUDGET_EXHAUSTED:<field>` and never automatically fails or cancels a
workflow. Model usage can overshoot by one in-flight call; VERIFY budget exhaustion
closes its terminal task's session with `NO_PROGRESS` before blocking.

### Provider and executor boundaries

`RunnerSupervisorProvider.plan` returns a typed execute, finish, or needs-user
proposal; `verify` returns PASS/FAIL/INCONCLUSIVE and per-criterion semantic
judgments. Proposals are untrusted and runtime validated. Provider requests
contain an audit projection with at most 20 trail entries, never the full
journal, and an explicit `systemContract` that adapters must include in their
system instructions. Executor and external evidence are untrusted data: their
instructions cannot establish user approval, policy, or tool authority.
Providers must not mutate workflows, append events, or invoke executors.

`RunnerActionExecutor.prepare` is side-effect free: it validates, normalizes,
classifies, and fingerprints the proposed action. The executor determines
`actionClass`, not the model. Each action ID must be unique within its workflow;
its fingerprint must bind the complete normalized payload and operation.
`publicSummary` must be safe for the journal and contain no credentials or raw
form values. Session/task descriptions use that public summary; private payloads
remain exclusively in `RunnerPendingActionStore`. The runner stores only an
opaque action reference on the task. Prepared payloads must be structured-cloneable.

`execute` receives workflow/session/task IDs and the combined abort signal. It
returns succeeded, failed, uncertain, or aborted, with a nonempty summary and
optional evidence references. Raw results are retained in `RunnerEvidenceStore`;
only opaque references reach the task journal. Referenced evidence must be
retrievable through the injected store before verification; missing evidence
fails the round closed. The runner derives event IDs, sequence numbers, actors,
monotonic timestamps, and acceptance evidence IDs itself.

Optional `RequestScheduler` integration uses the `coordination` job kind and the
provider's `scheduling` identity for concurrency and cancellation. It rechecks
state and budget after queue wait. The runner disables scheduler retries around
an entire provider adapter, since otherwise failed attempt usage could be lost.
Adapters own any bounded provider retries and must aggregate actual provider
attempt counts and resources in `usage`, including known usage on thrown errors.
Scheduler's existing bounded transient retry behavior remains available to
adapter-level jobs and unchanged for other job kinds. No real model adapter is
introduced in this PR.

### Risk and exact approval continuation

`evaluateRunnerActionRisk` calls the deterministic kernel policy evaluator;
unknown classes require human review. ALLOW executes. DENY never executes and
cannot be overridden by user authorization: it fails the task, resolves its
session as FAILED, and records `NO_PROGRESS`.

NEEDS_USER preserves the prepared action, leaves its task ASSIGNED, and appends
`WorkflowBlocked` with `RUNNER_NEEDS_USER:<approvalRef>`. The returned
`pendingApproval` includes the action ID, fingerprint, class, and public summary.
No round Progress is recorded while waiting. The reference is
`map.runner.approval.v1:<workflowRunId>:<actionId>:<fingerprint>`; each component
is URI-encoded to avoid delimiter collisions.

The user-facing adapter, never the runner, appends `WorkflowResumed` with
`authorization: { type: 'user', reference: approvalRef }`. The integration must
establish real user authorization before writing this event. On continuation,
the runner rechecks current policy and requires the latest resume to follow the
matching block and carry that exact reference. Wrong/missing references reblock
the same action without executing or incrementing Progress. A missing or
mismatched pending payload fails the task with
`RUNNER_PENDING_ACTION_UNAVAILABLE`. Approval is neither a policy rewrite nor
permission for a different action.

Immediately before execution, the pending payload is consumed. External actions
are never automatically retried, regardless of `retrySafety`. An executor throw,
invalid result, or aborted result is treated as uncertain: TaskFailed
(`EXECUTION_UNCERTAIN`), failed session, ERROR progress, and
`RUNNER_EXECUTION_UNCERTAIN:<actionId>` blocking. This takes precedence over
ordinary runner cancellation when the workflow is still writable.

### Usage, verification, progress, and interruption

PLAN/VERIFY usage is validated and recorded immediately on the latest snapshot,
including known usage on errors and stale or stopped model results. Responses
from stale PLAN or VERIFY calls are discarded. Kernel terminal immutability
still applies: if another actor terminalizes the workflow during a call, no
late result or Usage event can be appended. Providers must retain their own
billing telemetry for that terminal-race case; this PR does not relax Kernel
terminal rules.

Task success alone never satisfies acceptance. The runner converts semantic
verification into `EvaluationAdded` and `AcceptanceCriterionEvaluated`, citing
actual journal evidence. It then resolves the session and records Progress
exactly once under a round-specific idempotency key: completed task plus PASS
is PROGRESS, completed task plus FAIL/INCONCLUSIVE is NO_PROGRESS, execution or
provider/internal error is ERROR, and policy denial is NO_PROGRESS. Planner
finish without gate pass is NO_PROGRESS, not completion.

Abort signals propagate to provider, scheduler, and executor. `stop` aborts
first, waits for in-flight work to settle, then suspends a still-running workflow
at a safe point. Stopped/terminal workflows are never implicitly resumed. Known
execution results that arrive while stopped are retained in memory and can be
collected after explicit resume without reexecution, including through another
runner instance sharing the same store. Terminal tasks in open runner sessions
continue at verification instead of starting a new plan.

The runner, pending actions, evidence, and retained execution results are
in-memory PoC state, not durable unattended-runtime infrastructure. Process loss
can lose pending payloads and results; restored tasks must fail closed rather
than recreate or retry a side effect. There is no distributed lock, persistent
checkpoint, restart recovery, or guarantee of more than four hours of runtime.
Durability belongs to COORD-5. Browser execution is deferred to COORD-3B as an
additional `RunnerActionExecutor`; no DOM, Playwright, UI, Gemini adapter, dynamic
tool discovery, or MACP integration is included here.
