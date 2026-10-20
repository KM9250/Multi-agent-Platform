# Durable execution (COORD-5B)

COORD-5B records where an external Action stopped. Its dispatch contract is
**at most once per Action**. It does not promise exactly-once effects in an
external system, and does not automatically restart or recover Workflows.

## Trusted server integration

Use Node >=22.13 with `node:sqlite` / `DatabaseSync`. Only the server entry point
`services/coordination/durable/index.ts` exports the implementation. The React
application and browser barrel do not import SQLite or AsyncLocalStorage.

```ts
import {
  DurableDatabase, SqliteCoordinationRunnerStore, SqliteRunnerEvidenceStore,
  DurableExecutionCoordinator, createDurableCoordinationRunner,
} from '../services/coordination/durable/index';
import { createBrowserPocExecutor } from '../services/coordination/runner/browser/browserExecutor';

const db = new DurableDatabase({ path: trustedAbsolutePrivateDatabasePath });
const store = new SqliteCoordinationRunnerStore(db);
const evidenceStore = new SqliteRunnerEvidenceStore(db);
const browser = createBrowserPocExecutor({ driver: trustedBrowserDriver, evidenceStore });
const executors = { get: (id: string) => id === browser.id ? browser : undefined };
const coordinator = new DurableExecutionCoordinator(store, executors, { evidenceStore });
const runner = createDurableCoordinationRunner({ coordinator, supervisorProvider });
// Create a new Workflow explicitly, then run only through a trusted invocation.
// Do not enumerate restored RUNNING Workflows and feed them to runUntilStop().
```

The common Runner requires matching Store, Coordinator, Executor Registry,
Pending Action Store and Evidence Store identities. A durable Store without its
Coordinator is rejected during construction. Missing storage never selects the
InMemory path. Executor adapters must write Evidence through the Coordinator's
Evidence Store (as in the example); a memory Evidence reference fails ownership
validation. Existing InMemory Runner and Browser PoC behavior is retained.

Database opening, Workflow restoration, inspection, factory construction and
checkpoint creation do not start work. A host must not add an automatic restart
loop until COORD-5C supplies the recovery decisions and fencing it requires.

## Migration and retained artifacts

Migration `002_durable_execution` adds four STRICT tables. Migration 1 is
unchanged. `PRAGMA user_version` and the numbered migration ledger advance to 2
in one initialization transaction. Seed and checkpoint **payload** schema stays
at 1: existing rows, Journal events, digests and checkpoints are not rewritten.
A failed migration rolls back DDL and the migration ledger together.

| Table | Durable data and constraints |
| --- | --- |
| `pending_actions` | Prepared Action JSON/digest, Workflow/Session/Task ownership, Executor, operation/class, fingerprint, retry safety, Round Key and registration digest; unique Action, Task, Session and Round within a Workflow |
| `execution_ledger` | One row per Action; unique Attempt ID, reservation time, state, stored Result reference/digest, review reason and final Journal event ID |
| `execution_results` | Immutable validated Result envelope, digest, unique opaque Result Ref and Attempt/Action ownership |
| `runner_evidence` | Globally unique compatible `map.runner.evidence.v1:` reference, immutable Evidence envelope/digest and composite Workflow/Session/Task/Action ownership |

Foreign keys bind artifacts to their owners, recorded Results to the reserved
Attempt, Ledger Results to their digests, and finalized IDs to Journal events.
CHECK constraints and triggers reject invalid states, backwards transitions,
changed reservation identities and deletion of audit records. Terminal cleanup
retains Pending Actions, Ledger, Results and Evidence. No retention or orphan
cleanup policy is introduced. Orphan Evidence is permitted; successful Task
reflection with a missing Evidence reference is forbidden.

Old Journal Tasks without a Ledger are not backfilled with invented history and
cannot be dispatched. They require a later explicit recovery decision.

## Transaction boundaries

`prepare()` runs outside SQLite transactions. After preparation, the latest
Snapshot, policy and cursor are checked again inside `BEGIN IMMEDIATE`.
Registration atomically inserts Pending Action, SessionStarted, TaskAssigned and
PREPARED. The existing Round Key is retained in Session `contextRef`. Both events
use the existing event factory and Kernel validation, with consecutive sequences.
The same registration request can be retried after acknowledgement loss; its
registration digest must match. Conflicting IDs or replacement registrations
fail closed. Runner errors return before another PLAN, so a lost response cannot
cause a replacement Action to be generated in that invocation. A later explicit
invocation discovers and reuses the committed Task and Round.

Dispatch reservation restores the latest Journal under the writer lock and
requires a RUNNING supervised-autonomous Workflow, one OPEN Runner Session, an
ASSIGNED owned Task, matching Action/Fingerprint/Executor, available budget,
PREPARED Ledger, and no unresolved unknown execution. Risk is evaluated again.
Action Approval and Security/Evidence Review checks are shared with the common
Runner: latest-resume approval binding and first-resume Review semantics remain
unchanged. No authorization is invented or inferred from a Result.

Only the acknowledged reservation COMMIT permits the immediately following
Executor call. External effects never run inside a transaction. A reservation
COMMIT followed by response loss does not authorize a call on retry, even if no
external effect actually occurred. `retrySafety: 'safe'` is not an exception.

```text
PREPARED -> DISPATCH_RESERVED -> RESULT_RECORDED -> FINALIZED
                         \-> REVIEW_REQUIRED
```

RESULT_RECORDED and FINALIZED never dispatch again. Uncertain/aborted results,
Executor exceptions and invalid Result envelopes require review. Invalid or
unavailable Evidence cannot become a successful Result. Exception, malformed
Result and aborted outcomes have distinct fixed Result error codes. A database
write failure leaves the last committed state authoritative; it is never
assumed to have persisted a new review state. Semantic Evidence failure can
persist REVIEW_REQUIRED without recording a fabricated successful Result.

`recordResult()` validates the standard Runner result, reservation Attempt,
Workflow/Session/Task/Action ownership, JSON limits, and every Evidence reference
and digest before committing the Result and Ledger state together. If needed,
a Runner execution Evidence envelope is saved first. The memory Result Map is
not used as the durable source of truth. `getResult()` can load the Result after
reconnection without invoking an Executor.

`finalizeResult()` revalidates the saved Result and Evidence and uses the existing
event factory/Kernel to append TaskCompleted or TaskFailed together with the
Ledger update. Event ID and idempotency key are derived from Workflow + Action.
A repeated finalization verifies the committed event, including payload/actor,
and does not append a new event. Its COMMIT establishes FINALIZED for definite
outcomes. It does **not** establish successful VERIFY, Session, acceptance
criteria, or Workflow completion.

Security Holds and uncertainty retain REVIEW_REQUIRED even when their TaskFailed
event is journaled. The common Runner still records TaskFailed, SessionResolved,
ProgressRecorded and WorkflowBlocked in its existing order. Security Hold
`reviewRef` and `effectState` survive persistence. Partial Security Holds use the
existing preflight recovery. Unknown outcomes cannot authorize a new planning
round merely because someone resumed the Workflow. Evidence loss during VERIFY
uses the existing Evidence Review; it never calls the Executor to regenerate it.

Persistence or integrity failure returns a dedicated
`RUNNER_DURABLE_EXECUTION_STOPPED` error (or propagates a storage error if even
Snapshot retrieval fails). It does not create `RUNNER_COLLECTION_ERROR`, fail a
Task as though the external action did not happen, or plan a replacement Action.
A subsequent explicit invocation can finalize an intact RESULT_RECORDED;
DISPATCH_RESERVED without a Result remains a safety stop for COORD-5C.

## Completing a partially journaled uncertain stop

On an explicit Runner invocation, after Workflow state checks and existing
Security/Evidence Review preflights, `completeUncertainBlock(workflowRunId)`
examines REVIEW_REQUIRED / EXECUTION_UNCERTAIN records. It finds the historical
Task and Session through the Ledger even when the Session is already RESOLVED.
A validated saved uncertain Result and its committed TaskFailed event are
required. A Result not yet journaled follows normal `finalizeResult()` first;
this completion API never invents a Result or changes the Ledger.

Under one `BEGIN IMMEDIATE`, the method verifies Action/Fingerprint ownership,
the Ledger's finalized event ID, the Session's original Round Key, and the
payload, actor, scope and ordering of existing stop events. Session resolution
and Progress retain `runner:<workflow>:<round>:resolve` / `:progress`. Only
missing SessionResolved, ERROR ProgressRecorded and WorkflowBlocked events are
appended through the existing factory and `appendInTransaction()`. Each append
uses the preceding Snapshot's sequence/time. Any failure rolls back the entire
new suffix while preserving previously committed prefixes and all Ledger fields.

The block uses `runner:<workflow>:<round>:execution-uncertain-block:<action>`;
legacy matching blocks without a key are also recognized. Repeated completion,
COMMIT acknowledgement loss, and later user resume cannot duplicate the original
uncertain block or count Progress twice. An ordinary resume still cannot clear
uncertainty or authorize PLAN, VERIFY, commitment, or Executor redispatch.
BLOCKED, SUSPENDED and terminal Workflows receive no completion events; an
unrelated block reason is never overwritten. Invalid ownership, event contents,
ordering or ambiguous uncertainty fail closed. Existing Security/Evidence Review
first-resume semantics take priority and are not changed.

Tests reconstruct the previous implementation's TaskFailed-only,
SessionResolved and ProgressRecorded prefixes, SIGKILL children after each
legacy COMMIT, and start a fresh explicit Runner to finish the stop. Additional
SIGKILL tests before/after the new atomic COMMIT verify rollback/response loss,
with an independent effect counter and PLAN/VERIFY monitors. Opening a database
still does not scan or start Workflows; runtime-wide recovery remains COORD-5C.

## Evidence, JSON and credentials

`SqliteRunnerEvidenceStore.put/get` use a trusted AsyncLocalStorage scope set by
the Coordinator around dispatch. Independent asynchronous executions have
separate immutable owners; no global current-Workflow variable exists. An
unscoped put/get is refused. Outside execution, use Coordinator
`getOwnedEvidence(workflowRunId, task, ref)`; it validates all four ownership IDs
and the digest. A reference alone conveys no authority to another Workflow.
These stores are trusted server capabilities, not a multi-tenant authentication
API. Evidence and summaries remain untrusted content under the existing provider
system contract; raw content is never copied into Journal events.

| JSON artifact | Maximum encoded size |
| --- | --- |
| Prepared Action (including registration ownership envelope) | 256 KiB |
| Execution Result | 256 KiB |
| One Evidence envelope | 1 MiB |
| Nesting | 32 levels |

Bounded preflight checks precede canonical encoding, parsing of stored JSON is
size-limited, and durable preparation validates before cloning the payload.
Cycles, sparse arrays, undefined roots/array items, accessors, non-JSON objects,
nonfinite numbers and oversized/deep inputs are rejected with fixed errors.
Optional undefined object fields follow the existing 5A absent-field convention.
Nothing is silently truncated. Existing canonical JSON/fingerprint algorithms
are unchanged. Traversal/node/container budgets may reject dense pathological
inputs before the encoded-size ceiling.

The Browser regression cases measured ordinary read/input/submit Actions at
445–521 bytes, Results at 283 bytes and Evidence at 186–1,142 bytes. IDs and
contents can vary these sizes. Existing deliberately excessive/untrusted Browser
fixtures are handled by Browser validation/trust assessment before raw content
would reach persistence. The candidate limits therefore need no increase.

Prepared payloads must not embed credentials. An explicit field-name schema
rejects credential/password/token/API-key/private-key/authorization/cookie/secret
properties before registration; normalization includes underscores and hyphens.
Use a field such as `credentialRef` containing
`{ kind: 'secret-reference', reference: 'map.secret.v1:service/account' }` instead.
No reference is resolved by persistence. Trusted Executor schemas remain
responsible for preventing credentials hidden under unrelated fields or inside
arbitrary text; this is not a heuristic or LLM secret detector. Do not put raw
credentials in summaries, Results or Evidence either. Errors contain fixed codes
without payloads, SQL messages or error causes. Existing private-file protections
remain in force. This database is not an encrypted secret store.

## Diagnostics and verification

`inspectExecution(workflowRunId, actionId)` returns current ownership, fingerprint,
Executor, Task/Session/Workflow states, Round Key, Journal cursor, Attempt and
reservation time, Result reference/digest, review reason, finalized event ID and
saved Result. `dispatchMayHaveOccurred` is conservative: any reservation counts,
including a known `not_dispatched` Security Hold. No inspection result grants
permission to replay an Action. Integrity failures throw rather than repair data.

```sh
npm ci
npm run test:durable-execution
npm run test:durable
npm test
npm run typecheck
npm run build
git diff --check
```

Crash tests SIGKILL real children during registration, before/after reservation
COMMIT, after an independent external-effect file write, during Evidence INSERT,
before/after Result COMMIT, and before/after Journal/final Ledger COMMIT. Fresh
Node processes reopen, inspect and retry the same Action. An independent effect
counter must never exceed one; two processes also race dispatch on one Action.
Response-loss, ownership/digest tampering, rollback, v1 migration, Review,
fail-closed construction and Browser compatibility tests cover other boundaries.

Validation uses Linux / Node 24.19.0 and built-in SQLite. Native Windows behavior,
ACL provisioning and process termination remain unverified. Node 22.13 is the
minimum API contract, not a claim of a second runtime tested in this change.

COORD-5C must supply leases, fencing of stale workers, Recovery Manager,
operator decisions for unknown Results, old Tasks without Ledgers, and explicit
restart authorization. COORD-5D must supply the durable notification outbox.
No automatic restart, lease, fencing, outbox, MACP packet/ID change, Kernel
transition change or merge automation is included here.
