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
- Task-mode Session resolution requires at least one Task and requires every Task to be terminal. A successful result additionally requires at least one completed Task. Decision and quorum resolution remain deferred to COORD-2B.
- Only the configured Supervisor can accept a commitment, and only against an existing, open Session belonging to that Workflow. Full commitment-policy evaluation and acceptance-criteria enforcement are deferred to COORD-2.
- New Sessions must be open, policy-bound, owned and initiated by Workflow participants, and include the configured Supervisor; duplicate Session IDs are rejected.
- Terminal Workflows (`RESOLVED`, `CANCELLED`, and `FAILED`) reject all later events except an exact idempotent retry. `BLOCKED` and `SUSPENDED` are non-terminal stopped states in which no coordination work proceeds.
- A `SUSPENDED` or `BLOCKED` Workflow never resumes implicitly. `WorkflowResumed` requires an explicit user authorization carried by a Supervisor event. Stopping suspends every open Session, and resuming reopens suspended Sessions without changing terminal Sessions.
- In this foundation kernel, `CommitmentAccepted` is the final Workflow-level commitment and is rejected while any other Session remains open or suspended. Intermediate Session commitment and resolution semantics are deferred to COORD-2.
- Suspension, blocking, resumption, and cancellation are explicit durable events. Cancellation closes all active Sessions and assigned Tasks while preserving already-terminal Tasks.

## Delivery roadmap

- **COORD-0:** typed conversation recipients, participation profiles, and non-triggering STAMP outcomes.
- **COORD-1:** provider/model scheduler, backpressure, bounded retry with jitter, and queue cancellation.
- **COORD-2A:** multiple Session and Task lifecycles, immutable policy snapshots, explicit stop/resume, snapshot validation, and journal mutation protection.
- **COORD-2B+:** Decision, Quorum, acceptance-criterion evaluation, and the Workflow-level commitment gate.
- **COORD-3:** browser PoC for the bounded PLAN/ASSIGN/EXECUTE/COLLECT/VERIFY/DECIDE recipe.
- **COORD-4:** terminal and `NEEDS_USER` notifications through MACP-Command.
- **COORD-5:** UI-independent durable runtime, checkpoint recovery, and idempotent restart.
- **COORD-6:** SA-2 private-worker routing and risk-classified tools.

Browser hosting is only a PoC. Formal unattended operation requires the durable runtime because reloads, OS sleep, browser crashes, and background throttling cannot be controlled by React state or `localStorage`.

Full replay, persistent stores, checkpoint restore, autonomous runners, browser execution, MACP bridges, and durable runtime remain future responsibilities.
