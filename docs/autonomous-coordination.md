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

Persistent stores, checkpoint restore, unrestricted external-site execution, MACP bridges, and durable runtime remain future responsibilities.

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


### Workflow ownership and ephemeral cleanup

Pending actions use `RunnerPendingActionRecord { workflowRunId, sessionId,
taskId, action }`. `get(workflowRunId, actionId)` and
`delete(workflowRunId, actionId)` always require the workflow namespace. The
in-memory store uses nested maps: duplicate action IDs are rejected within one
workflow and permitted across workflows. Session/task IDs are generated before
registration; failed SessionStarted/TaskAssigned appends remove the ephemeral
registration without rolling back Kernel events.

Before policy evaluation or approval, the runner checks the record's workflow,
session, task, action ID, and fingerprint against the authoritative task and its
input reference. A mismatch fails that task closed and never deletes another
owner's action. An exact approval reference does not replace ownership checks.

Retained execution results use nested workflow/task maps and also bind the
session, action ID, and fingerprint. Identical IDs in two workflows cannot share
results or cause a TaskCompleted event in the other workflow. Collection and
session completion remove only the corresponding workflow/task entry.

When the runner observes RESOLVED, CANCELLED, or FAILED at a safe point or in
its final cleanup, it idempotently drops that workflow's retained results and
any referenced pending actions whose ownership matches. It preserves other
workflows, all evidence, and SUSPENDED/BLOCKED results needed for explicit
resume and collection without reexecution. No background observer is provided:
terminal cleanup is guaranteed when the runner observes terminal state, not
immediately during periods in which the runner is idle. Durable lifecycle
observation and evidence retention remain COORD-5 work.

Incomplete runner task registration cancels only its own empty OPEN session while RUNNING, preserving the journal; stopped workflows recover that empty session after explicit resume.
Registration recovery reuses the original round key for exactly-once ERROR progress and never repairs manual sessions, multiple-task sessions, or malformed round markers.

## COORD-3B: safety-gated browser PoC

`createBrowserPocExecutor({ driver, evidenceStore, ids?, clock? })` registers as
`browser` in the existing Runner executor registry. This PoC controls only the
same-origin MAP sandbox explicitly supplied to `DomSandboxBrowserDriver`.
It cannot navigate to arbitrary URLs, execute JavaScript/selectors/XPath supplied
by a planner, operate outside the pinned root, access credentials/storage/cookies,
upload/download files, or issue network requests/native form submission.

### Operations, immutable policy, and trusted targets

Copy `BROWSER_RISK_RULES` into the policy passed to `createWorkflow`; the Kernel
captures that immutable policy snapshot. The executor never changes policy.

| Operation | Action class | Initial policy | Allowed effect |
| --- | --- | --- | --- |
| navigate | browser.navigate | ALLOW | Switch registered `form` / `result` page |
| read | browser.read | ALLOW | Structured page / target observation |
| input | browser.input | NEEDS_USER | Local text field state transition |
| interact | browser.interact | NEEDS_USER | Checkbox, allowlisted option, preview |
| submit | browser.submit | NEEDS_USER | Local status and exact submit count |

Runtime validation rejects unknown operations, malformed values, executable
selectors, arbitrary URLs and unknown target IDs. Classification comes from
validated operations and trusted target capabilities, never `arguments.actionClass`
or a proposed fingerprint. Submit/navigation-capable targets cannot be clicked
through `interact`. Password, hidden, file and credential fields are excluded.
Read is retry-safe; all state transitions, including navigation, use `never`.
The Runner consumes each prepared action before dispatch and never retries it.

The driver owns only sandbox effects and observation. It never evaluates policy,
approves an action or changes Workflow state. `BrowserSandboxController` is the
shared source of truth for the DOM driver and `InMemoryBrowserPocDriver` used by
Node tests. React subscribes to its synchronous transitions with `flushSync`;
changing a DOM input alone is rejected as state desynchronization. The fixed
`data-browser-id` registry is resolved only inside the supplied root. Duplicate,
missing, replaced, detached, disabled or role/type-mismatched targets fail closed.
Registry metadata and option values originate in trusted code, not DOM claims.
All seven target elements remain mounted; page visibility changes through state.
No native click, form.submit, form.requestSubmit, fetch or browser navigation is
used by the driver. Buttons labelled Submit have HTML `type="button"`.

### Fingerprints, preconditions and privacy

Prepared payloads are structured-cloneable `{ schemaVersion: 1, surfaceId,
operation, command, stateToken }`. The executor computes canonical SHA-256 over
schema version, executor ID, surface, operation, authoritative action class,
normalized command (including private input value) and the trusted state token.
Action IDs remain unique independently of deterministic fingerprints.

The token hashes the complete driver snapshot: surface/page identity, revision,
target IDs/roles/capabilities, disabled flags, relevant control state, visible text
and submission state. Tokens supplied in proposals never replace inspection.
Execute revalidates the payload and public metadata, recomputes the fingerprint,
and reinspects the surface. This PoC conservatively requires the same token for
all five operations. A changed token returns `BROWSER_STALE_STATE` without a
transition; it never silently reprepares or reuses approval for the new state.
The driver also compares the exact inspected snapshot synchronously immediately
before transition, closing the executor's asynchronous hashing/inspection gap.
This guard is mandatory for direct driver dispatch too. New drivers must preserve
that atomic precondition/transition contract.

Public summaries are fixed trusted text, independent of page labels and input
values. Input remains in the pending payload only; it does not enter Task titles,
goals, approval summaries, execution summaries, the Journal or input Evidence.
Read observations redact control values as well. Fingerprints are bindings,
not encryption: do not enter real secrets or credentials into the sandbox.

### Evidence and external-content trust

Evidence kinds are `browser.observation.v1`, `browser.navigation.v1`,
`browser.input.v1`, `browser.interaction.v1`, `browser.submission.v1` and
`browser.trust-assessment.v1`. Successful results expose opaque evidence refs
through `RunnerEvidenceStore`; missing evidence fails closed. The executor also
establishes and reads back the `runner.execution` envelope before returning
success, so COLLECT needs no additional evidence write. Read-back content must
match the evidence that was written. Submission evidence
includes target ID, previous/new state token, count and result status, not inputs.

Observation contains bounded text and controls, never raw HTML, scripts/styles,
event handlers or hidden/password fields. Limits are 50 text blocks, 100 controls,
1,000 characters per text item, 20,000 total text characters (including labels and
options), and 50 options per control. Truncation is explicit and requires review;
it is never treated as harmless missing content. Unsupported visible controls,
embedded content and visibility gaps require review. Read-target filtering happens
only after the whole visible page and all visible labels/options have been checked.

`assessBrowserContent` is a deterministic, English/Japanese PoC detector with
NFKC/case/whitespace normalization. It checks instruction attempts, system/developer
authority spoofing, fake user approval, tool redirection, goal substitution,
exfiltration requests and ambiguous/indirect instructions. It checks before
all operations, including mutating dispatch, and again on the resulting surface.
The page cannot declare its own trust or authority. `DATA_ONLY` means no known
instruction pattern was identified; it does not authenticate the page or prove
its safety. `NEEDS_REVIEW`, incomplete visibility and security-relevant truncation
produce a SafetyHold even if the action's policy was ALLOW. Observations remain
untrusted data; the existing `RUNNER_PROVIDER_SYSTEM_CONTRACT` is unchanged.

### SafetyHold, security review and resumption

The only Runner contract addition is optional `RunnerExecutionResult.safetyHold`:

```ts
{
  kind: 'untrusted-content',
  effectState: 'not_dispatched', // or 'applied'
  reasonCode: 'CONTENT_REVIEW_REQUIRED',
  reviewRef: 'map.runner.security-review.v1:<encoded-workflow>:<encoded-task>:<encoded-sha256>',
  safeSummary: 'Untrusted content requires user review.'
}
```

The executor generates the task/workflow-bound reference using a fresh random
nonce. Runtime validation restricts kind/reason/summary/ref/effectState and rejects
extra fields; Runner COLLECT checks ownership. Safe trust assessments are kept
in memory. On the hold path no raw suspicious text is persisted or automatically
forwarded to either model phase. The Runner journals only its safe reason and
opaque reference and effect state, through this sequence:

```text
TaskFailed → SessionResolved(FAILED) → ProgressRecorded(ERROR)
           → WorkflowBlocked(RUNNER_UNTRUSTED_CONTENT:v1:<encodeURIComponent(reviewRef)>|effect=<effectState>)
```

No VERIFY, next PLAN, automatic Workflow failure/cancellation, or Action Approval
occurs on this path. Pending actions/results are discarded. Partial journal writes
are recovered before any later PLAN/VERIFY with exactly-once round progress.
If the effect outcome is actually unknown, `uncertain` retains priority and uses
the existing `RUNNER_EXECUTION_UNCERTAIN` behavior. A known pre-dispatch abort is
`failed / BROWSER_ABORTED_BEFORE_DISPATCH`; a lost dispatch result is `uncertain`.
Finding suspicious prose alone is never an uncertain effect.

`RunnerSafetyHoldEffectState = 'not_dispatched' | 'applied'` records the effect
of the held action, not the state of the entire Workflow. Pre-dispatch holds use
`not_dispatched`. After a trusted Driver confirms navigation/input/interact/submit,
a hold uses `applied`; post-read holds use `not_dispatched` because read has no
state-changing effect. Unknown Driver results keep the existing uncertain path
and must not be labelled applied. The Executor supplies effectState from its
execution stage, never from proposal arguments, labels or external text.
**TaskFailed does not mean the browser action had no effect, and discarding
suspicious evidence does not undo an applied action.**

Both TaskFailed.failureReason and WorkflowBlocked.reason use the versioned format
above. Shared `formatSecurityHoldReason` / `parseSecurityHoldReason` helpers encode
and recover the exact reviewRef and allowlisted effectState, including escaped IDs.
Extra fields, invalid refs, unknown states/versions, and legacy reasons without an
effect state are rejected. Invalid journal metadata reblocks for cancellation or
trusted investigation; the UI does not offer a review-resume action for it. The
Runner additionally binds the reference to the held task, Workflow and latest hold.
Partial append recovery preserves the same effectState after ephemeral results
are discarded, with no repeat dispatch and exactly-once progress.

After a Driver-confirmed result, failures while computing the new state token,
writing observation/trust/execution evidence, or verifying any read-back return
`uncertain / BROWSER_EVIDENCE_UNAVAILABLE_AFTER_DISPATCH`. The existing
`RUNNER_EXECUTION_UNCERTAIN` path blocks before VERIFY or a new PLAN, including
for read. In this case uncertain means **a verifiable execution result could not
be established**, even if the Driver confirmed that the effect was applied. It
is distinct from `BROWSER_UNKNOWN_OUTCOME`, which means the Driver outcome itself
is unknown. No automatic dispatch retry or evidence-write retry is performed.
Pre-dispatch validation, stale state, capability failures and abort retain their
existing failed/no-effect behavior. The optional diagnostic trust-assessment copy
on a SafetyHold path is best-effort: even if unavailable, the hold still blocks
and the known effect is recorded in the Journal. No raw diagnostic is journaled.

A trusted user adapter may only (1) discard suspicious material and replan from the
original Workflow goal, or (2) explicitly cancel the Workflow. To choose (1),
it must confirm the current review reference and append the existing event:

```ts
WorkflowResumed({ authorization: { type: 'user', reference: reviewRef } })
// Use only reviewRef, never the formatted reason or its effect suffix.
```

The Kernel requires user authorization but does not interpret this reference.
Runner preflight checks the **first resume after the latest security block** for
an exact reference match. Missing, wrong, ordinary action approval, cross-workflow,
cross-task and past-review references reblock. A new hold always gets a new ref.
Once that review is resolved, later ordinary action approvals retain their existing
semantics. Security review never authorizes a DENY action. Closed held tasks are
never reexecuted: the next PLAN gets the original goal and safe audit, no suspicious
proposal or raw Evidence. Revisiting the same suspicious page holds again.
There is deliberately no “follow the suspicious instruction” resolution option.
The development provider begins review recovery with a newly prepared read to
inspect the current state, including after an applied submit. Releasing that hold
must not increment submitCount again. Other provider integrations must likewise
start applied-hold recovery with read-only inspection; any subsequent mutation is
a new proposal subject to its immutable policy and a fresh exact Action Approval,
never the security review reference or an old action/fingerprint.

Runner core changes are limited to the SafetyHold type/validation, COLLECT handling,
security preflight/recovery, VERIFY evidence review and the browser exports. Kernel, coordination validation,
completion, usage, Scheduler, SubAgents and event types are unchanged.

### Runner VERIFY evidence loss

After the Executor has established its result and `TaskCompleted` is journaled,
Runner retrieves that evidence again for VERIFY. A missing value, storage exception,
or invalid minimum evidence structure (`kind` nonempty string, own `content` field,
finite nonnegative `createdAt`) is a dedicated `RunnerVerifyEvidenceUnavailable`.
Content meaning is not assessed here. Provider errors, invalid verification results,
scheduler deferrals, stale verification and budget handling retain their existing
semantics; they are not reclassified as evidence loss.

The Runner rechecks the latest workflow, task and session before recording
`WorkflowBlocked`. The reason contains only:

```text
RUNNER_VERIFY_EVIDENCE_UNAVAILABLE:<reviewRef>
map.runner.verify-evidence-review.v1:<encoded workflowId>:<encoded taskId>:<encoded opaqueId>
```

The workflow becomes BLOCKED and its session SUSPENDED; the task stays COMPLETED
(or FAILED if execution originally failed). The Runner does not close the session,
record final Progress, recreate a pending action, call VERIFY, or start another PLAN.
Raw evidence, private inputs and exception diagnostics are absent from the reason.

A trusted user adapter must explicitly confirm the current evidence review and
append `WorkflowResumed({ authorization: { type: 'user', reference: reviewRef } })`.
Use the reference after the reason prefix. It authorizes retrieval and VERIFY for
the same terminal task, never another Executor call. This review is separate from
both ordinary Action Approval and Security Review: neither substitutes for it, and
it cannot discharge either of those authorizations. Runner preflight binds the
first resume after the latest evidence block to its workflow, task and exact
reference, before any evidence retrieval, VERIFY, PLAN or execution. Missing, wrong,
cross-workflow, cross-task and past references reblock without attempting retrieval.

If evidence is recovered, normal VERIFY/evaluation/session resolution resumes and
Progress is recorded once using the original round key. If retrieval fails again,
a new review reference (including a fresh journal sequence and generated ID) is
required. A correctly resolved historical review does not interfere with later
ordinary action approvals. Cancellation remains possible and does not undo the
completed task or any applied external effect. The development UI has no dedicated
evidence recovery control; this path currently requires a trusted adapter.

If retrieval finishes or throws after a suspend/block, the Runner preserves that
stop without a duplicate block. After terminalization it appends no late events
and runs existing cleanup. If the evidence block append throws, the Runner rereads
the snapshot: a committed block with a lost acknowledgement is observed without
writing it again; an uncommitted write returns `error / RUNNER_INTERNAL_ERROR`.
That invocation performs no retry, next PLAN or additional execution. **Without a
committed block, persistent review gating cannot be guaranteed**: the workflow can
still be RUNNING with its terminal task and open session. A later explicit Runner
invocation may retry retrieval/VERIFY. Journal durability/recovery is outside this
change; no permanent hold is claimed for an uncommitted event.

### Running the development sandbox

Run `npm install`, then `npm run dev`, and open
`http://localhost:3000/browser-poc.html`. This separate Vite development entry is
not included in the production build and is not attached to the Conversation Plane.
It uses a scripted PLAN/VERIFY provider, not Gemini or another actual model.

1. Choose `read` and Start workflow: ALLOW leads to structured Evidence and VERIFY.
2. Choose `input`, `interact`, or `submit`: the Workflow stops first. Approve this
   exact action to execute it once; `submit` increments the displayed count by one.
3. While an action is blocked, change a sandbox field/page manually, then approve:
   the old action fails its state precondition and makes no further change.
4. Choose `navigate` to switch between Form and Result, including the displayed
   local submission state. Form controls can also be operated manually.
5. Insert suspicious content, then start a read: it stops for security review and
   displays a dedicated discard/replan button, never the action-approval button.
6. Restore ordinary content and select Discard suspicious evidence and replan:
   a fresh read is planned. Without restoring content, it safely holds again.
   Cancel workflow is the other explicit resolution.
7. For a post-dispatch hold, restore ordinary content, enable “Show suspicious
   content after next local submit”, then start and approve a submit. The security
   review panel shows **Applied**, and the count increases exactly once. Restore
   ordinary content and discard/replan; the count stays unchanged during the fresh
   read. Pre-dispatch holds show **Not dispatched**. Both labels come only from
   parsed Journal metadata, not the external content or the current DOM state.

The screen is a development harness, not a production approval interface. Its
scripted verifier checks local result/evidence presence for demonstration; it is
not a general semantic verifier. No external website, real POST, authentication,
file transfer, purchase, email or SNS operation is implemented.

### Tests and limitations

`coordination-browser-executor.test.ts` covers runtime commands, capability/risk
boundaries, exact approvals, canonical fingerprints, stale/aborted/unknown outcomes,
private evidence and once-only execution. `coordination-browser-trust.test.ts`
covers representative English/Japanese attacks, insufficient visibility, blocking,
review binding/replay, fresh planning, DENY, cancellation and partial-hold recovery.
`coordination-browser-dom.test.ts` uses jsdom to exercise actual DOM scoping,
identity, forbidden fields, structured extraction and controller consistency.
Additional audit regressions inject failures into each evidence put/read-back,
post-dispatch state-token hashing, pre/post-dispatch holds, reason parsing and
ownership, applied-hold read/replan and stale approval reuse, and all four partial
journal append boundaries. They assert no VERIFY/next PLAN, unchanged submitCount,
exactly-once Progress, safe metadata retention and redaction.
VERIFY evidence regressions additionally cover missing/throwing/malformed reads,
loss at each of the three references after successful Executor read-back, exact
review recovery without another submit, invalid/replayed references, deferred
exactly-once Progress, stop/terminal races, block append failure before/after commit,
and ordinary provider error compatibility.
All preexisting COORD-0–3A tests remain part of `npm test`.

This is a PoC, **not a production security guarantee or general prompt-injection
resistance claim**. Undetected attacks, false positives, languages and expressions
outside the known patterns remain possible. Policy, target boundaries, exact
approval, state preconditions and evidence isolation are independent controls;
a detector miss never grants additional operation authority. In-memory driver,
pending action, evidence, review and Runner state have no durability across reload,
crash or restart. Persistent runtime/checkpoint recovery remains COORD-5 work.

## COORD-4A: Journal notifications and in-memory outbox

`services/coordination/notifications` projects committed Journal events into
informational notifications. The Kernel, Runner, PolicyGuard, event types and
Workflow transitions are unchanged. Neither model prose nor an executor/Runner
return value is a notification source. `WorkflowSuspended` emits nothing; there
is no invented `WorkflowFailed` event.

| Journal event / validated reason | Notification kind | MACP intent / status | Priority / user action |
| --- | --- | --- | --- |
| CommitmentAccepted | workflow_completed | notify_user / done | normal / false |
| WorkflowCancelled | workflow_cancelled | notify_user / done | normal / false |
| WorkflowBlocked / RUNNER_NEEDS_USER | action_approval_required | need_review / need_review | high / true |
| WorkflowBlocked / RUNNER_UNTRUSTED_CONTENT | security_review_required | need_review / need_review | high / true |
| WorkflowBlocked / RUNNER_VERIFY_EVIDENCE_UNAVAILABLE | evidence_review_required | need_review / need_review | high / true |
| WorkflowBlocked / RUNNER_EXECUTION_UNCERTAIN | execution_review_required | need_review / need_review | high / true |
| WorkflowBlocked / RUNNER_BUDGET_EXHAUSTED | budget_exhausted | notify_user / blocked | high / true |
| Other or malformed known WorkflowBlocked reason | workflow_attention_required | need_review / need_review | high / true |

The classifier checks canonical approval encoding and workflow ownership, reuses
strict security/evidence review parsers, and allowlists budget keys. Unknown or
malformed metadata remains visible as generic attention; it never becomes an
approval. Execution uncertainty uses the current Runner's opaque action/task ID
suffix. Classification is informational and does not validate or grant authority
to resume an action.

### Identity and payload

`projectCoordinationNotifications(snapshot)` is synchronous, validates the
snapshot and scans the Journal in sequence order without modifying it. It does
not consult wall-clock time, evidence stores, pending actions or the network.
IDs are `map.notification.v1:<SHA-256 hex>` over a canonical JSON tuple:
`["map.coordination.notification", 1, workflowRunId, kind, scope, identity]`.
For valid approval/security/evidence references and uncertain action IDs, scope
is `reference`; otherwise it is `event` and identity is the canonical event ID.
The encoded references must already be canonical; distinct opaque identifiers
are not lowercased, trimmed or Unicode-normalized. JSON tuple boundaries avoid
separator ambiguity. The synchronous browser-compatible SHA-256 implementation
is checked against Node crypto, including padding boundaries and Unicode.

Repeated blocks for the same unresolved reference keep the first event ID/time.
The first reference hash is also the internal logical `correlationId`. After a
matching user-authorized resume, a later block of the same reference creates a
new notification occurrence: hash the JSON pair `[correlationId, sourceEventId]`
with event scope. The correlation remains stable, while notification IDs differ.
The first occurrence retains its COORD-4A ID for compatibility. New references
create new notifications. Workflow identity isolates runs. Terminal
events, budgets and unrecognized reasons use event identity; an idempotent
append still points to the original Journal event. The complete historical
notification set is retained even after a later resume, completion or cancel.

Summaries are fixed Japanese templates capped at 120 characters. Approval/review
references and fingerprints only participate in internal hashing; no raw goal,
evidence, external text, exception, input or token is included. Outbox enqueue
and MACP conversion rebuild allowlisted payloads and derive summary, priority
and user-action flags from kind, discarding extra fields and caller prose.
Workflow and event IDs in the internal model are trusted Journal identifiers;
MACP carries only the hashed notification ID and the allowlisted kind metadata.
Hashes are identifiers, not encryption or authorization credentials.

### Store integration and recovery

Install the decorator once when constructing a Runner and retain the same
wrapped store for that runtime (Runner retained results are keyed by store).
All writers that need immediate observation must append through that wrapper.
Appending directly to the base store requires later explicit reconciliation.

```ts
const outbox = new InMemoryNotificationOutbox();
const observer = createCoordinationNotificationObserver(outbox);
const diagnostics = ({ code }) => recordSafeDiagnostic(code);
const store = createNotifyingCoordinationStore(baseStore, observer, diagnostics);
const runner = createCoordinationRunner({ ...dependencies, store });

// Recovery after an observer/enqueue failure, or adoption of existing history:
await reconcileCoordinationNotifications(store, workflowRunId, observer, diagnostics);

// Explicit delivery; this example performs no HTTP requests:
const transport = new InMemoryNotificationTransport();
for (const notification of outbox.pending()) {
  await deliverCoordinationNotification(outbox, notification.notificationId, transport, store);
}
```

Append first calls the base store. Only after success does it obtain a new
committed snapshot and invoke the observer with a clone; it then returns the
exact original append result. The default observer projects and enqueues
synchronously. Custom asynchronous observers are permitted, but their completion
is not awaited by the synchronous store; rejected promises are isolated too.
Snapshot-read, projection and enqueue failures produce only
`NOTIFICATION_OBSERVER_FAILED` via the optional separate diagnostic callback.
Even a throwing/rejecting diagnostic callback cannot fail an accepted append.

An append rejected by the base store still rejects and emits nothing. If a
store commits and then loses its acknowledgement, the decorator cannot claim
append success: explicit reconciliation can recover the committed history.
Reconciliation scans all history so partial enqueue failures recover without
resetting or duplicating existing delivery records. There is no automatic
reconcile timer, replay cursor, persistent checkpoint or startup installation.

### Outbox and transport (COORD-4C)

Outbox states are `PENDING -> SENDING -> DELIVERED`,
`PENDING -> SENDING -> DELIVERY_FAILED`, and `PENDING -> SUPPRESSED`.
`SUPPRESSED` retains history and is terminal; it is never a delivery success.
`prepareRetry(id)` only moves `DELIVERY_FAILED -> PENDING`. Neither retry nor
reconciliation resets `SENDING`, `DELIVERED` or `SUPPRESSED`. A snapshot-read or
validation failure records `DELIVERY_FAILED / SNAPSHOT_UNAVAILABLE` without an
HTTP attempt; it must not be interpreted as proof that a review was resolved.

`deliverCoordinationNotification(outbox, id, transport, store, options)` requires
an authoritative synchronous snapshot reader. Immediately before every send,
including after retry backoff, it validates the latest committed snapshot and
matches the notification occurrence against its current block event. All six
review/attention kinds are checked. Resolved/superseded pending occurrences are
suppressed. Completion and cancellation notifications remain deliverable.
A bare or mismatched `WorkflowResumed` does not resolve approval, security or
evidence review. Action approval keeps tracking after a mismatch so a later
resume with `type: user` and the exact approval reference can resolve it, including
after an intervening suspension. Security/evidence review evaluates only the
first resume after the block, matching its dedicated Runner preflight; a later
matching resume cannot bypass that rule before a new block. While a mismatched
resume has left the workflow RUNNING/SUSPENDED, delivery returns `deferred` and
keeps PENDING.
If Runner re-blocks the same unresolved reference, it remains one occurrence.
These checks are informational: pending-action ownership, prepared-action
fingerprints, task/evidence eligibility and permission to execute are still
checked only by the existing Runner. No notification code authorizes a resume.

`deliverPendingCoordinationNotifications` orders each workflow by Journal source
events, even if enqueue order differs, and processes different workflows
independently. An unresolved failed/deferred earlier notification pauses later
sends for that workflow. Failed entries require explicit `prepareRetry` after
the automatic retry budget is exhausted. Process-local workflow locks span the
send and retry backoff; a synchronous outbox claim prevents duplicate claims of
one notification ID. Neither lock is a Kernel lock. A resume after the final
snapshot check but before MACP accepts the request cannot be prevented atomically;
a confirmed delivered entry remains DELIVERED even in that race.

The outbox stores the sanitized MACP packet once at enqueue and sends clones of
that saved value on every attempt. The packet, notification, attempt history and
receipts returned by outbox accessors are copies. Attempt numbers reject stale
acknowledgements. Audit history records actual send attempts, normalized error
codes, HTTP status and validated receipt fields, never raw exceptions or tokens.
Suppression does not increment attempts. `InMemoryNotificationTransport` remains
available for deterministic tests, without networking or automatic retries.

### MACP HTTP adapter and limits

The server-only adapter is imported directly from
`services/coordination/notifications/macpTransport.ts`; it is deliberately not
exported from the browser barrel. It implements the MACP 0.1.0 / COORD-4B
contract verified at upstream commit
[`e88937d0c8132ae7d18098a24d01ee28bffda655`](https://github.com/KM9250/Multi-Agent-Command-Protocol/commit/e88937d0c8132ae7d18098a24d01ee28bffda655).

`producer_id` is `map-coordination`; `producer_event_id` and `task_id` are the
notification occurrence ID. Source timestamp, summary, intent, status and all
other digest fields are stable across retries. New acceptance requires 201,
`ok: true`, matching `task_id`, a positive safe-integer `event_id`, and
`idempotent_replay: false`. An identical replay requires 200 and
`idempotent_replay: true`. Invalid JSON, oversized bodies (over 64 KiB), mismatched
IDs or other success statuses are failures. Error bodies are not retained.
DELIVERED means confirmed server acceptance, not device display or human review.

Configure a full `/api/notify` HTTPS URL from trusted deployment configuration.
HTTP is accepted only for explicit `allowDevelopmentLoopback: true` and
localhost, 127.0.0.1 or ::1. Credentials in URLs, query strings and fragments are
rejected; redirects are disabled. A private server-side token is sent only as a
Bearer header. The adapter rejects browser construction and reads no environment
variables itself. Never put MACP_TOKEN in React, Vite define, client environment
variables, localStorage, URL queries or notification payloads.

Automatic retries require the trusted operator to set
`idempotencyConfirmed: true` after verifying COORD-4B on the destination server.
Only network failures, timeouts, 429 and 502/503/504 are retryable. 400/422,
401/403, 409, invalid configuration/responses, other HTTP errors and caller aborts
are not automatically retried. Defaults: 10-second request/body timeout,
3 total send attempts, exponential backoff starting at 250 ms capped at 5 seconds,
and equal jitter in the upper half of each delay interval. Options bound the
attempt limit to 1–10 and maximum backoff to 60 seconds. The attempt cap applies
to the entry's total recorded attempts; an explicit manual retry may initiate
one more send but does not reset its history or automatic attempt budget.
Every retry rechecks snapshot validity and can instead suppress the entry.
None of this is connected to `RunnerActionExecutor.execute` retries.

See [MACP integration runbook](coordination-macp-integration.md) for the Node
example and real FastAPI/SQLite/SSE tests. This is not a completed production MAP
server runtime: installation, secure token provisioning, durable outbox,
restart recovery, distributed coordination and approval UI remain future work.
No MACP API/UI, ack/retry API, Kernel, Runner or PolicyGuard authorization
contract is changed. Trusted MAP adapters remain responsible for user
resumption; notification delivery cannot complete or rerun MAP tasks.
