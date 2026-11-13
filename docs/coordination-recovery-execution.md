# COORD-5C-4B-1: Atomic Safe Recovery

This phase executes four explicitly authorized recovery operations entirely in SQLite. It never dispatches an action, calls a model, retries an external operation, reconciles unknown usage, resumes a workflow, or releases a recovery hold.

## Contract and schema

Migration `007_safe_recovery_execution` advances the database to schema 7. Migrations 001–006 and the seed/journal format are unchanged. Existing `COORD-5C-4A:RECORD_ONLY:1` plans, grants, audits and the execution-disabled `recovery_operations` table retain their contracts. A 4A identifier cannot be passed as a 4B plan or grant.

The new contract is `COORD-5C-4B:EXECUTE:1`. Its six STRICT tables are:

| Table | Responsibility |
| --- | --- |
| `recovery_execution_plans` | Immutable execution binding and canonical digest |
| `recovery_execution_grants` | Authenticated approval; authorized, revoked or atomically consumed |
| `recovery_execution_operations` | One committed receipt per plan, with stable operation identity |
| `recovery_operation_grants` | Unique consumption links for every approving grant |
| `recovery_hold_transitions` | Append-only revision and diagnostic state |
| `recovery_model_resolutions` | One cancellation or discard per original model call |

Composite foreign keys bind workflow, target, kind, plan, grant and operation. Deferred constraints allow business changes, consumption, receipt and hold transition to be inserted in one transaction while rejecting incomplete commits. History cannot be updated or deleted. The only mutable grant transition is `AUTHORIZED` to `REVOKED` or `CONSUMED`; expiration is derived from database time.

## API and identity boundary

The Node-only durable entry point exports `SafeRecoveryPlanner`, `SafeRecoveryAuthorizer` and `SafeRecoveryExecutor`. The existing `RecoveryPlanner` remains diagnostic and record-only.

```ts
const planner = new SafeRecoveryPlanner(database, lease);
const authorizer = new SafeRecoveryAuthorizer(database, lease);
const executor = new SafeRecoveryExecutor(database, lease);
const plan = planner.createPlan({ workflowRunId, operationKind, targetId }, operatorCredential);
authorizer.authorize(plan.executionPlanId, executionScopeOf(plan), approverCredential);
const receipt = executor.executeAuthorized(plan.executionPlanId, operatorCredential);
```

`RecoveryIdentityVerifier` is a trusted host-composition dependency. Its absence, malformed identity, expired identity or insufficient role fails closed. Credentials, arbitrary SQL, callbacks and caller-provided events never enter persisted recovery plans. Operators/admins create and execute plans; approvers/admins authorize them. The configured approval policy controls distinct approvers and prohibits author self-approval where required. Each grant expires no later than its identity or plan. Revocation cannot revive or reuse a consumed grant.

`RecoveryExecutionPlan` binds the exact operation and target to journal cursor/event, complete saved action/model facts, policy and effective budget digests, runtime/generation, effective hold revision, approval requirements, fixed change categories, contract, creator and expiry. `canonicalJson()` and `digest()` produce its digest. Creating a plan or approval does not alter its fact binding. Authorization and execution independently recompute it. A change to the journal, policy, budget, target facts, generation or hold revision requires a new plan and approval.

## Transaction and private execution scope

Execution uses `BEGIN IMMEDIATE`, validates the lease and identity, recomputes the plan binding, verifies approvals, and installs a private scope inside `DurableDatabase`. The scope binds the current transaction, workflow, runtime/generation, plan/digest, operation, target, grant IDs, expected ledger state and deterministic journal events.

SQLite predicates only inspect this scope. They cannot create authority. Public `writeWorkflow()`, `atomicApplication()`, the ordinary PLAN application scope, DTOs and other transactions cannot acquire it. The limited hold exceptions permit only the exact planned journal payloads, matching seed anchors and the target ledger finalization. They do not permit new actions, model intent, result replacement or a workflow resume. The remaining hold triggers stay in force.

The business change, grant consumption, operation receipt, grant links, hold transition and trigger-generated audits share one COMMIT. SQL errors poison the recovery transaction even if a participant catches them. The lease is checked again before commit. Receipt verification and exact journal postconditions must succeed before commit can complete.

## Operations

| Operation | Preconditions and result |
| --- | --- |
| `REFLECT_RECORDED_RESULT` | Valid `RESULT_RECORDED` action, saved final result/evidence and ownership, assigned task, RUNNING workflow and OPEN session. Reuses transaction-capable result validation/finalization; appends one deterministic TaskCompleted/TaskFailed and marks the original ledger FINALIZED. No executor or new attempt. |
| `CANCEL_UNSENT_MODEL` | Original ledger and sole attempt RESERVED, attempt number 1, no dispatch intent, matching provider/model/quote, tracked 5C-3 coverage, no previous resolution. Appends `CANCELLED_UNSENT`; preserves original ledger and attempt. |
| `DISCARD_SETTLED_RESPONSE` | SETTLED with COMPLETE usage, exact committed UsageRecorded at the expected journal head, PENDING_APPLICATION, no application receipt, no prior resolution or partial application. Appends `DISCARDED_BY_RECOVERY`; usage remains committed. |
| `COMPLETE_SAFETY_STOP` | REVIEW_REQUIRED / EXECUTION_UNCERTAIN, valid saved uncertain result/evidence/ownership and an unambiguous exact stop prefix. Appends only missing TaskFailed, SessionResolved, ProgressRecorded and WorkflowBlocked events. Does not resolve the unknown external outcome or clear security/evidence reviews. |

Action recovery reuses `executionReader.ts` and the coordinator's transaction participant. Stopped workflows are not silently made RUNNING. Safety-stop validation rejects conflicting tasks, interleaved events, ambiguous sessions and already completed stops.

## Idempotency and lost acknowledgement

The operation ID is a digest-derived identity of the execution contract, plan ID and plan digest. Both the operation ID and successful plan association are unique. Issuing a new random operation ID cannot repeat a plan.

`inspectReceipt()` is an authenticated read without a mutation scope. It validates the saved plan, deterministic operation identity, consumed grants and quorum, business evidence, journal digest, original runtime/generation, hold transition and audits. It remains usable after lease takeover because it verifies the historical chain rather than granting new execution rights. A repeated execute call returns an exact existing receipt without rerunning the operation. Uncertain or mismatching evidence fails closed.

When SQLite reports that a transaction ended after an attempted COMMIT, an acknowledgement error can be resolved by this receipt path. Runtimes without that observation retain the conservative connection-close behavior; reopen the database and query the receipt. No exception alone is treated as proof of success.

## Effective state and hold history

Original `recovery_holds` rows remain immutable at revision 1. Each committed operation appends exactly one next revision. Other plans bound to the prior revision become stale even when the journal did not change.

Verified model resolutions provide effective state without rewriting historical facts:

```text
Effective outstanding reservation
  = original outstanding reservations - verified cancelled-unsent reservations

Historical application PENDING_APPLICATION + verified discard
  = effective application RESOLVED
```

The budget, coordinator, ledger guards, recovery gate, reader and subsequent planner share resolution validation. A model call can be subtracted at most once. Discarded responses cannot later be applied through `markApplied()`, `commitModelApplication()` or raw SQL, including in the same generation. Old owners remain fenced.

Reader output preserves historical model counts and adds effective counts and resolution details. Separate 4B identifiers appear in audit/timeline entries and never alias 4A references. `executionAllowed` and candidate `executable` remain false. `READY_FOR_CONTINUATION_REVIEW` is diagnostic: the original hold still stops the ordinary Runner and all direct dispatch/call paths. An uncertain action continues to require review even after its safety stop is complete.

## Verification and later phases

`npm run test:recovery-execution` covers contracts, authorization, stale bindings, four operations, effective budgets, scope separation, rollback, receipts, two connections, migration 0–6 to 7, and native child-process SIGKILL before/after COMMIT and individual writes. The existing durable, execution, reader, lease, model and 4A suites remain regression requirements. Existing assertions are retained; successful final schema expectations advance to 7.

Linux tests do not establish native Windows locking, permissions or crash behavior. Those remain a separate validation item. Production identity-provider integration and administrative HTTP/UI are outside this phase. 4B-2 must separately authorize bounded continuation, new calls, budget checks and final hold release; 4C must not infer unknown external outcomes or usage from a completed safe stop.

## COORD-5C-4C integration (Schema 10)

[Reconciliation](coordination-reconciliation-design.md) has its own contract,
ACL, Plan/Grant and private database scope. Existing safe-recovery grants cannot
authorize it. Current obligations and budget bindings use verified overlays;
historical 4B receipts retain their original immutable evidence. Settled usage
does not discard or reconstruct a response. Recording an Action fact does not
apply its Task result; application needs a separate fresh Plan/Grant and current
ASSIGNED/OPEN/RUNNING eligibility. Neither operation releases the Hold.
