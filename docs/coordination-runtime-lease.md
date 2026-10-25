# Workflow Runtime Lease and Fencing (COORD-5C-2)

Schema **4**, based on `7d6d254533e77267321d6de578aeb2f6a6ca383a` (COORD-5C-1 / PR #29).
This adds durable Workflow ownership across Node.js processes. It does not grant
recovery authorization or automatically resume stored RUNNING Workflows.
`RecoveryInspection.executionAllowed` and `executable` remain `false`.

## Explicit server lifecycle

Import only the Node entry point `services/coordination/durable/index.ts`.

```ts
const db = new DurableDatabase({ path: trustedAbsolutePrivateDatabasePath });
const admin = new SqliteCoordinationRunnerStore(db);
admin.createWorkflow(trustedInitialSnapshot); // first seed + creation event + audit only
const leases = createRuntimeLeaseManager(db, { ttlMs: 30_000, heartbeatIntervalMs: 5_000 });
const lease = leases.acquire(trustedInitialSnapshot.run.runId);
const store = admin.withLease(lease);
const coordinator = new DurableExecutionCoordinator(store, trustedExecutorRegistry);
const runner = createDurableCoordinationRunner({ coordinator, supervisorProvider });
// The host explicitly owns the heartbeat, abort controller, stop and release lifecycle.
const stopHeartbeat = leases.startHeartbeat(lease, fixedCode => {
  hostAbortController.abort();
  reportFixedDiagnostic(fixedCode);
});
try {
  await runner.runOneRound(lease.workflowRunId, { signal: hostAbortController.signal });
} finally {
  stopHeartbeat();
  try { leases.release(lease); }
  catch { reportFixedDiagnostic('LEASE_FENCED'); } // lost handles cannot release another owner
  db.close();
}
```

For an existing Workflow, restoration and inspection are read-only. Acquisition
must be an explicit trusted host decision, and acquisition alone is insufficient
to authorize recovery. Do not enumerate stored RUNNING Workflows and invoke them.
Database connection, Reader construction, restoration and Runner factory creation
never start heartbeats or execution.

`createRuntimeLeaseManager(database, options)` returns:

| API | Contract |
| --- | --- |
| `runtimeInstanceId` | Process-local random UUID generated at module initialization; unrelated to Agent identity and never restored from a payload |
| `acquire(workflowRunId)` | `BEGIN IMMEDIATE`, reject any unexpired ACTIVE owner including the same Runtime, acquire a never-leased/released/expired Workflow, return a handle only after acknowledged COMMIT |
| `renew(lease)` | Verify Workflow, Runtime, generation, internal capability hash, ACTIVE state and expiry; preserve generation; reject zero-row changes and expired handles |
| `assertCurrent(lease)` | Check current persisted ownership and clock continuity; grant no new authority |
| `release(lease)` | Owner-only ACTIVE→RELEASED, retaining the row and generation; invalidate the handle, including after ambiguous failure |
| `inspect(workflowRunId)` | Metadata-only ACTIVE/EXPIRED/RELEASED view or undefined; includes `executionAllowed:false`; never mutates |
| `startHeartbeat(lease, onLost)` | Explicit timer; return a stop function; failure stops the timer and invalidates the handle, reporting only a fixed code |

Defaults are TTL 30 seconds and heartbeat 5 seconds. Trusted configuration can
change both (TTL 2 ms–24 hours; heartbeat must be a positive integer below TTL).
A shorter configured TTL without a heartbeat override uses at most TTL/6.
`renew()` returns the same frozen handle with updated `expiresAt` metadata.
Serialized/cloned/spread DTOs cannot be used as handles. Original objects are
registered in an unexported WeakMap with a random 256-bit capability digest.
Handles also retain a private issuing-file identity (canonical real path plus
filesystem device/file ID). It is checked before writes, assertions, renewal or
release. Passing the original handle explicitly to `withLease()` or a Store on
another connection to that same canonical physical DB remains supported. A
backup/copy cannot inherit this authority, even if its persisted ACTIVE Lease
row is identical; rejection on the copy does not revoke the source handle.
Only the hash is persisted; neither the capability nor its hash is returned by
Lease/inspection/timeline DTOs or written to Audit/ordinary logs.

Generation starts at 1. Every acquisition after release or expiry increments it,
even for the same Runtime ID. Heartbeat and release preserve it. The STRICT
`runtime_leases` row has a Workflow primary/foreign key, cannot be deleted, and
limits generation to `Number.MAX_SAFE_INTEGER`. Overflow fails closed. An
unacknowledged acquire COMMIT creates no local authority; inspect the persisted
row and respect its expiry rather than stacking ownership or reusing identity.

## Database enforcement and complete write inventory

`DurableDatabase.writeWithLease(handle, workflowRunId, callback)` takes the writer
lock, checks ownership, executes synchronous participants, rechecks before COMMIT,
and clears private connection context in `finally` on every exit. No async work,
DDL, transaction control or PRAGMA is accepted from participants.
`assertWorkflowWrite(tx, workflowRunId)` also guards transaction participants.
Ordinary `write(callback)` supplies no implicit Workflow authority.

SQLite triggers call connection-local functions. The functions read ECMAScript
private context; there is no SQL setter or caller-supplied identity context.
Every protected SQL mutation compares Workflow, Runtime, generation, capability
hash, state and SQLite expiry in its transaction. Old connections without these
functions fail closed. Trigger errors become `LEASE_FENCED`; raw driver errors
never form public Store errors. A fencing rejection poisons the transaction,
even if a participant catches it. Recursive triggers are enabled and verified
so `INSERT OR REPLACE` cannot evade immutable history triggers.

| Persistent write | Authorized path |
| --- | --- |
| `workflow_seeds` initial INSERT | Bootstrap only, together with exactly one `WorkflowRunCreated` Journal entry and its audit |
| Seed cursor/anchor UPDATE | `store.append` / `appendInTransaction` in a verified Workflow scope |
| `journal_events` INSERT | All Store/Runner events; same transaction as cursor/anchor; bootstrap limited to sequence 1 |
| `workflow_checkpoints` INSERT | `store.createCheckpoint`; direct UPDATE/DELETE are fenced as well |
| `pending_actions` INSERT | `coordinator.registerAction`, with Session/Task and PREPARED Ledger |
| `execution_ledger` INSERT/UPDATE | Registration, `reserveDispatch`, `recordResult`, `requireReview`, `finalizeResult` |
| `execution_results` INSERT | `recordResult`, with Ledger update in one COMMIT |
| `runner_evidence` INSERT | Explicit async Evidence owner scope with a verified handle; Coordinator passes its handle into custom Evidence Stores |
| `runtime_audit_events` INSERT | Trigger-owned Journal/Ledger/Lease events, or strict internal metadata writer in the verified Workflow scope |
| `runtime_leases` INSERT/UPDATE | Private manager transaction; transition triggers; ownership audit in the same COMMIT |
| Safety-stop Journal suffix | `completeUncertainBlock`, under the same verified scope; no new dispatch or recovery decision |

Immutable Seed identity, Journal, Action, Result, Evidence, Ledger deletion and
Audit constraints remain. UPDATE fences check both OLD and NEW Workflow IDs.
Bootstrap refuses any pre-existing seed, and cannot create Checkpoints, Actions,
Results or Evidence. Before COMMIT it revalidates the canonical Seed/Journal
(digests, Workflow ownership, one creation event, cursor/anchor) and exactly one
matching creation Audit (entity, event ID/sequence and actor/reference linkage).
Calling `map_bootstrap()` only consumes SQL phase permissions; it cannot prove
that artifacts exist or survived a caught SQL exception. Incomplete or mismatched
Bootstrap artifacts roll back together. Reads, diagnostics, trusted migrations
and SQLite backup remain separate from Workflow write authorization. Future recovery writers must
use this same scope; no nonfenced compatibility fallback is provided.

## Dispatch, model calls and failure behavior

The reservation COMMIT must be acknowledged, then the current lease is checked
again before calling the Executor. A previously reserved Attempt never grants
another Executor call, including after a generation change. Loss during execution
rejects Result, Evidence and Journal writes and leaves the existing reservation
for review. No replacement Action or Attempt is generated.

Runner safe points and PLAN/VERIFY boundaries check the lease, including after
scheduler queue waits and after provider responses. A response returned after
lease loss cannot become usage, evaluation or another state change. This is not
a complete Model Call Ledger or budget reservation system.

Renewal errors and DB Busy invalidate the affected handle. Expiration and clock
anomalies also invalidate it; a later heartbeat cannot revive it. Normal SQL
failures that rolled back without ambiguity do not silently grant new authority.
Release failures revoke local authority even if the persisted ACTIVE row remains.
New ownership must wait for actual persisted expiry when release did not commit.

SQLite `unixepoch('subsec')` supplies the common millisecond clock. Active handles
compare wall-clock increments against `performance.now()`; more than 2 seconds
of drift or more than 1 second of backwards movement fails closed. These are
local continuity checks, not a distributed clock service. A process starting
after a host clock change cannot reconstruct historical clock behavior.

## Audit and Migration 004

Ownership changes create `LEASE_ACQUIRED`, `LEASE_TAKEN_OVER`, `LEASE_RELEASED`.
Fixed reasons: `INITIAL_ACQUIRE`, `REACQUIRE_AFTER_RELEASE`, `LEASE_EXPIRED`,
`OWNER_RELEASE`. Entries contain Runtime ID, generation, before/after state,
SQLite occurrence/recording times and Workflow ownership linkage. Ordered prior
acquire/takeover/release entries identify the previous owner. Agent subject and
actor identities stay separate. Heartbeats do not append audit rows.

An audit failure rolls ownership back. EXPIRED is derived from persisted state
and current time; time passing does not fabricate an audit event. A takeover
records when expiry was discovered and ownership changed, not a guessed process
death time. Rejected stale operations do not claim committed rejection audits.

Migration 004 adds STRICT `runtime_leases`, its index and constraints, fences,
and immutable `runtime_fencing_boundary`. Its singleton stores the maximum
pre-004 audit sequence; insert/update/delete and sequence-boundary triggers
prevent ordinary DML from moving the boundary or inserting new historical rows.
Legacy `EXECUTION_CHANGED` Runtime/generation NULLs remain valid. New nonbootstrap
audit requires verified metadata and a matching preceding ownership event.
Recovery validates both ranges and exposes Runtime/generation on Journal and
Ledger timeline entries. The boundary is protected within SQLite's integrity
model; it does not defend against an administrator dropping triggers or replacing
the database file.

The three v4 Journal/Ledger audit triggers are explicitly defined in
`leaseSchema.ts`; they are not produced by rewriting Migration 003 text.
Migrations 001–003 are unchanged. DDL, boundary, migration ledger and `user_version`
commit together. 0/1/2/3→4, v4 reopen, rollback, forced termination and future-schema
refusal are tested. Existing Seed/Journal/Checkpoint/Action/Result/Evidence/Audit
rows are not rewritten. Ledger/artifact payload schemas remain 1. Existing
RUNNING Workflows receive no lease during migration.

## Verification and test contract changes

Run `npm ci`, `npm test`, `npm run test:durable`,
`npm run test:durable-execution`, `npm run test:recovery-reader`,
`npm run test:runtime-lease`, `npm run typecheck`, `npm run build`,
and `git diff --check`.

The lease suite covers acquisition races in separate processes, stale Runtime
return, Busy, expiry, zero-row heartbeat, overflow, quiet heartbeat lifecycle,
all protected writes, DTO forgery, foreign Workflow scope, caught-trigger-error
rollback, clock shifts, Executor/model response loss, legacy audit compatibility,
and real crash boundaries for acquire/renew/takeover and Migration 004.

Existing tests are retained without deletion or skip. Fixtures now explicitly
acquire handles; same-process reopen tests deliberately retain those handles.
Process tests explicitly release the parent's ownership and acquire a fresh child
lease; after a crash the harness waits for persisted expiry. Idempotency races
may reject a contender with `LEASE_HELD`, followed by an authorized retry proving
one committed identity. Busy now tests permanent local handle rejection instead
of retrying the same authority. Corruption tests explicitly bypass added triggers
to keep testing semantic integrity, while separate tests verify the actual
fences. The original Journal/Ledger crash comparisons exclude separately tested
Lease lifecycle rows; Recovery still validates the full ownership audit chain.
Lost-acknowledgement fault hooks follow the new scoped writer and pause at the
intended Journal/Ledger COMMIT, rather than accidentally pausing at Acquire.

Linux uses actual SIGKILL. On Windows, test helpers select Node's forced process
termination and label it separately; no POSIX-only command is required by common
test paths. Windows native execution remains unverified in this Linux environment.

## Limits and COORD-5C-3 handoff

Use trusted local SQLite WAL storage on one host; mismatched clocks across hosts
sharing a SQLite file are unsupported. A valid local handle may be deliberately
shared explicitly with another connection to the same canonical physical DB
in the same Runtime, but cannot authorize a copied DB or be serialized to
another process. Runtime code and database administration are trusted; this is
not a sandbox against arbitrary code with driver/DDL or filesystem privileges.

COMMIT and external dispatch have an unavoidable race window. Arbitrary external
APIs are not fenced, and external exactly-once is not guaranteed. Lease loss
cannot cancel an already accepted external operation. There is no Model Call
Ledger, durable model budget reservation/settlement, automatic Recovery Decision,
automatic resume, redispatch of unknown results, admin HTTP/UI, or notification
outbox. COORD-5C-3 must add model call identity and budget accounting, decide how to
record responses whose lease was lost, and retain these same fencing and explicit
recovery-authorization boundaries.

## Initial verification record (HEAD 6312e42, 2026-10-25 JST)

Linux, Node.js v24.19.0, npm 11.9.0. All commands exited 0:

| Command | Result |
| --- | --- |
| `npm ci --cache /workspace/.npm-cache` | 143 packages installed |
| `npm test` | 40/40 test files |
| `npm run test:durable` | 11/11 test files |
| `npm run test:durable-execution` | 7/7 test files |
| `npm run test:recovery-reader` | 6/6 test files |
| `npm run test:runtime-lease` | 4/4 test files; 37/37 individual lease cases |
| `npm run typecheck` | passed |
| `npm run build` | passed |
| `git diff --check` | passed |

This Node test runner reports file-level totals for isolated tests. Direct
per-file execution separately confirms 10 basic, 10 fencing, 9 migration and
8 process cases, all passing. No tests were deleted or skipped. Windows native
execution and Node 22 were not run in this environment.

## PR #30 audit fixes (F-01 / F-02 / F-03)

`coordination-lease-audit-fixes.test.ts` adds nine regression cases: phase-only
Bootstrap with/without a Seed; a caught initial Journal/Audit statement failure
after all SQL phases were consumed; inconsistent Seed, creation-event and Audit
entity linkage; all handle authorization APIs against an ACTIVE-lease backup;
explicit handle sharing across same-file connections; and the installed
Journal/Ledger trigger metadata columns/values. Six F-01 cases and the F-02 copy
case reproduced the original issues before the fixes. All nine pass afterward.
The existing tests are retained. Schema stays 4; no automatic recovery, dispatch
retry, COORD-5C-3 or COORD-5C-4 feature is added.

Audit-fix validation on Linux / Node v24.19.0 / npm 11.9.0: `npm test` (41
files), `test:durable` (11), `test:durable-execution` (7), `test:recovery-reader`
(6), `test:runtime-lease` (5), typecheck, build and the diff check against main
`7d6d254533e77267321d6de578aeb2f6a6ca383a` all pass. Direct per-file execution
records 873/0/0 pass/fail/skip cases for the full suite, plus one existing
assertion script that exits successfully without reporting case counts. The
corresponding subset counts are 163, 111, 88 and 46 passes, all with zero
fail/skip. The subsets overlap. Existing cases are retained without skip.
Windows native execution remains unverified; extra test connections close before
fixture directories are removed. Schema remains 4 and 5C-1 Reader/Audit contracts
remain intact.
