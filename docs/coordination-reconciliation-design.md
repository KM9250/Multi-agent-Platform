# COORD-5C-4C reconciliation design

Baseline: `89d431e20cf1f6617d4095b9a8722d86fb711d1d` (main, PR #35).
Contract: `COORD-5C-4C:RECONCILIATION:1`. Schema: 10,
`010_evidence_reconciliation`. Existing migrations 001–009 remain immutable.

This inventory was prepared before implementing the new reconciliation paths.
Evidence submission, trusted verification, authenticated approval, business
application, and permission to resume remain separate decisions.

## Existing entry points and their responsibilities

| Entry | Integration requirement | Historical contract retained |
| --- | --- | --- |
| `modelCallLedger.ts`: reserve, dispatch, settle, `modelBudgetPosition` | One NORMAL/RECONCILED accounting authority per attempt; shared effective usage and outstanding reservation | Original call, attempt, quote, generation, and Journal remain unchanged by reconciliation |
| `safeRecoveryModelState.ts` | Overlay verified settlement and response obligations separately from cancellation/discard | Validate old 4B receipts against their original rows |
| `executionCoordinator.ts`, `executionLedger.ts`, `pendingActionStore.ts` | Seal reconciled attempts against late normal writes; distinguish external fact from Task application | Preserve original execution result and finalization references |
| `executionReader.ts`, `executionIntegrity.ts` | Keep strict historical validation; expose reconciled facts through a separate authenticated reader | Do not substitute a new result under an old result reference |
| `recoveryPlanner.ts`, `safeRecoveryPlanner.ts`, `safeRecoveryStore.ts` | Bind current accounting, obligations and revisions | Old grants do not become reconciliation grants |
| `controlledRecoveryPlanner.ts`, `recoveryDispatchCoordinator.ts` | Current effective accounting/obligations before creating or consuming controlled grants | No original Action retransmission |
| `recoveryContinuationPlanner.ts`, `recoveryContinuationCoordinator.ts`, `recoveryContinuationReader.ts` | Current workflow and invocation usage; unresolved responses; current control revision | Invocation debits, consumed send permits and old deadlines remain consumed/unchanged |
| `recoveryExecutionGate.ts`, `recoveryHoldLifecycle.ts` | Same current obligations; preserve safety, review, legacy and budget blocks | No automatic Hold release or WorkflowResume |
| `recoveryReader.ts`, `modelCallRecovery.ts`, `recoveryTimeline.ts` | Separate historical state, effective facts, late usage and remaining obligations | Read-only inspection never starts verification, writes, or execution |
| `runner/context.ts`, `runner/types.ts`, `durableRunner.ts` | Only explicitly authorized normalized facts enter model context; effective budget accompanies historical snapshot | Evidence text cannot grant authority or act as instructions |
| `kernel.ts`, `validation.ts`, `restore.ts`, `durableCoordinationStore.ts` | Narrow, fixed event participation for eligible reconciled Action application | Terminal rejection, replay and prior snapshots remain intact |
| `db.ts`, `schema.ts`, migration/trigger modules | Dedicated private reconciliation scope, current lease, poisoned rejected transactions, immutable records and unique effects | No SQL function or serialized DTO creates capability |

Raw `DISPATCH_INTENT` and `DISPATCH_RESERVED` predicates have two different
purposes: original receipt validation and present-day obligation checks. Only
the latter may use the new projection. Replacing all raw predicates would
invalidate legitimate historical receipts and is prohibited.

## Trust and accounting boundaries

Host startup supplies identity verification, per-operation ACL/policy, finite
storage/verification limits and trusted verifier bindings. A candidate has no
positive business authority. A verification establishes only its explicitly
validated source, target, completeness and finality. A fresh plan and the
configured distinct approvers authorize one fixed operation. The plan creator
must initiate its application with current authorization.

The intended accounting equation is historical Journal usage plus uniquely
authorized reconciled usage. A fully settled attempt contributes no outstanding
reservation; partial or unknown usage retains its reservation. Dispatch counts
remain consumed even when a verified monetary amount is zero. Late terminal
usage belongs to the reconciliation ledger, never to a new historical Journal
event. Usage settlement does not recover a missing model response.

Source-effect uniqueness includes the host authority domain, source, account,
environment, external operation, and effect dimension. A content digest proves
content identity, not provenance. Local synthetic signatures test provenance
mechanics without claiming support for production provider billing semantics.

## Scope and exclusions

No production provider, identity/ACL service, management HTTP API or UI is
connected by this change. Missing registered capabilities fail closed. No
arbitrary URL/path evidence collector, model generation, original Action resend,
refund, compensation, response reconstruction, automatic resume or automatic
Hold release is introduced. Same-process arbitrary code/OS/database compromise
is outside the capability boundary.

## Implemented public API and private participants

The Node-only durable entry point exports `ReconciliationEvidenceService`,
`ReconciliationPlanner`, `ReconciliationAuthorizer`, `ReconciliationExecutor`,
and `ReconciliationReader`. It exports contracts, not an evidence signer or a
way to persist an arbitrary verified DTO. `DurableDatabaseOptions.reconciliation`
accepts trusted startup policy, verifier registry and finite limits. The
identity verifier is the existing verified-recovery identity boundary.

| Stage | Admission and persisted result | Effects excluded |
| --- | --- | --- |
| `submitCandidate(input, credential)` | Target/submit ACL, descriptor-safe bounded JSON, host classification; immutable metadata and separate body | No usage, resolution, Grant consumption, Hold or Task change |
| `verify(ref, credential, signal)` | Verify/use ACL; finite durable job; fixed registered verifier outside parent authority; current ACL/target/binding/deadline rechecks; immutable verification receipt | No positive accounting or Task effect; trusted contradictions may only tighten safety |
| `createPlan(input, credential)` | Current evidence/version, source/target, original digests, current lease/generation, Journal cursor, accounting/control/case/seal revisions and policy | No external execution or Grant consumption |
| `authorize(planId, scope, credential)` | Explicit per-operation quorum/self-approval policy; distinct verified actor and current material-view/use ACL | Does not establish truth or start application |
| `executeAuthorized(planId, credential)` | Creator-only start, current ACL/identity/lease, all binding and approval rechecks | No provider/Executor callback, resume, generation rewrite or Hold release |
| `inspectReceipt` / `inspect` | Current view ACL; immutable historical receipt validation and effective obligations | No repair, verification, lease acquisition or business execution |

The private runtime supplies exact-row writes to a DB-owned capability. SQL
functions inspect this capability; calling a function does not create it.
`BEGIN IMMEDIATE` covers effect rows, authority/seal, the optional fixed Task
event, consumed Grants, operation/Grant links, case/control revisions and audit.
Foreign keys are deferred only where the operation's mutually referring rows
need to be committed together. A rejected SQL participant poisons the whole
transaction even if its immediate error is caught. External callbacks run under
an async context that denies database writes and strips bounded invocation
privilege. Callback errors become fixed codes without copying source payloads.

## Operations and effective projections

`RECORD_VERIFIED_ACTION_OUTCOME` accepts final, complete executed/non-executed
facts. Non-execution additionally requires an exhaustive source and a closed
request. Partial/pending/unknown facts remain verification records and cannot
seal or release an attempt. A result is optional for fact recording; its absence
leaves `RESULT_DETAILS_MISSING`. The original execution ledger and result are
never overwritten. Existing definitive contradictory results create a Dispute;
uncertain prior results may be overlaid without deleting the uncertainty history.

`APPLY_RECONCILED_ACTION_RESULT` requires a separate approved Plan and its exact
outcome receipt, current ASSIGNED Task / OPEN Session / RUNNING Workflow,
appropriate policy/review state, and no active/draining invocation. It creates
one host-derived TaskCompleted/TaskFailed event, a new result reference and an
application receipt. A failed/closed/terminal business history is not revived.
Normal and reconciled completion share the deterministic Task result event
identity; duplicate application is also blocked by unique Task/outcome keys.

PR #36 F-01 distinguishes adoption expiry from later application. APPLY validates
the original Outcome's committed receipt and proves it was adopted before the
Verification expired. It still checks current trust/binding, Dispute, ACL, target,
Lease and fresh Plan/Grant validity. Unadopted expired evidence remains ineligible.
No deadline or old row is rewritten; a newer unverified candidate version alone
does not invalidate the adopted fact. Application history validates its original
Outcome receipt instead of requiring the old adoption deadline to remain current.

`SETTLE_VERIFIED_MODEL_USAGE` uses complete, final USD usage with the original
quote's fixed pricing ID. Tokens and micro-USD quantities must be safe,
nonnegative integers at the accounting boundary; no unknown values become zero.
The synthetic source contract defines inclusive input/cache and output/reasoning
semantics. The host derives one logical call for a dispatched attempt, including
zero-cost attempts. Actual usage can exceed its quote/workflow/invocation limit;
it is retained in full and reported as a budget violation, never clipped.

Historical `run.usage` remains replay. `effectiveAccounting` adds only
RECONCILED authorities to Journal usage; NORMAL authorities are not added again.
`effectiveModelRows` overlays complete settlement independently of response
application. A missing response remains `UNAVAILABLE_REVIEW_REQUIRED`, while a
source-proven final failure with a closed request may be
`NOT_APPLICABLE_VERIFIED`. Original invocation debits associate late usage with
its original invocation without changing its deadline, counters or termination.

`effectiveActionRows`, `effectiveModelRows` and the shared accounting functions
feed normal model/action gates, recovery/safe/controlled/bounded planners,
invocation accounting, the SQL Hold-release predicate, current recovery readers
and Runner budget checks. Historical receipt validation uses original rows and
event slices, so later application, heartbeat, generation changes and expiry do
not erase a committed fact. The Reader distinguishes case completion from
workflow eligibility and always returns `executionAllowed=false`.

## Conflicts, revocation and later model context

Only a trusted complete final contradictory verification can append a Dispute,
advance Case/Control, re-Hold, and move an ACTIVE invocation to DRAINING. Abort
notification occurs after confirmed COMMIT outside parent authority. Rollback
emits no Abort. An explicit trusted registry revocation is a separate negative
transition; ordinary expiry or an unconnected registry does not rewrite settled
history. Disputed usage remains counted and no automatic refund/correction is
made.

PR #36 RT-01 also compares newly persisted NORMAL usage and Action results at the
DB-owned pre-COMMIT boundary, so contradictions are detected in either arrival
order. The normal fact, Dispute, Case, Hold/Drain and Audit commit atomically.
The negative participant uses `system:normal-fact`, consumes no Grant and keeps
the actual normal Usage under the existing unique authority. Its post-COMMIT
notification runs after transaction scopes are cleared. Readers and candidate
submission do not repair historical missed conflicts by writing to the database.

PR #36 RT-02 uses one output helper for first verification return, cache, lost-ACK
recovery and explicit verification reads. Current Identity, VIEW_CASE,
owner-specific USE_EVIDENCE and OUTPUT classification of the entire returned
receipt are required. Output denial preserves a committed Verification and
returns a fixed authorization error; authorized rereads do not run the verifier.
See the [audit correction report](coordination-reconciliation-pr36-corrections.md)
for regression and process coverage.

Later PLAN/VERIFY receives normalized identifiers and outcomes through a fixed
`RUNNER_CONTEXT` projection, using current view/use/send ACLs and an explicit
host `canSend` check for the destination. No evidence body is attached. The exact
fact set and ACLs are checked again before model dispatch; a denied send does
not invoke the provider. The dedicated reconciled result-reference reader
validates the Task/application link. PLANNING_ONLY and Bounded Runner use their
current authenticated invocation identity for the same projection.

A new Action ID cannot bypass a sealed attempt by repeating the exact registered
executor, operation, fingerprint and canonical payload digest of a reconciled
final effect. This is a conservative structural guard, not semantic external
exactly-once. Different IDs/payloads at an unconnected external service cannot
be proved equivalent by this host. Future adapters need an audited stable
effect/correlation contract. No missing historical correlation identifier is
backfilled as if it had been sent.

## Resource limits, persistence and limitations

Defaults are 256 KiB per candidate, 64 KiB per normalized claim, 128 KiB per
Plan/receipt, JSON depth 32, 200 candidates / 8 MiB per Workflow, four concurrent
verification jobs, 10-second verification execution, and a 1-second collection
window. Host overrides may tighten these finite defaults. Plans default to ten
minutes and never exceed thirty minutes; these are separate from old invocation
deadlines. One verification reference is accepted per Plan in this first
contract, a stricter limit than the specified maximum of sixteen.

Input preflight rejects accessors, Proxy, thenable data, custom prototypes,
cycles and oversize structures before canonical copy. Only explicit small JSON
or UTF-8 data is accepted; no URL/path/ZIP/PDF collector exists. Host content
inspection runs at acceptance, release to the verifier, normalization and output.
It is a required integration boundary, not a regex-only secret guarantee.
Bodies, metadata, identity of submitter/owner, verifier source, approver and
applier remain distinct. General audit stores fixed IDs/digests/codes and no
candidate body or credential.

The verifier receives nonsecret target identifiers and binding digests rather
than raw Action payloads, model prompts or quote text. Content policy inspects
the entire material actually released to it, including that target metadata.
Candidate ACK retries with the same logical ID and content return the existing
version. Verification ACK recovery uses its completed immutable job receipt.
Neither path calls the original Action or model. Approval credentials stay only
inside the private host runtime; after restart an approver must authenticate
again before an unconsumed Grant can be applied.

The registered test verifier uses Node's standard Ed25519 verification over the
complete canonical signed payload (target and original digest, source/account/
environment/external effect, claim/finality/completeness, expiry). Keys are
created temporarily by test code. Payloads cannot select a trust key or signing
algorithm. Tests/issuers are not exported through the production barrel.
Production GPT/Gemini/Claude/executor provenance, billing definitions, correlation,
internal retries, production identity/ACL wiring, HTTP/UI and Windows process
behavior remain unconnected or untested as stated in the validation report.
