# Recovery inspection and audit history (COORD-5C-1)

This Node-only foundation reads persisted facts and diagnoses possible next steps.
`READY_TO_RESUME` is a static candidate classification. Every inspection returns
`executable: false` and `executionAllowed: false`. Inspection never obtains a
lease, makes a recovery decision, appends a Workflow event, invokes a Runner,
dispatches an Executor, or calls a model.

## Server API

```ts
import {
  DurableDatabase, RecoveryReader, RecoveryAuditReader,
} from '../services/coordination/durable/index';

const database = new DurableDatabase({ path: trustedAbsolutePrivatePath });
const recovery = new RecoveryReader(database);
const inspection = recovery.inspect(workflowRunId);
const inspections = recovery.inspectAll();
const timeline = recovery.getWorkflowTimeline(workflowRunId, { limit: 100 });
const nextPage = timeline.nextCursor
  ? recovery.getWorkflowTimeline(workflowRunId, { cursor: timeline.nextCursor })
  : undefined;
const actionHistory = recovery.getActionHistory(workflowRunId, actionId);
// An independent history reader exposes the same timeline methods.
const audit = new RecoveryAuditReader(database);
```

These synchronous APIs require Node >=22.13 with `node:sqlite`. They accept no
executor registry, supervisor provider or execution coordinator. Construction
performs no database writes. Database initialization may separately apply schema
migrations. There is no browser re-export or new HTTP endpoint/UI. A trusted
Control Plane can later expose these metadata DTOs with its administrator access
checks; the library itself is not an authentication boundary.

## Consistency and validation

`inspect(id)` opens exactly one SQLite read transaction. Within that transaction
it restores the same Journal/checkpoint projection as the existing durable
Runner Store, and reads all Pending Actions, Ledger rows, Results, Evidence,
recorded usage and Audit rows. Checkpoints retain the existing derived-data
fallback rule: an invalid checkpoint is ignored in favor of a fully validated
Journal. There is no second replay implementation or nested public Store call.

Pending Action normalization, action digests, Workflow/Session/Task ownership,
fingerprint and executor bindings use the existing Store validators. Result
envelopes, digests, Attempt binding and all referenced Evidence are checked by
`executionReader.ts`, shared with the existing Execution Coordinator. Stored
security review bindings are also revalidated. Unreferenced Evidence left by a
crash is permitted, but its envelope/digest/owner is still validated.

FINALIZED requires the original deterministic TaskCompleted/TaskFailed event,
including actor, Session, idempotency key and payload. A saved uncertain Result
uses the same effect-free stop-prefix validator as `completeUncertainBlock()`;
the Reader never calls the mutating completion method.

`inspectAll()` first enumerates IDs, then uses a separate consistent transaction
for each Workflow. Results are **not** a simultaneous database-wide snapshot.
A Workflow integrity failure produces its own `RECOVERY_FAILED` result and does
not discard other inspectable Workflows. Connection, SQLite, transaction and
schema errors propagate as fixed `DurableStoreError` codes. Raw SQLite/Kernel
errors and internal paths are never returned. Unsupported database schema
versions are rejected rather than treated as per-Workflow damage.

## Classification priority

1. Journal, saved artifacts, ownership or audit integrity failure.
2. Unknown dispatch outcomes and unresolved Security/Evidence Review.
3. Workflow stop and terminal states.
4. Historical untracked execution, execution mode and recorded budget limits.
5. Validated recorded Result reflection.
6. PREPARED Action revalidation.
7. Remaining Session follow-up or consideration of a new plan.

Ambiguous concurrent execution candidates fail closed. A Task with no historical
Pending Action/Ledger is `REVIEW_REQUIRED`; a registered Action with a missing
Ledger or a crossed reference is `RECOVERY_FAILED`. A Workflow can have several
historical Actions; all are inspected before classification.

| Workflow state | Static classification, after integrity/outcome checks |
| --- | --- |
| RUNNING | Inspect Ledger, Task and Session; show a candidate or required review |
| BLOCKED | REVIEW_REQUIRED; preserve the original stop in the Journal |
| SUSPENDED | INACTIVE; unresolved outcomes still take priority |
| RESOLVED / CANCELLED / FAILED | INACTIVE; unresolved outcomes still take priority |

FAILED is part of the existing Workflow type contract. The current Kernel has
no event that transitions a Workflow to FAILED; that terminal branch is covered
by classifier tests without inventing a new Kernel transition.

| Ledger state | Diagnostic behavior |
| --- | --- |
| PREPARED | Revalidation candidate only for an ASSIGNED Task in an OPEN Session |
| DISPATCH_RESERVED | REVIEW_REQUIRED, regardless of age or retry-safety metadata |
| RESULT_RECORDED | REFLECT_RECORDED_RESULT when RUNNING and reflection conditions hold |
| FINALIZED | Validate committed Task event; inspect Session/VERIFY follow-up |
| REVIEW_REQUIRED / EXECUTION_UNCERTAIN | Review; COMPLETE_SAFETY_STOP only as a diagnostic for an incomplete persisted uncertain stop |
| REVIEW_REQUIRED / SECURITY_REVIEW_REQUIRED | Preserve the existing reviewRef and first-resume rules |
| REVIEW_REQUIRED / RESULT_INTEGRITY_UNAVAILABLE | Review; never synthesize a Result |

PREPARED rows retained after policy denial are historical evidence of no
reservation, not automatically executable work. Cancellation can legitimately
leave a saved Result unreflected; a reservation without a known outcome still
requires review after cancellation.

Recorded budget status uses the existing budget evaluator and recorded usage
plus elapsed time. `WITHIN_RECORDED_LIMITS` does not guarantee real remaining
budget. `modelCallCoverage` is always `NOT_TRACKED_YET`; no Model Call Ledger or
Budget Guard is implemented. Candidates still need Policy, Approval, Lease and
Budget revalidation and explicit authorization in subsequent phases.

`authorizationRequirements` identifies persisted Action approvals, owned Security
Review/Evidence Review references and explicit resume requirements. Security
effect state and satisfaction use the existing shared approval/first-resume
checks. `stopJournalEventId` links the original stop without copying arbitrary
stop text into the DTO. A satisfied historical authorization does not grant
execution or replace any later recovery decision.

## Migration 003 and atomic audit recording

`003_recovery_audit_foundation` advances database schema to 3. Migrations 001 and
002 and the seed/checkpoint payload schema remain unchanged. New databases and
versions 1/2 migrate under the existing single `BEGIN IMMEDIATE` transaction.
DDL, migration records and `user_version` commit or roll back together.

`runtime_audit_events` is STRICT and contains:

- An AUTOINCREMENT `audit_sequence` and unique opaque `audit_event_id`.
- Workflow, entity kind/ID, Session, Task, Action and Attempt identifiers.
- Separate actor Agent, subject Agent, Runtime Instance and Generation fields.
- Previous/next state and fixed reason code, Journal event ID/sequence.
- Occurred/recorded timestamps and audit payload schema version 1.

Indexes support Workflow/sequence, Workflow/Action/sequence, and event/time
queries. A partial unique index prevents duplicate Journal audit references.
Foreign keys never cascade deletion. BEFORE UPDATE/DELETE triggers reject
mutations to past audit rows. Reference and transition validation rejects
invalid Journal/Action bindings; readers also check audit schemas, sequence
validity, state chains and the latest audited Ledger state.

AFTER INSERT on Journal appends `JOURNAL_APPENDED` with an ID/sequence reference.
AFTER INSERT/meaningful UPDATE on Ledger appends `EXECUTION_CHANGED` for PREPARED,
reservation, recorded Result, review, finalization, review-reason changes and
important Result/final-event metadata changes. A permitted no-op UPDATE does
not append an event. Existing Ledger transition rules remain in force.

Both triggers participate in the originating transaction. Audit failure aborts
the state change. Rollback or pre-COMMIT SIGKILL rolls back both. After-COMMIT
SIGKILL retains both. Idempotent registration, Journal retransmission and
finalization add no duplicate audit events. A read never appends audit records.

Ledger audit `actor_agent_id`, Runtime ID and Generation are NULL because 5C-1
cannot establish those identities. `subject_agent_id` comes from the committed
TaskAssigned event. Journal audit actor comes directly from the original event.
Task assignment never becomes evidence of the identity of the acting Runtime.

The internal `appendRuntimeAuditInTransaction()` contract is metadata-only,
validates references, field names, schema and reason/state formats, and requires
the active writable transaction. Trigger-owned event kinds cannot be written
through it. Future participants must establish actor/ownership authorization
before supplying identities. The writer is not exported from the public barrel.

No historical Ledger transitions are backfilled. Migration leaves all existing
Seeds, Journals, Checkpoints, Actions, Ledger rows, Result/Evidence data and
digests untouched. Audit history is conservatively marked PARTIAL; the current
Ledger snapshot is separately marked CURRENT_ONLY.

## Timeline ordering, pagination and information boundary

History pages order sources explicitly: pre-audit Journal sequence first,
then the shared audit sequence, then current Ledger rows. Journal events with
an audit reference are returned once, as JOURNAL entries with both sequences.
Ledger transitions are EXECUTION_AUDIT; future internal events are RUNTIME_AUDIT.
Current Ledger rows are CURRENT_SNAPSHOT, never invented historical transitions.
An Action query relates Task Journal events through the saved Action ownership.

`ordering` and `crossSourceClockOrderGuaranteed: false` make this contract
explicit. Journal sequence is authoritative within the Journal; audit sequence
orders post-migration Journal and Ledger changes even in one transaction.
Occurred/recorded timestamps remain separate and do not prove cross-clock order.

Options: Workflow ID, `actionId`, `eventKind`, inclusive `fromTimestamp` /
`toTimestamp` on occurred time, `cursor`, and `limit` (default/max 100).
SQL keyset paging fetches at most 101 keys and materializes at most 100 entries.
It does not replay or materialize the entire Journal to return a history page.
Cursors bind Workflow and filters and retain per-source upper watermarks, so
later appends do not extend an in-progress traversal. Each request has its own
read transaction; current Ledger values are observed on that page and can change
between pages. This is not a persistent snapshot or an authenticated cursor.

DTOs contain only audit identifiers, states, fixed reason codes, timestamps and
coverage. They omit Raw Evidence, credential/token values, Action payload,
LLM/Executor response text, Result summaries and SQLite diagnostics. Audit rows
have no arbitrary payload/metadata column and do not duplicate Journal payloads.

## Validation and handoff

`npm run test:recovery-reader` covers Reader/classifier, audit, timeline,
v0/v1/v2 migration, migration rollback, corruption, read-only behavior,
cross-Workflow ownership, concurrent consistent reads, and real child-process
SIGKILL at before-statement, after-statement/pre-COMMIT and after-COMMIT boundaries.
The existing durable and full suites, typecheck, build and diff checks also apply.
Windows native process/filesystem behavior requires separate validation.

COORD-5C-2 can add verified Runtime identity, Lease/Generation/Fencing events
through this audit contract. Apply fencing to existing Journal/Ledger mutation
paths and fail the state transition when audit recording fails. Record meaningful
ownership changes rather than every heartbeat. Lease acquisition, fencing,
Model Call Ledger, recovery decisions and automatic Workflow continuation are
outside this implementation.
