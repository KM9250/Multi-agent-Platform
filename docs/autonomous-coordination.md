# Autonomous coordination architecture

MAP keeps four responsibilities separate:

1. **Conversation** carries persona interaction and non-binding signals.
2. **Coordination** owns bounded workflows, sessions, governance, decisions, and commitments.
3. **Task execution** keeps Private SubAgents inside their owning Persona boundary.
4. **MACP-Command** is asynchronous human I/O, not the workflow engine.

The initial kernel is **MACP-Coord Level 1 adapter-ready**, not wire-compatible. It uses the local mode identifiers `map.coord.task.v1`, `map.coord.decision.v1`, and `map.coord.quorum.v1`; an adapter may later map these to draft external identifiers without coupling the core to that draft.

## Invariants implemented by the domain kernel

- Every workflow binds one policy ID and version; a session must bind the same pair.
- Autonomous budgets contain only finite, positive limits. Zero never means unlimited.
- Unknown action classes evaluate to `NEEDS_USER`.
- Only Persona IDs listed on the workflow may participate in a coordination session. Private SubAgents remain invisible to this layer.
- The journal is append-only, ordered, and idempotent for repeated external actions.
- `TaskCompleted` is evidence, not terminal state. Only an accepted `Commitment` resolves a workflow/session.
- Only the configured Supervisor can accept a commitment, and only against an existing, open Session belonging to that Workflow. Full commitment-policy evaluation and acceptance-criteria enforcement are deferred to COORD-2.
- New Sessions must be open, policy-bound, owned and initiated by Workflow participants, and include the configured Supervisor; duplicate Session IDs are rejected.
- Before COORD-2 introduces intermediate Session resolution, a Workflow may have at most one open or suspended Session. This prevents multiple unresolved Sessions from blocking the final Workflow-level commitment.
- Terminal Workflows (`RESOLVED`, `CANCELLED`, and `FAILED`) reject all later events except an exact idempotent retry. `BLOCKED` remains non-terminal, but it is a stopped state: no coordination work proceeds until a future explicit resume transition is introduced.
- A `SUSPENDED` Workflow performs no further coordination work. Only cancellation and error/audit recording are accepted until a future explicit resume event is introduced; suspension never implicitly returns to `RUNNING`.
- In this foundation kernel, `CommitmentAccepted` is the final Workflow-level commitment and is rejected while any other Session remains open or suspended. Intermediate Session commitment and resolution semantics are deferred to COORD-2.
- Suspension and cancellation are explicit durable events. Cancellation closes all open or suspended sessions.

## Delivery roadmap

- **COORD-0:** typed conversation recipients, participation profiles, and non-triggering STAMP outcomes.
- **COORD-1:** provider/model scheduler, backpressure, bounded retry with jitter, and queue cancellation.
- **COORD-2:** extend this kernel with Task, Decision, Quorum, commitment-policy evaluation, snapshots, and audit views.
- **COORD-3:** browser PoC for the bounded PLAN/ASSIGN/EXECUTE/COLLECT/VERIFY/DECIDE recipe.
- **COORD-4:** terminal and `NEEDS_USER` notifications through MACP-Command.
- **COORD-5:** UI-independent durable runtime, checkpoint recovery, and idempotent restart.
- **COORD-6:** SA-2 private-worker routing and risk-classified tools.

Browser hosting is only a PoC. Formal unattended operation requires the durable runtime because reloads, OS sleep, browser crashes, and background throttling cannot be controlled by React state or `localStorage`.

Before COORD-5 durable restart support, persist either the immutable policy snapshot or a canonical policy hash with each Workflow. A policy ID and version alone cannot prove which policy content was used after recovery.

Before durable persistence, also establish an immutable journal serialization boundary so later caller mutation cannot alter an already-recorded event or payload.
