# COORD-5C-4B-2A: Authorized Prepared Dispatch

This phase dispatches **one saved, never-reserved PREPARED Action under fresh authenticated approval**, records its Result/Evidence, and stops with the original Recovery Hold intact. It does not append TaskCompleted/TaskFailed, run PLAN/VERIFY, start the Runner, resume a Workflow, release a Hold, or reconcile unknown Usage. Bounded Continuation remains 4B-2B; unknown external outcomes and Usage remain 4C.

Baseline: `07c9e2e5739aed3f6c181bd3c16b387e7367c2bd`. Migration `008_bounded_recovery_execution` introduces schema **8**. Migration 001–007 generated SQL is pinned to the baseline SHA-256 hashes in `coordination-recovery-dispatch-migration.test.ts`; their SQL and historical contracts are unchanged. Seed/Journal schema remains 1. The old `COORD-5C-4A:RECORD_ONLY:1` and `COORD-5C-4B:EXECUTE:1` authorities cannot authorize dispatch.

The new contract is `COORD-5C-4B2:CONTROLLED_EXECUTION:1`, restricted by SQL and the closed dispatcher to `ALLOW_PREPARED_DISPATCH`, `maxActionDispatches=1`, `maxModelCalls=0`, `maxRounds=0`. These are authorization bounds, not edits to historical Workflow Usage.

## Host configuration and public API

```ts
const database = new DurableDatabase({
  path,
  recoveryIdentityVerifier, // trusted authenticated host dependency; absent => fail closed
  recoveryAuthorizationPolicy: {
    ALLOW_PREPARED_DISPATCH: { minimumApprovers: 2, forbidSelfApproval: true },
  },
  controlledExecutors, // trusted registry, never a request/model-provided executor
});
const planner = new ControlledRecoveryPlanner(database, lease);
const authorizer = new ControlledRecoveryAuthorizer(database, lease);
const dispatcher = new RecoveryDispatchCoordinator(database, lease);
const reader = new RecoveryDispatchReader(database);

planner.preview(workflowRunId); // pure read; HOLD_NOT_ESTABLISHED is explicit
const plan = planner.createPlan({ workflowRunId, actionId }, operatorCredential);
authorizer.authorize(plan.planId, controlledScopeOf(plan), approverCredential);
// Obtain the other distinct approval if the host policy requires it.
const inspection = await dispatcher.executeAuthorized(plan.planId, operatorCredential, { signal });
reader.inspectDispatch(plan.planId, viewerCredential); // no current lease required
```

Plan creation/execution requires Operator/Admin; authorization requires Approver/Admin. Default controlled policy requires one distinct approver and forbids creator self-approval. Configured policies can require up to 100 distinct approvers. Grant lifetime never exceeds Plan start deadline or authenticated identity expiry. Repeated authorization by the same actor does not increase quorum. Unspent revocation and reservation serialize through SQLite's writer lock. A consumed Grant cannot be revoked, refunded or reauthorized.

No production identity provider, management HTTP endpoint or UI is supplied. Ordinary executors are not opted in automatically. A host registry entry must contain `executor`, `contractVersion`, SHA-256 `implementationDigest`, and `sideEffectRetries: 'disabled'`. The host must attest the implementation and prohibit internal side-effect retries. Same-version object/function replacement within the database instance is rejected. Across restarts, the host's stable implementation digest/version is the binding; JavaScript function identity cannot be compared across processes. The executor resolved in Transaction A is captured internally and never replaced by a later registry lookup or fallback.

## Eligibility and Plan binding

Plan generation, approval and reservation independently verify RUNNING/supervised_autonomous Workflow, OPEN Session, ASSIGNED Task, ownership and unique active Session. The saved Action must have PREPARED Ledger, NULL Attempt/reservation/result/finalization, no historical reservation audit, no Controlled Intent, and no orphan Result/Evidence. Pending Action bytes, fingerprint, payload digest, original registration digest and its Journal/Audit must validate.

DENY is rejected. NEEDS_USER still requires the original Action Approval; a Recovery Grant cannot replace it. Unresolved Security/Evidence Review, other unfinished Actions, legacy/missing coverage, effective Model reservations/intents/reviews/unapplied responses and budget violations fail closed. `effectiveModelRows()` verifies 4B-1 cancellation/discard provenance before treating obligations as resolved. The original Ledger is preserved. Workflow budgets, including elapsed wall time, are checked again immediately before sending.

Canonical JSON + SHA-256 binds Action/Workflow/Session/Task, contract, fingerprint, payload/registration, trusted Executor version/digest, Journal cursor/head, Action and Model state, policy/budget, review requirements, original/effective Hold revision, existing controlled facts, Runtime/Generation, creator/time, timing configuration and limits. Plan/Grant/Audit registration and lease heartbeat updates are excluded from business-state digests, preventing self-invalidation. Generation, target, policy or business-state changes invalidate approval. Elapsed time is checked separately rather than mixed into a changing digest.

Preview is effect-free and never acquires a lease or establishes a Hold. An explicit createPlan request authenticates the actor and validates eligibility **before** the first management write. If needed, Hold establishment and Plan registration share a transaction. Unauthenticated/invalid requests leave no Hold or management audit.

## Transaction A, Send Permit and Result Sink

Transaction A is synchronous `BEGIN IMMEDIATE`: identity/role/current Lease → existing Intent check → revalidation → distinct current Grants → PREPARED reservation with new Attempt → Grant consumption → immutable Intent → Grant links → validated audit/readback → COMMIT. There is no network or `await` inside it. Normal and controlled dispatch share `reserveExecutionInTransaction()`; it participates in the existing transaction and grants no authority itself.

One Plan has at most one Intent; one Workflow/Action has at most one controlled Intent; Attempt is unique and references the Execution Ledger. Deferred mutual Grant/link foreign keys reject one-sided consumption. SQL failures poison the entire controlled transaction even if a participant catches them. Audits are trigger-owned and commit with their source facts.

**Only the direct normal return from A's COMMIT mints a Send Permit.** Its object exists in a database-instance-private WeakSet and is immediately consumed synchronously, before the first await or any executor code. The captured reservation binds it to the exact Workflow/Action/Attempt/Operation, Lease/Generation and DB instance. DTOs, IDs, SQL predicates, a copied database and a second process cannot mint it. COMMIT ACK loss enters an authenticated read path, even when the Intent exists: external call count is zero. Repeated/reentrant requests return the stored state without minting a permit or a new Attempt.

Before the external boundary, the current Lease, deadline, Abort, immutable Intent, expected reserved Ledger and business post-state are checked. This comparison uses the expected state after A; it does not compare a PREPARED digest against the reservation it just made. The SQLite lock is released before calling the captured executor with a validated copy of the saved Action. Synchronous throw, rejection, timeout and abort never trigger a second invocation, including `retrySafety='safe'`.

A separate private Result Sink is held in a WeakSet/AsyncLocalStorage, bound to the captured Intent and live Lease. `SqliteRunnerEvidenceStore.withOwner()` alone does not confer it. During the executor call, the existing Evidence Store may save only the matching owner, Operation and Attempt. Separate database instances cannot inherit the context. The public coordinator exposes neither reserve/send nor a caller-supplied Result/callback/permit API. All SQL predicates are observations of existing private scopes, never scope setters.

The original and effective Hold remain. SQLite exceptions allow only exact expected old/new column vectors for the target reservation, consumed Grants, Intent/links, or target Evidence/Result/Receipt. Ordinary PLAN application and 4B-1 scopes remain distinct. New Actions, Models, Tasks, arbitrary Journal writes, WorkflowResumed, Hold removal and unrelated writes remain rejected.

## Time and Evidence limits

| Trusted setting | Default | Hard maximum | Purpose |
| --- | ---: | ---: | --- |
| sendTtlMs | 60,000 ms | 300,000 ms | Short window for fresh human approval and starting one dispatch |
| executionTimeoutMs | 30,000 ms | 120,000 ms | Bound how long the coordinator awaits a response |
| resultGraceMs | 30,000 ms | 120,000 ms | Allow bounded result persistence after execution |

Host settings must be positive finite safe integers within the maxima. Requests cannot supply them. A fixes `sendDeadline = min(plan deadline, requesting identity expiry, consumed grant expiries)` and `resultCollectionDeadline = sendDeadline + executionTimeoutMs + resultGraceMs`. This permits a started response after Grant start expiry while bounding evidence storage. These windows **do not extend the Lease**. A short Lease may deliberately fence an otherwise in-window result.

Evidence is bounded to **16 records and 1 MiB total canonical UTF-8 bytes per Operation**, with the existing per-item 1 MiB and per-result 256 KiB limits. Pre-result writes reserve one item and 256 KiB + 1 KiB for default Evidence. Stored payloads reject embedded credential fields. Raw exception messages are not saved; failures use fixed codes, and raw adapter errorDetail is discarded. The supplied tests use synthetic data and temporary DBs only.

## Transaction B and historical receipt

After normalizing the external response, collection closes to further executor Evidence. B checks live Lease/Sink, exact Intent/Attempt/Ledger, collection deadline, Result format and Evidence ownership; saves any default Evidence, Result, Ledger transition, immutable Receipt and Audit together; verifies readback and deadline; then commits. Result and default Evidence IDs are fixed in A, while receipt identity is the Operation. Already-saved Evidence belongs to its own earlier transaction and survives B rollback as **unconfirmed evidence**, not success or permission to resend.

Validated succeeded/failed results become RESULT_RECORDED. Valid Safety Hold, uncertain/aborted/throw/timeout/invalid result becomes REVIEW_REQUIRED, or leaves the reserved Intent if integrity/persistence prevents recording. No uncertain result is converted to failed for progression. Terminal business state is never revived. A timeout/abort terminates the sink; a delayed response cannot overwrite it or add Evidence.

There is **no automatic DB-save retry** in this phase. A B error leaves an Intent if no receipt committed. A B COMMIT ACK loss re-reads the exact receipt and verifies the normalized Result digest; it never calls the executor again. The result sink is revoked in finally on every completion/failure path. A new process has read-only history, not authority to finish a lost result from IDs.

| Inspection status | Meaning |
| --- | --- |
| NOT_STARTED | This Plan has no Intent; still requires fresh valid authority to start |
| INTENT_RECORDED | Authorization spent and Attempt reserved; sending cannot be inferred either way |
| RESULT_RECORDED | Valid Result stored; Task completion/VERIFY/Hold release has not happened |
| REVIEW_REQUIRED | Result includes uncertainty or a Safety Hold; no automatic progression |

An active matching Runtime in the current process may still be processing an Intent. A different/restarted process diagnoses OUTCOME_UNKNOWN even while the historical Lease has not expired; this does not prove that a different live process has stopped. Read-only inspection requires authentication, but not a live Lease, unexpired historic Grant or unchanged Generation. Receipt validation binds original Attempt, Result/Evidence digest and reservation/result audits; later legitimate 4B-1 FINALIZED transitions do not invalidate it. A new 4B-1 result-reflection Plan and separate approval are required for business reflection. Timeline exposes controlled Plan/Grant/Operation, actor, Action/Attempt and runtime metadata separately from Journal events.

## Guarantees, failure boundaries and validation

The guarantee is at most one `Executor.execute()` **entry by the legitimate coordinator for one Attempt**. This does not guarantee the executor's internals or an external service implement exactly once. SQLite cannot remove the race between the final check and external execution. A crash or communications failure in that window retains uncertainty and never authorizes another send.

`test:recovery-dispatch` runs eligibility/identity/quorum/expiry/revocation, changed bindings/generation/policy, A/B rollback and swallowed SQL errors, A/B ACK loss, reentry/synchronous throw, exact Sink ownership, limits/timeouts/late responses, lease loss, read-only history and 4B-1 reflection tests. Real child-process termination covers before/after A COMMIT, before/after executor entry, after Evidence, before/after B COMMIT. An independent file counts external entries across restart and a second request. Two independent Node processes race for the same prepared Action. Tests also cover 0–7→8, populated v7, DDL failure and migration COMMIT crash boundaries.

The existing tests retain all assertions and crash boundaries. Their expected latest schema changes to 8; historical audit projections assert the new columns are NULL before comparing old columns. No test is removed or skipped. The normal test concurrency limit remains two for the aggregate/recovery suites and the new suite. See `coordination-recovery-dispatch-validation.md` for the final command results and environment.

Windows native execution is not validated by the Linux results. Existing browser/normal dispatch, non-durable Runner, 4A PLAN application, 5C-2 fencing and 4B-1 recovery retain their contracts. No actual external executor or model/provider call is needed to validate this feature. The host must explicitly connect a trusted identity verifier and opted-in executor before production use.

For 4B-2B, add Invocation bounds, PLAN/VERIFY and Hold/Resume rules under a new approval scope; never expand these Grants. For 4C, inspect missing external results/Usage with independent evidence. Missing results in this phase never justify resending the same Action or declaring success.
