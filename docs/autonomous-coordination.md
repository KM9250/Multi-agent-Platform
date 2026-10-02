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
- **COORD-3:** browser PoC for the bounded PLAN/ASSIGN/EXECUTE/COLLECT/VERIFY/DECIDE recipe.
- **COORD-4:** terminal and `NEEDS_USER` notifications through MACP-Command.
- **COORD-5:** UI-independent durable runtime, checkpoint recovery, and idempotent restart.
- **COORD-6:** SA-2 private-worker routing and risk-classified tools.

Browser hosting is only a PoC. Formal unattended operation requires the durable runtime because reloads, OS sleep, browser crashes, and background throttling cannot be controlled by React state or `localStorage`.

Full replay, persistent stores, checkpoint restore, autonomous runners, browser execution, MACP bridges, and durable runtime remain future responsibilities.

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

`UsageRecorded` is a Supervisor-owned, Workflow-scoped record of LLM resources that have already been consumed. It may therefore be appended while a Workflow is `SUSPENDED` or `BLOCKED`, and may reach or exceed a budget without being rejected or changing Workflow state. The future Runner must inspect `findExhaustedBudget` before starting another round; budget exhaustion is not Workflow failure or commitment rejection.

`ProgressRecorded` records the result of exactly one coordination round. `PROGRESS` resets both the error and no-progress streaks; `NO_PROGRESS` increments the no-progress streak and resets consecutive errors; `ERROR` increments both streaks. Unlike generic audit-oriented `ErrorRecorded`, only `ProgressRecorded(ERROR)` changes round-level budget counters. Progress never satisfies Acceptance Criteria or completes the Workflow.

Workflow usage is replayed from `UsageRecorded` and `ProgressRecorded` journal events during snapshot validation, preventing forged counters. Event timestamps are finite, non-negative, monotonic, and anchor `run.updatedAt`; runtime enum, array, object timestamp, current-session, and policy structure invariants fail closed.

`buildCoordinationAuditView(snapshot, now)` validates authoritative state and derives a deterministic, read-only-by-isolation view of Workflow metadata, counts, acceptance, usage, budget exhaustion, latest progress, commitment, and the event trail. It performs no LLM summarization and persists no audit state.
