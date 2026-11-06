# Recovery Decision / Authorization / Execution Gate (COORD-5C-4A)

Schema **6**, migration **`006_recovery_decision_authorization`**, builds on
`f68feeab36cd1090f5e1b94cd9ea32b1cb0f69ec` (5C-1–5C-3). This is a record-only
recovery contract. It cannot resume a Workflow, send an Action, invoke a Model,
apply a saved response, reconcile unknown usage, consume a grant, or clear a hold.
An `AUTHORIZED` record is not an execution capability.

## Responsibilities and public server API

All exports are in the Node-only durable entry point. Nothing is added to the
browser entry point, HTTP routes, UI, provider credentials, or external adapters.

| Component | Responsibility |
| --- | --- |
| `RecoveryReader` | Validate saved artifacts and audit; report decisions in the same read transaction |
| `RecoveryPlanner.preview(id)` | Read-only candidates, review requirements, and prohibitions |
| `RecoveryPlanner.createPlan(input, credential)` | Register an immutable plan under a verified lease and operator identity |
| `RecoveryDecisionStore` | Trusted local inspection; `view(id, credential)` is the authenticated viewer boundary |
| `RecoveryAuthorizer` | Issue, revoke, explicitly invalidate, and inspect record-only grants |
| `RecoveryExecutionGate` | Persist discovered risk and refuse execution starts |

`RecoveryInspection.executable`, `executionAllowed`, previews and grant inspection
remain `false`. A `READY_TO_RESUME` diagnosis still supplies no authority.
Construction, preview, reads, and reopening a current-schema database do not
start a Runner or take a lease. Migration may add protection to existing records.

## Identity and policy boundary

The trusted server host may inject `recoveryIdentityVerifier` into
`DurableDatabaseOptions` at startup. The synchronous verifier validates opaque
credentials against its trusted Control Plane and returns an actor ID, roles,
source ID, authentication time and expiry. This dependency must never be populated
from request data. The database captures its verifier function at construction.

There is no production identity-provider implementation in this change. With no
verifier, issuance, plan registration, revocation, invalidation and authenticated
viewer requests fail closed. Existing local Reader/Store diagnostics remain
available to trusted server code. Remote integrations must use the authenticated
boundary and their own Workflow visibility policy.

| Role | Permissions |
| --- | --- |
| `RECOVERY_VIEWER` | Authenticated viewing |
| `RECOVERY_OPERATOR` | Viewing, registering plans, invalidating stale plans |
| `RECOVERY_APPROVER` | Viewing, approval, revoking own grants |
| `RECOVERY_ADMIN` | All above, including revoking another actor's grant |

The only identity issuer in the tests uses a test-local WeakMap. It is outside
production sources and barrel exports. Claimed actor strings, copied token DTOs,
role strings, SQL function calls, or authorization IDs cannot establish identity.
No token, password, API key, Cookie or raw verifier error is persisted. Actor and
source IDs are bounded identifiers, not free-form credential containers.

`recoveryAuthorizationPolicy` configures `minimumApprovers` and
`forbidSelfApproval` independently per operation. Defaults are one approver and
no separation-of-duties requirement. Distinct actor grants count toward quorum;
duplicates never add a vote. Policy changes invalidate old plans. Quorum is
diagnostic only in 4A; even a complete quorum cannot execute an operation.

## Plan and digest contract

Each plan stores its ID, Workflow ID, operation and target, Journal cursor and
event ID, runtime instance and generation, Action and Model digests, policy and
budget-position digests, hold revision, review and approval requirements,
contract version, creator, creation time and expiry. Canonical JSON and SHA-256
reuse the existing durable implementation. The plan's digest binds all these
fields except `planDigest` itself.

The Action digest includes Ledger, prepared Action, Result and Evidence rows.
The Model digest includes Ledger, attempts and coverage. The policy digest
includes Workflow policy and recovery approval policy. The budget digest includes
committed and outstanding integer budget positions, limits and recorded usage.
Rows are ordered deterministically. Runtime lease capability hashes are never
included or exposed. Lease heartbeat/expiry changes do not invalidate a plan;
runtime ownership and generation changes do.

Recovery Plan/Authorization/Audit rows, their timestamps and Audit Sequence are
excluded from the business-state digest. Saving the plan or another plan therefore
does not invalidate it. Its own hold revision remains a bound protection fact.

Approval re-reads and validates the full saved state inside `BEGIN IMMEDIATE`.
Journal, target state, policy, budget, generation, hold revision, requirements,
terminal state and expiry changes reject the plan. Grant inspection performs
the same comparison in a read transaction. Stored snapshots are never treated
as permanently current.

| Fixed operation | Candidate evidence | 4A behavior |
| --- | --- | --- |
| `REFLECT_RECORDED_RESULT` | Valid `RESULT_RECORDED` Action | Record only |
| `CANCEL_UNSENT_MODEL` | `RESERVED` Model with no dispatch intent | Record only |
| `DISCARD_SETTLED_RESPONSE` | Settled, pending response | Record only |
| `COMPLETE_SAFETY_STOP` | Review-required Action with a recorded Result | Record only |
| `ALLOW_PREPARED_DISPATCH` | Prepared Action | Record only |
| `BOUNDED_CONTINUATION` | No unresolved Action/Model outcome; tracked coverage | Record only |
| `RECONCILE_VERIFIED_USAGE` | Future verified external evidence contract | No candidate until that verifier exists |

Unknown Action dispatch and unknown Model usage cannot become a redispatch or
zero-settlement candidate. Candidates retain existing Action Approval,
Security Review, Evidence Review and explicit-resume requirements. Recovery
approval does not satisfy those independent requirements.

## Authorization lifecycle and time

Plans are immutable DRAFT records; explicit stale-plan invalidations are separate,
immutable records. Issued grants have `AUTHORIZED` or `REVOKED` persisted state.
`EXPIRED` is derived from database time without writes or synthetic audit events.
`CONSUMED` is reserved in the schema but cannot be inserted or transitioned to.

Every grant binds the Plan ID/digest, Workflow, operation, target, actor, role,
source, time bounds, runtime/generation and contract. Grant digests and immutable
audit provenance detect mismatched saved fields. Scope is immutable. One actor
can issue at most one grant per plan; retrying approval returns the same grant
without extending expiry. Revocation retries must match the retained reason.
Expired or revoked grants cannot be revived. An administrator's cancellation
records the actual revoking actor separately from the original approver.

Default TTL is ten minutes and the hard maximum is thirty minutes for both plans
and authorizations. Authorization expiry is also capped by the plan and verified
identity expiry. Invalid TTLs, database read failures, invalid dates and clock
anomalies fail closed. Time comes from SQLite and is checked against a process
monotonic anchor using the 5C-2 drift tolerance; writes additionally revalidate
the lease before COMMIT. Diagnostic Reader clocks cannot extend grant validity.

Every 4A plan/grant uses **`COORD-5C-4A:RECORD_ONLY:1`**. 4B must introduce a
different executable contract and require explicit reissue and reapproval.
Installing an executor must not promote an existing grant.

## Durable holds and execution gates

The migration retains all existing business rows, digests, Journal and runtime
audit facts. It adds holds for legacy/unverified Model coverage, expired active
leases, uncertain Action/Model state, unapplied responses, budget violation and
saved explicit stops. A new healthy Workflow does not get an unconditional hold.

An expired ACTIVE lease takeover inserts its hold through a trigger in the
**same transaction** as the new lease generation and `LEASE_TAKEN_OVER` audit.
A clean release/reacquire also creates protection when risky saved state remains.
A lost COMMIT acknowledgement cannot issue a lease handle. Readers validate the
hold's generation against the corresponding lease audit. Migration-origin holds
have explicit migration provenance; no invented historical runtime audit is added.

When an execution gate discovers risk under a current verified lease, it commits
the hold and `RECOVERY_HOLD_CREATED` together, then raises `RECOVERY_HELD` outside
that transaction. A caller catching the error cannot roll back the protection.
Hold revision starts at one. Holds cannot be updated, deleted, set inactive or
cleared by any public 4A API. Lease renewal, inspection and release still work.

Protected paths include both Runner entry points, Action registration and
reservation, Model Coordinator calls, Model Ledger reservation/dispatch intent,
Task/Session registration, and Workflow resume. SQL start predicates inspect
saved risk even if a caller bypasses the higher-level coordinator. Current PLAN
response application may register its business events before its APPLIED receipt;
that registration cannot dispatch while an unapplied response remains.

All WorkflowResumed persistence is disabled in 4A. This also leaves stopped
Action Approval, Security Review and Evidence Review flows stopped until 4B
defines their recovery transaction. The original Reader still diagnoses already
saved pre-v6 first-resume histories, and the non-durable Runner retains its
existing approval/resume behavior.

While held, additional triggers reject inserts/updates/deletes in Journal, Seed,
checkpoint, pending Action, execution Ledger, Result, Evidence, Model Ledger,
attempt and coverage tables. These are additive to the 5C-2 fencing triggers.
Independent connections lacking the registered functions fail closed. Functions
are read predicates: none creates context, consumes a grant or clears protection.
An invalid protected write poisons its transaction even if a callback catches
the immediate error.

Private recovery-management intent lives only in `DurableDatabase` private fields.
The closed command dispatcher verifies identity, permission, lease and Workflow
scope before setting a specific operation/record intent. It accepts no callback
with management authority. Ordinary `write`, `writeWithLease`, arbitrary DTOs and
direct SQL cannot set this context. There is no recovery-execution capability.

Normal current-lease settlement, Result finalization and existing narrowly scoped
safe-stop completion remain in place. Once a durable hold exists, even these
business writes are refused. In particular, a partial safety stop after takeover
is retained for 4B rather than completed through a broad exception.

## Schema and audit

New STRICT tables: `recovery_holds`, `recovery_plans`,
`recovery_plan_invalidations`, `recovery_authorizations`, `recovery_operations`.
Foreign keys bind Workflows, Plans, grants and future operation references.
Fixed operation/reason enums, uniqueness, immutable rows and grants, transition
guards and delete prohibitions retain history. `recovery_operations` has a unique
authorization reference and room for COMMIT evidence/outcome state; every insert
is rejected in 4A.

Runtime Audit adds nullable Plan ID, Authorization ID, Hold Revision, record
digest and verified-actor reference columns. Plan creation, explicit invalidation,
authorization and revocation produce their fixed audit events in the business
transaction. Audit failure rolls everything back. Gate-created holds are audited
in that transaction. Takeover/acquire holds are proven by the same-COMMIT lease
audit, without pretending a separately committed recovery event exists.

`RecoveryReader` validates new audit references, digests, ownership, transitions
and actor provenance, and reports holds/plans/authorizations in its existing
consistent read transaction. The timeline exposes the new references and actual
revoking actor. Failed authorization checks are exceptions, not fabricated
durable grants or audit facts. Expiration reads do not append events.

## Verification and limits

The dedicated `test:recovery-authorization` suite covers authenticated and forged
requests, roles, self-approval/quorum, scope, expiry, clock/read failure, state
movement, generation and hold changes, cancellation, immutable SQL, independent
connections and safe normal bootstrap. Real child processes receive SIGKILL
before/after Plan, Authorization, Revocation, takeover and migration COMMIT.
Independent SQLite readers check complete old/new state and matching audit.
Migration tests cover 0/1/2/3/4/5 → 6, rollback, preserved artifacts and legacy holds.

Existing tests retain their corruption, duplicate-effect, audit and fencing
assertions. Schema expectations advance to six. Tests which previously resumed
after a crash/stop now require refusal and unchanged business history. Reader-only
pre-v6 fixtures explicitly construct historical resume records; this facility is
test-only. Crash preparation now occurs under the same live lease as the tested
write, so setup does not itself attempt prohibited recovery. IPC snapshots restore
SQLite row prototypes before strict comparison.

The supported security boundary is the trusted Node host and its protected SQLite
file, as in 5C-2. This does not sandbox hostile code with permission to replace the
database, drop triggers, redefine functions on an arbitrary SQLite connection or
alter application code. No production login service, HTTP administrator API,
encrypted credential store or external exactly-once guarantee is added.

Linux / Node 24 and built-in SQLite are exercised. Native Windows termination,
file/ACL behavior and Node 22.13 execution remain unverified. SIGKILL tests use
real Linux child processes; no Windows-equivalence claim is made.

## Handoff to 5C-4B / 4C

4B must revalidate plan scope, all current state, requirements, quorum, time and
generation inside the execution writer. Authorization consumption, operation
receipt, business writes and hold revision update must share one COMMIT. It must
define narrowly scoped completion/reflection/cancellation transactions, including
stopped Action Approval/Security/Evidence flows. No standalone consume API and no
administrative `hold=false` toggle should be introduced.

4C must define externally verifiable usage evidence, old-generation reconciliation
and recovery completion. Unknown external outcomes must remain unknown; never
automatically retry or settle them as zero. Both phases require a new executable
contract and fresh approval of every former record-only 4A decision.
