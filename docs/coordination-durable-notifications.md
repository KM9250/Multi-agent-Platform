# Durable notifications (COORD-5D)

This extension starts from MAP `c89b5cd497e1529e0ed64d3d3983be6665c4969d`.
Schema 11 adds `011_durable_notification_outbox`; the internal contract is
`COORD-5D:DURABLE_NOTIFICATION:1`. MACP remains `macp / 0.1.0`.

## Commit and authority boundaries

The database owner captures minimal notification origins in the business
transaction, after its normal-fact reconciliation and bounded-runtime finalizers.
It explicitly closes their scopes before entering the private notification source
scope. A source insertion failure rolls back the business transaction, including
its receipts and audit. No recipient, identity service, network or host callback
participates in this source capture. Missing delivery configuration therefore
does not discard an already obtained business result.

The notification runtime receives private read/write/outside/exact-row closures
from `DurableDatabase`. A delivery transaction can write only notification tables;
it cannot write Workflow leases, Journal events, model/action ledgers, invocation
or hold state, recovery grants, or accounting. Generic `db.write()` and SQL
function calls cannot mint this scope. A rejected SQL operation poisons the
transaction even if its caller catches the error. Exact old-row matching and
transition triggers protect updates; notification history is not deletable.

Materialization freezes the source's packet, notification ID, template version,
binding digest, recipient, audience and Receiver Realm. One source has at most one
delivery, including when a host registers another alias for the same receiver.
Unconfigured sources remain `UNROUTED`. Materialization and notification management
do not call any business runtime, model, verifier, executor or WorkflowResume.

Each successful claim transaction consumes an attempt number and writes its
claim, generation, `SENDING` state and audit together. Only the call that directly
observes the successful commit receives the private one-shot send permit. Reading
a saved claim cannot recover a permit. An expired claim is fenced and its attempt
is treated conservatively as unknown; recovery uses a new attempt/generation.
One durable attempt calls the registered transport at most once.

The HTTP request runs outside the DB transaction. The collector checks its own
current authority, claim, generation, packet and realm. Revoking SEND prevents a
new request, while a still-authorized collector may record an already started
request's receipt. The authenticated reader separately checks current VIEW and
OUTPUT. Receipt commit acknowledgement loss can be recovered by reading that
receipt; it does not require another HTTP request or business operation.

## Meaning of delivery state

| State | Meaning |
| --- | --- |
| `UNROUTED` | Source exists; a usable recipient/binding has not been materialized. |
| `PENDING` | Candidate for current authorization and necessity checks. |
| `SENDING` | An attempt was reserved, not proof that MACP received it. |
| `RETRY_WAIT` | Persisted finite backoff before another eligible attempt. |
| `DELIVERED` | Valid MACP receipt; not read, displayed or approved by a person. |
| `SUPPRESSED` | Delivery is unnecessary/cancelled and no prior send remains uncertain. |
| `CLOSED_UNCONFIRMED` | No further retry, but a prior HTTP request may have been received. |
| `PAUSED` | Configuration, authorization, management or state uncertainty stops automatic sending. |
| `DELIVERY_FAILED` | Permanent failure or retry budget exhaustion; uncertainty remains separately visible. |

Necessity, management revision, attempts, receipt and unknown-outcome history are
separate fields. Resolving a business question does not erase a receipt or prove
that an earlier timeout was never received. A terminal Workflow resolves applicable
old Journal blocks, not an independent reconciliation dispute created afterward.

## Source connection map

| Source | Canonical records and capture boundary | Resolution and recurrence |
| --- | --- | --- |
| Existing eight Journal kinds | Validated `readJournal` and unchanged `projectNotificationOccurrences`; normal append and atomic Model Application share DB final capture. | Existing reference-aware `notificationDisposition`; valid resolution followed by another block produces the existing recurrence ID. Completion/cancellation remain historical facts. |
| `planning_review_required` | Published `planning_artifacts`, matching APPLIED model application and audit, owner, `PLANNING_ONLY` plan and FINISH `COMPLETED/AWAITING_PLAN_REVIEW`. | Exact artifact/version/digest/owner target and canonical review decisions; stale reviews cannot resolve a new artifact. |
| `planning_input_required` | `planning_input_requests`, corresponding APPLIED application, invocation owner and FINISH receipt. | Remains required because no canonical answered-question API exists. A delivery close does not answer it. |
| `recovery_review_required` | STOPPED/REVIEW_REQUIRED bounded invocation, FINISH receipt or exact generation-loss lifecycle; published plan/input uses its narrower kind. | Only the matching canonical resolution ends the obligation; heartbeat, inspection and unrelated later calls do not create or resolve it. |
| `reconciliation_review_required` | Verified dispute with matching target/case/audit; or validated reconciliation operation with remaining missing-response, un-applied outcome or budget obligation. Normal and Controlled result contradictions are captured after the normal-fact participant. | Matching action application or canonical response resolution can resolve the corresponding obligation; accounting settlement and terminal workflow status do not erase independent disputes. |

Non-Journal origins have a discriminated reference type, not a fabricated event
ID. Added-kind IDs hash canonical kind/reference/version/digest/owner. Packets
contain fixed summaries and the allowed MACP fields, never plan/question/evidence
text, source references, owner details, review tokens or credentials.

`DurableDatabase` covers normal append, Model Application, Safe Recovery,
Controlled Result, bounded planning/input/finish, reconciliation and normal-fact
contradiction paths. Notification-only transactions never invoke source capture
or normal-fact reconciliation. The source participant compares affected-workflow
heads first; unchanged heads avoid full replay. Changed source-bearing histories
are fully validated. Performance measurements must distinguish a large number of
small workflows from an unbounded history within one workflow.

## Identity and destination

Notification permissions are separate from business roles. The trusted host
supplies an identity verifier, per-target authorization, whole-output policy and
recipient/destination registry through `DurableDatabaseOptions.notifications`.
Absent dependencies fail closed. A credential or role in a request DTO is not a
verified identity. Production credential issuance and identity integration are
host responsibilities; test credentials are confined to test files.

Every decision binds the verified subject, operation, Workflow, source owner or
recipient subject, audience and Receiver Realm. Claim, SEND, collection, reader,
management and idempotent result replay check current permissions. Host callbacks
run outside DB authority. The packet's fixed fields are checked against its
canonical source and stored digest before delivery.

The host registers `/api/notify`, a binding version/implementation digest and the
receiver's durable idempotency realm. Production requires HTTPS and authentication.
Explicit loopback development is the only HTTP exception. URL credentials, query,
fragment, arbitrary path and redirects are rejected. An endpoint/realm/recipient
change pauses an existing delivery rather than forwarding it. A host-approved
credential rotation must retain the same receiver, realm and packet contract.
Digest values are consistency checks, not authentication against an OS/DB owner.

## Limits and ordering

Defaults are 4 KiB packets, 64 KiB responses, a 10-second HTTP deadline, 30-second
claims, 3 automatic attempts and at most 10 lifetime attempts. Backoff defaults to
250 ms through 5 seconds; the retry horizon is 24 hours. Configuration is bounded:
HTTP 120 seconds, claims 180 seconds, backoff 60 seconds, horizon 7 days, concurrency
8, batch 1000 and reader page 200. Defaults for concurrency/batch/page/poll are
2/100/50/2000 ms. Manual retry never changes the packet, ID or realm and never
resets the lifetime counter. No history is automatically deleted or compacted.

Within a Workflow's canonical destination stream, source sequence determines
claim order. An earlier unrouted, paused or failed source blocks a later source;
an explicit authorized close can advance the stream. Other workflows progress
independently. SQLite transactions are short and never span HTTP waits.

Current ACL and necessity are checked before claim and immediately before send.
There is still an unavoidable interval between the last check and HTTP: another
process may resolve or revoke during it. The system does not hold a DB write lock
over the network or claim atomicity across SQLite and HTTP. Delayed old network
requests may arrive after a later attempt; receiver idempotency is essential.

## Migration, restore and operation

Migration 001–010 generated SQL is pinned by hash. Migration 011 records each
existing Workflow's Journal anchor and exact occurrence baseline in its own
transaction with DDL, migration ledger and `user_version`. It does not enqueue all
historical events, invent DELIVERED records, perform identity calls or send HTTP.

`syncUnresolved` requires notification-specific permission, owner, destination,
expected baseline and request ID. It captures only proven currently unresolved
pre-baseline obligations, preserving their original occurrence ID and timestamp.
The source records `LEGACY_UNRESOLVED_SYNC`, because this is explicitly not the
original business commit. Sync itself sends nothing and repeated requests cannot
create another source. A later business commit remains independently captured.

DB construction and reads never start delivery. Register trusted host dependencies,
explicitly enable the deployment, then call `db.notifications.runOnce` or start
the notification worker. Reader and management APIs are Node-only host APIs, not
browser/model tools or a new unauthenticated HTTP administration surface.

The host wiring is explicit; the named host dependencies below must come from
verified deployment configuration, not HTTP/model arguments:

```ts
import { DurableDatabase, DurableNotificationWorker } from '../services/coordination/durable';

const db = new DurableDatabase({
  path: host.privateDatabasePath,
  notifications: {
    enabled: true,
    identityVerifier: host.notificationIdentityVerifier,
    authorize: host.authorizeNotification,
    output: host.authorizeNotificationOutput,
    registry: host.notificationDestinationRegistry,
  },
});
const worker = new DurableNotificationWorker(db.notifications, host.serviceCredential, {
  workflowRunIds: host.notificationWorkflowIds,
});
await worker.runOnce();          // one bounded scan; no background service
// Or worker.start() explicitly; do not invoke it from a reader.
await worker.stop();             // stops new claims and bounds collection time
db.close();
```

The authenticated page exposes an immutable legacy baseline when present. Pass
its digest as `expectedBaseline` to `syncUnresolved`, together with an authorized
human credential, owner, destination and unique request ID. Management PAUSE,
RESUME, RETRY and CLOSE similarly require an exact delivery revision and request
ID. Request replay rechecks current authorization and output before returning.

Reader pages filter row-specific VIEW denials before parsing protected source or
packet bodies. Public `position` and `nextCursor` count only authorized rows; they
do not expose physical source-sequence gaps. Per-row and whole-page OUTPUT still
apply. ACL changes between requests can shift these positions. This initial
implementation retrieves routing metadata for the requested workflow and scans
permissions to the authorized page; metadata work can grow with that workflow's
source count even though returned bodies are capped at 200. The page's backlog
summary is explicitly `scope: 'PAGE'`; follow cursors for further authorized rows.

The host worker scans at most its configured batch per cycle, rotates an explicit
workflow cursor, and returns `nextCursor`. It limits concurrent sends with both
local lanes and DB-wide active claims. Persist a returned cursor in host service
state if scheduling continuity is required across worker restarts. Source and
delivery ordering remain in SQLite regardless of that scheduling cursor.

For a fully local synthetic deployment with real authenticated HTTP, temporary
SQLite and SSE, use the pinned MACP integration command documented in
`coordination-macp-integration.md`. It creates no production identity or receiver.

Use SQLite-consistent backups including the notification tables, baselines and
tombstones. Restore the same deployment with the same receiver idempotency history.
Copies have sending disabled by default; do not enable two independent stores in
the same producer/Workflow namespace. Existing IDs do not contain a deployment ID.
Receiver DB replacement/reset invalidates the realm's deduplication guarantee and
requires an explicit operational decision; it cannot be repaired by changing IDs.

The old in-memory browser/non-durable outbox remains available. Wrapping a durable
store with the old observer is rejected as double wiring. The browser barrel does
not export SQLite, node transport or credentials. See the validation, redteam and
crash/migration documents for measured evidence and limits.
