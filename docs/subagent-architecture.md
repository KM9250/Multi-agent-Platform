# SubAgent architecture (Phase SA-0)

## Boundary

The **Conversation Plane** contains Rooms, persona Agents, messages, decisions, relationships, memory behavior, and internal-state separation. A SubAgent is not a persona and is never inserted into `Room.agents`.

The **Task Execution Plane** accepts only a `SubAgentDefinition` and an explicit `SubAgentTaskContract`, calls a registered provider, validates a structured `SubAgentTaskResult`, and returns it privately to its caller. It neither imports conversation types nor creates messages or decision events.

## Contract and result

Contracts identify the parent and worker, state a goal and task type, and contain only explicitly selected text inputs, constraints, acceptance criteria, and generic metadata. They never contain a Room, conversation history, persona Agents, or internal-state settings. Results preserve the task and worker IDs and represent completed, failed, or aborted outcomes. Empty, malformed, or mismatched results fail closed.

## Providers and runs

`SubAgentProviderRegistry` resolves providers strictly by ID; no provider receives an implicit Google fallback. The Google implementation is the only real SA-0 connector, while tests and future integrations can inject any implementation of `SubAgentProvider` without changing the runner.

Each `SubAgentRun` has its own run ID, lifecycle, and runtime `AbortController`. It is separate from the Conversation Plane's `GenerationSession`. A parent abort signal is forwarded to only that run and then to its provider request, so independently created runs can execute concurrently without sharing cancellation state.

## Information isolation

The prompt is built solely from the explicit contract. Room history, self-only memory, `private_state`, `debug_thoughts`, `gm_log`, and `memory_export` are not discovered or injected. Results are not converted into message segments or appended to `Room.messages`; a future parent-persona integration must decide explicitly how to use them.

## Future boundaries

The generic contract can later be adapted to a formal `agent-task-harness` schema without introducing Platform Room types. MACP remains a separate future path for persona-to-persona or remote-agent communication. Neither project is connected in SA-0, and no role-specific workers or automatic selection behavior are included.
