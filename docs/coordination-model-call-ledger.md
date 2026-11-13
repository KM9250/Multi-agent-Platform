# Durable Model Call Ledger (COORD-5C-3)

Introduced in Schema **5**, migration `005_durable_model_call_budget`, based on
`729b42d1e9410bb6d90bbe8a32781c5a139724c2` (COORD-5C-2).
This tracks PLAN/VERIFY budget reservations, dispatch intentions, usage settlement,
and response application. Recovery remains diagnostic only:
`executionAllowed=false` and `executable=false`. No automatic resume, resend,
manual reconciliation, shared budget pool, or external API exactly-once guarantee
is introduced. The current schema is **6**; the [4A recovery gate](coordination-recovery-authorization.md)
adds persistent protection without enabling recovery execution.

## Supported adapter boundary

The existing repository has a `RunnerSupervisorProvider` interface and in-memory
Runner fixtures, but no production implementation of that interface with a
verified conservative token/cost quote and single-attempt transport. Existing
Google/SubAgent transports are separate paths and are **not certified** by this
change. The durable coordinator rejects ordinary providers with
`MODEL_ADAPTER_UNSUPPORTED`, before reservation or invocation. Adding a property
such as `durable: { maxAttempts: 1 }` cannot grant compatibility: preparation
implementations are held in a module-private WeakMap.

`createTestDurableModelAdapter(provider, bounds)` is explicitly for trusted,
in-memory tests. Its callback must not do network I/O or retry. It invokes exactly
one PLAN/VERIFY callback, using a private cloned request, and binds its test usage
receipt to the generated attempt ID. The caller explicitly supplies provider,
model, input bound, output cap, estimated cost, pricing ID and conditions. Fixture
quotes use one input/output token and zero cost because the fixture makes no paid
request. These values are not production model prices or token estimates.

A future production adapter must implement and test preparation in the coordinator
module: immutable request/model/output cap, a conservative input bound, API-enforced
output cap, a versioned price quote, a transport with SDK and HTTP retries disabled,
and usage receipts tied to the actual physical attempt. Unsupported configurations
must continue to fail closed. The adapter must never infer COMPLETE from the mere
presence of an error's `usage` property. Test errors use an explicit
`testUsageCompleteness` marker; ordinary errors remain UNKNOWN.

## Persistence and APIs

Server-only exports are in `services/coordination/durable/index.ts`.
`createDurableCoordinationRunner` installs a separate
`DurableModelCallCoordinator`; the Action coordinator keeps its existing duties.

`ModelCallLedger` exposes:

| API | Contract |
| --- | --- |
| `reserve` | Validate quote, workflow, current Journal head, coverage, lease, all Policy stop conditions and reserved budgets in `BEGIN IMMEDIATE`; exact same identity returns the saved reservation |
| `markDispatchIntent` | RESERVED → DISPATCH_INTENT once; revalidate workflow/head, Policy stops and committed plus outstanding budgets in the same transaction; a saved intent never authorizes another API attempt |
| `settle` | Complete single-attempt usage, UsageRecorded, seed anchor, attempt state and audit in one COMMIT; exact duplicate is idempotent; conflicting identity/usage is rejected |
| `markReviewRequired` | DISPATCH_INTENT → REVIEW_REQUIRED; retain safe partial numeric facts and the full reservation |
| `cancelBeforeDispatch` | Only RESERVED → CANCELLED_PRE_DISPATCH; abort after intent cannot release budget |
| `markApplied` | Synchronous business event callback plus APPLIED receipt in one transaction, beginning at the settled usage cursor; store a digest, start cursor and final event ID |
| `inspectApplication` | Validate the saved receipt against an exact supplied event batch without repeating the callback |
| `markDiscarded` | Preserve settled usage and record a fixed invalid/stale/abort/budget/workflow-stop reason; identical repeats are idempotent |
| `inspect`, `getBudgetPosition` | Read-only ledger and reconstructed committed/outstanding budget information |

An identical `markApplied` retry with the saved start cursor verifies the persisted
receipt and does not invoke the callback again. Both `markApplied` and coordinator
`apply` return `{status: 'ALREADY_APPLIED', receipt}` for this case. Fresh application
returns `{status: 'APPLIED', receipt, value}`; a callback returning `undefined` is
valid. The receipt identifies the call, start cursor, final event and event digest.
After ACK loss, an explicit API retry can confirm this receipt without adding
business events. `inspectApplication` also validates an exact supplied event batch.
Runner stops on `ALREADY_APPLIED`; this result grants no automatic application,
Action dispatch or Model API retry. Callbacks are
trusted synchronous internal code; async work and external effects are forbidden.

Every row carries workflow, call, attempt, round, phase, provider/model, request
cursor/event, runtime and generation. `(workflow, round, phase)` is unique; attempt
number is constrained to 1. SQL triggers enforce ownership, immutable reservation
and settled usage, legal transitions, audit insertion, and immutable coverage.
A deferred usage Journal foreign key, fresh-event check and insertion guards
couple SETTLED to its own UsageRecorded. Both the current and old Runner model
source prefixes are guarded against ledger bypass. No prompt, response body,
credential or raw provider error is stored in model tables or model audit events.
Existing business Journal payload semantics remain unchanged.

`runtime_audit_events.model_call_id` is nullable for old/action events and links new
model events separately from Action IDs. New workflow coverage is inserted by the
seed trigger in the bootstrap transaction. Migration labels all existing workflows
LEGACY_UNTRACKED without inventing call history. Durable Runner preflight rejects
legacy workflows and unresolved/reserved/pending/violating model calls, even if a
new Runner generates a different round ID.

## Budget and usage

For each workflow and each dimension:

```
committed Journal usage + outstanding reservations + new reservation <= budget
```

Outstanding includes RESERVED, DISPATCH_INTENT and REVIEW_REQUIRED, independent
of time or lease expiry. SETTLED contributes through the Journal only, avoiding
double counting. No mutable in-memory counter is authoritative. Independent SQLite
connections serialize reservations under the same lease-bound writer.

Reservation and dispatch-intent writes also check `maxWallTimeMs`, `maxRounds`,
`maxConsecutiveErrors` and `maxNoProgressCycles` against the committed workflow
restored inside that SQLite transaction. The trusted clock is sampled there;
synthetic-time fixtures must inject their clock. The intent check includes its
own existing reservation exactly once. Runner prechecks are not authoritative.

Costs remain numbers in WorkflowUsage and UsageRecorded. DB reservation, settlement
and comparisons use safe integer micro-USD. Decimal-string/BigInt conversion rounds
reservation and actual cost upward, available budget downward, rejects nonfinite,
negative and unsafe values, and avoids floating-point multiplication at the unit
boundary. Each Journal event is converted conservatively before summing. Estimates
are not actual invoices. COMPLETE usage above the quote is retained in full and
sets a durable budget violation that prevents further model calls.

PARTIAL/UNKNOWN is never journaled as complete usage. Reservations remain held and
subsequent work stops. Usage arriving after lease loss cannot settle through the
old generation or be silently adopted by the new one. If a terminal workflow cannot
accept UsageRecorded under the existing Kernel contract, settlement fails closed
and the intent/reservation remains for inspection.

## Scheduler, application and crash boundaries

The Scheduler obtains its execution slot before the coordinator reserves budget.
`markOutputStarted()` is called immediately when a durable job starts, preventing
Scheduler retries. Abort, lease, Journal cursor and quote are checked before
reservation; intent must COMMIT before the provider is invoked, and lease/abort
are checked again after intent. A queued abort creates no reservation.

PLAN Action registration shares the application transaction with SessionStarted,
TaskAssigned, pending Action and Action Ledger registration. PLAN finish/needs-user
business events also share the receipt transaction. VERIFY evaluation, criterion
updates, session resolution, progress and resulting workflow transitions are one
synchronous transaction. Failure rolls back the entire application while retaining
settled usage and PENDING_APPLICATION. Non-durable behavior and approval gates
remain unchanged.

A lost reservation/intent acknowledgement stops execution, retaining any committed
row; a subsequent invocation inspects it and cannot resend. Settlement can recover
a lost acknowledgement only by re-reading an exact committed receipt under the
current lease. Otherwise it stops. Application acknowledgement loss is resolved
through its saved event receipt. No persisted response body exists, so pending
application after a crash is intentionally not automatically reconstructed.

Recovery reports total/state/phase counts, unknown usage, outstanding reservations,
pending application, budget violations, latest fixed reason and coverage. Model
facts and Journal/application receipts are validated independently of Action facts.
Timeline entries include `modelCallId`, attempt, runtime and generation. Incomplete
model states produce REVIEW_REQUIRED without granting execution authority.

## Verification and COORD-5C-4 handoff

`npm run test:model-call-ledger` covers ledger, budget, scheduler, adapter rejection,
usage errors, response application, migration, fencing and real process crashes.
Crash tests use independent Node processes/connections, pause at the target boundary,
and terminate the child; thrown exceptions are not substitutes. Windows uses Node's
forced process termination path, but native Windows execution has not been verified.

COORD-5C-4 must design explicit authorization and reconciliation for unknown usage,
old generations, legacy workflows, stale RESERVED rows, and pending application
without response bodies. It must also define how terminal workflows account for
late usage without reopening the existing Journal contract. No operator API or
automatic repair is supplied here.

## PR #31 audit fixes (F-01–F-03)

After usage settlement, PLAN and VERIFY explicitly discard responses that cannot
be used, including state changes during asynchronous Action preparation:

| Known exit condition | Discard reason |
| --- | --- |
| Budget exhausted before PLAN application or complete usage exceeds quote | `BUDGET_EXHAUSTED` |
| Abort | `ABORTED` |
| Workflow stopped, suspended, blocked or cancelled | `WORKFLOW_STOPPED` |
| Journal cursor or task context changed | `STALE_RESPONSE` |
| Invalid response or invalid prepared Action | `INVALID_RESPONSE` |

Usage remains settled. A normal PLAN response with `maxLlmCalls=1` does not leave
pending application or dispatch an Action. VERIFY may apply its final permitted
call because completing that evaluation needs no additional model call or Action.
An over-quote response retains its budget-violation flag even after discard.

`PENDING_APPLICATION` remains necessary after a crash, a failed or uncertain
application transaction, lease loss that prevents the old owner from writing, or
failure to persist discard and its audit. These cases cannot safely claim either
application or discard and remain diagnostic Recovery work. There is no automatic
replay or COORD-5C-4 execution authorization.

The still-unmerged migration 005 extends its reason enum with `BUDGET_EXHAUSTED`
and `WORKFLOW_STOPPED`; the draft schema version remains 5. This is not an upgrade
migration for an already-deployed schema 5 database.

`coordination-model-call-audit.test.ts` adds 47 tests: 24 for F-01 exit/retention
boundaries, 3 for F-02 application receipt/ACK idempotency, and 20 for F-03 direct
coordinator Policy and outstanding-budget enforcement.

## COORD-5C-4A integration

Schema 6 adds a [durable recovery hold and record-only authorization contract](coordination-recovery-authorization.md).
Model Coordinator calls and Ledger reservation/dispatch-intent writes pass the
recovery gate; SQLite also rejects direct start attempts and held business writes.
Normal current-lease settlement/application remains unchanged. Takeover and risky
clean reacquisition preserve uncertainty with a hold, including pending responses,
unknown usage and budget violations. A 4A grant cannot cancel a reservation,
discard/apply a saved response or reconcile usage. Those recovery operations need
the new 4B/4C executable contract and renewed approval.

The 4A F-01 correction binds the pending-response registration exception to the
private PLAN application scope created by the receipt-writing database participant
used by `ModelCallLedger.markApplied()`. A direct `atomicApplication()` call grants
no such scope. Workflow, Model Call, phase, round, request/settlement Journal
positions and current Lease/Generation must match. Complete Action registration
and APPLIED commit together; failed or caught registration/SQL errors roll both
back. VERIFY and already-held Workflows cannot use the PLAN exception.

## COORD-5C-4C integration (Schema 10)

[Evidence reconciliation](coordination-reconciliation-design.md) adds one
`model_usage_authorities` row per dispatched attempt. Normal settlement acquires
NORMAL authority in its existing transaction; verified reconciliation acquires
RECONCILED authority with its own operation and approval. Either winning path
prevents a second UsageRecorded/accounting effect. Migration validates normal
settlement history before backfill. Legacy non-model usage stays Journal-based.

`getSnapshot()` remains historical replay. `getEffectiveUsage()`,
`modelBudgetPosition()` and invocation usage include late reconciled usage once.
A complete settlement resolves its whole outstanding reservation but returns no
call/send permit/debit. Partial usage keeps the reservation. A missing model
response remains a separate obligation. Production provider billing verifiers
are not connected; synthetic signed receipts do not certify a production model.
