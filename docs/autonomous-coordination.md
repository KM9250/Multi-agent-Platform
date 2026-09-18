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
- Only the configured Supervisor can accept a commitment; the Supervisor cannot bypass policy evaluation.
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
