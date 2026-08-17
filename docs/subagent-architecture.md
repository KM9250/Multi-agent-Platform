# SubAgent architecture (Phases SA-0 and SA-1)

SA-0 established the private execution foundation. SA-1 adds an opt-in fixed-serial private pipeline and Persona-only ephemeral report injection. SA-2 may add dynamic routing in the future; SA-1 does not implement it.

## Boundary

The **Conversation Plane** contains Rooms, persona Agents, messages, decisions, relationships, memory behavior, and internal-state separation. A SubAgent is not a persona and is never inserted into `Room.agents`.

The **Task Execution Plane** accepts only a `SubAgentDefinition` and an explicit `SubAgentTaskContract`, calls a registered provider, validates a structured `SubAgentTaskResult`, and returns it privately to its caller. It neither imports conversation types nor creates messages or decision events.

## Contract and result

Contracts identify the parent and worker, state a goal and task type, and contain only explicitly selected text inputs, constraints, acceptance criteria, and generic metadata. They never contain a Room, conversation history, persona Agents, or internal-state settings. Results preserve the task and worker IDs and represent completed, failed, or aborted outcomes. Empty, malformed, or mismatched results fail closed.

## Providers and runs

`SubAgentProviderRegistry` resolves providers strictly by ID; no provider receives an implicit Google fallback. The Google implementation is the only real SA-0 connector, while tests and future integrations can inject any implementation of `SubAgentProvider` without changing the runner.

Each `SubAgentRun` has its own run ID, lifecycle, and runtime `AbortController`. It is separate from the Conversation Plane's `GenerationSession`. A parent abort signal is forwarded to only that run and then to its provider request, so independently created runs can execute concurrently without sharing cancellation state.

## Information isolation

The prompt is built solely from the explicit contract. Room history, self-only memory, `private_state`, `debug_thoughts`, `gm_log`, and `memory_export` are not discovered or injected. Results are not converted into message segments or appended to `Room.messages`; the SA-1 bridge can only consume their validated, sanitized projection.

## SA-1 fixed serial bridge

After decisions, each responding Persona whose policy is `fixed_serial` runs enabled workers once in configured array order. Each worker receives a separate SA-0 contract containing only the latest user content and that message's text attachments. Images contribute a filename-only unavailable note. Later workers additionally receive JSON made from earlier validated reports, never raw provider output. Failure stops dependent workers but the Persona remains available; abort stops both pipeline and Persona generation. A generation-session-local cache avoids repeated calls during recursive turns, while retry and regenerate create fresh caches. `/memory` bypasses workers.

Sanitized reports are untrusted advisory data in only the owning Persona's current provider call. They are never messages, decision input, other-Persona history, relationships, memory, or persisted state. Logical `capabilities` are role labels, not tools: SA-1 registers no search, grounding, code execution, or other external tool.

## Provider tool naming principle

If tools are added later, prompts must state the exact tool name actually registered by the provider runtime, its purpose, and conditions for use—not merely an abstract capability label. A prompt must never claim that a tool is available when runtime has not registered it. For example, a future logical `web_search` capability could map to an explicitly registered `google_search` tool displayed as “Grounding with Google Search”; that mapping and tool are intentionally not implemented in SA-1.

## Future boundaries

The generic contract can later be adapted to a formal `agent-task-harness` schema without introducing Platform Room types. MACP remains a separate future path for persona-to-persona or remote-agent communication. Neither project is connected in SA-0, and no role-specific workers or automatic selection behavior are included.
