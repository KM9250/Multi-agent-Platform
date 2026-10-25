# Durable coordination foundation (COORD-5A)

The current additive COORD-5C-2 migration advances the database schema to 4 while
retaining the version-1 Seed/Journal/Checkpoint payloads described here. See
[durable execution](coordination-durable-execution.md) for mandatory Coordinator
wiring and [Runtime Lease/Fencing](coordination-runtime-lease.md) for mandatory
write authority: a durable Store alone is no longer a valid Runner execution setup.

This Node-only module saves a Workflow seed and committed Journal in SQLite and
restores a validated Kernel projection after restart. It does **not** recover
external actions or start a Runner. A restored `RUNNING` status is historical
state, not permission to execute it after restart.

## Driver and supported runtime

Use Node.js **22.13.0 or newer**, with a maintained Node 22/24 release recommended.
`node:sqlite` provides synchronous `DatabaseSync`, explicit transactions, WAL,
integrity PRAGMAs and SQLite backup (`VACUUM INTO`). The synchronous API matches
`CoordinationRunnerStore` without changing the Kernel/Runner contract. Node 22.13
removes the `--experimental-sqlite` flag requirement; the module is still marked
experimental in that release and emits an ExperimentalWarning. This dependency
is intentional; it must be reconsidered when changing supported Node versions.
Only APIs present in 22.13 are used. No separate native addon, node-gyp, compiler
or Node ABI-specific npm binary is needed, including on official Windows builds.
The existing TypeScript test loader also uses experimental Node flags.

Import `services/coordination/durable/index.ts` directly from trusted server code.
It is intentionally absent from the browser `services/coordination/index.ts`
barrel. The React/Vite application continues to use its existing in-memory store.

## Storage configuration and initialization

Provision a dedicated, private directory on trusted **local** storage. Do not
place a WAL database on a network share. Get the absolute path from trusted
server deployment configuration, never from a model, webpage or user payload.

```ts
import { DurableDatabase, SqliteCoordinationRunnerStore, createRuntimeLeaseManager } from
  '../services/coordination/durable/index';
import { createWorkflow } from '../services/coordination/kernel';

const db = new DurableDatabase({
  path: '/srv/map-private/coordination.sqlite', // Windows: C:\\MapPrivate\\coordination.sqlite
  busyTimeoutMs: 5000, // finite, 0..60000 ms
});
const admin = new SqliteCoordinationRunnerStore(db);
const leases = createRuntimeLeaseManager(db);
try {
  const seed = createWorkflow(trustedWorkflowInput);
  admin.createWorkflow(seed); // only a canonical initial snapshot, with one creation event
  const lease = leases.acquire(seed.run.runId);
  const store = admin.withLease(lease);
  const current = store.getSnapshot(seed.run.runId);
  const next = store.append(trustedEventFor(current));
  store.createCheckpoint(next.run.runId); // explicit; no timer or background runtime
  leases.release(lease);
} finally {
  db.close();
}
```

Opening the database explicitly configures and verifies `journal_mode=WAL`,
`synchronous=FULL`, `foreign_keys=ON`, `recursive_triggers=ON`, and `busy_timeout` on that connection.
Initialization/migration runs inside `BEGIN IMMEDIATE`; failure closes the
connection. `quick_check` and foreign-key validation run before use. Broken
checkpoint references are excluded from fatal foreign-key errors because they
are derived data; checkpoint selection will reject them. Journal/seed ownership
errors remain fatal. Every read uses one SQLite read transaction so a concurrent
writer cannot produce a mixed seed/head/events view.

New directories/files use POSIX modes 0700/0600. On POSIX, an existing parent
must already be private (no group/other permission bits); the module will not
silently chmod a shared parent. Existing database files are restricted to 0600,
and symbolic-link database files are refused. Keep ancestor directories trusted.
SQLite sidecars inherit the private file/directory protection. The database is
not encrypted. On Windows, provision an NTFS ACL restricted to the service
identity and operators; POSIX mode bits/chmod cannot establish an equivalent ACL.
Use a writable local directory with permission to create the DB, WAL and SHM
files. No elevated runtime privilege is required. Antivirus/backup tools holding
file locks can cause bounded `DATABASE_BUSY`/`DATABASE_ERROR` failures.

Do not store tokens, credentials or raw secrets in Goal, payload or references.
The API does not attempt to guess/redact arbitrary business JSON. Database files
and SQLite sidecars are gitignored. Tests create private temporary directories,
close connections/child processes, and remove their files afterward.

## Schema version 1

| Table | Content and constraints |
| --- | --- |
| `schema_migrations` | Version PK, unique numbered migration ID, application time |
| `workflow_seeds` | Workflow PK; immutable version/seed/policy/time and SHA-256 digests; transactional latest sequence and cumulative Journal anchor |
| `journal_events` | Workflow FK; sequence, event ID/type, session, actor, timestamp, nullable idempotency key; full event JSON envelope and its SHA-256 digest |
| `workflow_checkpoints` | Checkpoint ID PK; Workflow FK, version, sequence, snapshot JSON/digest, Journal anchor and creation time; composite FK to the referenced Journal position |

Journal UNIQUE constraints are `(workflow_run_id, sequence)`,
`(workflow_run_id, event_id)` and `(workflow_run_id, idempotency_key)`.
Missing/empty keys map to SQL NULL, consistent with the Kernel's truthy-key
retry behavior; NULL keys do not constrain other keyless events. Workflow
identity scopes queries and uniqueness. This is storage ownership isolation,
not multi-tenant caller authentication; only trusted runtime adapters hold a store.
Triggers reject Journal updates/deletes and immutable seed/policy updates/deletes.
Only head sequence/anchor advance, in the same transaction as the new event.
The saved creation event is inserted once and must equal the seed's first event.

`payload` stores the **whole event envelope**, not just its business payload;
indexed columns are checked against that envelope on every restore. Canonical
JSON sorts object keys. Ordinary optional object properties with `undefined`
are represented as absent, including fields emitted by the current Runner;
returned projections may likewise omit those optional fields. Payload roots must
be JSON values. Undefined roots/array entries, sparse arrays, functions, symbols,
BigInt, nonfinite numbers, cycles, getters and non-plain objects are rejected
without invoking `toJSON`. This is a JSON boundary, not arbitrary JS serialization.
Retries compare the resulting JSON-domain events through the existing Kernel.

The immutable seed is validated against a canonical empty projection with the
**saved** creation event applied. No new creation identity/time is generated.
The cumulative anchor is `SHA256(canonicalJSON([previousAnchor, eventDigest]))`,
starting with an empty string. The stored head also detects a removed committed
tail; checking contiguous rows alone would not detect that loss.

## Append, idempotency and transaction participation

`SqliteCoordinationRunnerStore` implements synchronous `getSnapshot(id)` and
`append(event)`. Administration provides `createWorkflow(seed)`,
`listWorkflowIds()`, `restoreWorkflow(id)`, `createCheckpoint(id)` and
`loadCheckpoint(id)` (the newest valid candidate, or undefined).
Snapshots are newly restored objects; caller mutations never update stored data.
Input events are not mutated. Returned snapshots are not kept in a mutable cache.

Append runs `BEGIN IMMEDIATE`, restores/validates the latest Journal, checks
**both** event ID and idempotency key, applies `appendEvent`, validates the next
snapshot, inserts the event and advances the head, then COMMITs. Only after a
successful COMMIT does `append` return. SQLite serializes writers even across
independent processes. A stale new event gets `SEQUENCE_CONFLICT`; locks wait for
the finite busy timeout, then return `DATABASE_BUSY` for caller-controlled retry.
No external action is retried by this module.

For an identity match, Kernel semantic equality determines whether the operation
is the same. New retry ID/sequence/timestamp do not replace the first committed
values. A matching retry returns the **current** committed snapshot, even if
later events have already been saved or the Workflow is terminal. Different
contents get `EVENT_COLLISION`. Checking both identities prevents one matching
ID from masking a conflicting key belonging to a different operation. JSON
canonicalization is used before invoking Kernel equality; no separate transition
or policy implementation is substituted for `appendEvent`.

A COMMIT can succeed even if the process dies before the caller receives its
response. Retrying the original operation converges to one durable event. An
uncommitted transaction rolls back, leaving the prior head and events unchanged.
All API failures use fixed `DurableStoreError.code` values; raw Kernel/SQLite
messages, SQL, goals and payloads are never attached as error causes or logged.

For COORD-5B–5D, a single `DurableDatabase` owns transaction boundaries:

```ts
const committed = db.write(tx => {
  const provisional = store.appendInTransaction(tx, event);
  // Future migration-owned participants use tx.run/get/all on this SAME connection.
  // Return only after all participants succeeded; throwing rolls everything back.
  return provisional;
}); // COMMIT has succeeded here
```

The scoped capability rejects foreign/expired transactions, read-only writes,
nested transactions, transaction-control SQL and asynchronous callbacks. It
exposes no connection, independent COMMIT, DDL or PRAGMA control. `write` callback
results are provisional until the outer call returns; do not publish them or
perform external effects inside the callback. Participants are trusted server
code and must not swallow errors to commit partial work. No async work may
outlive the callback. Initialization/migration and backup use the same connection
owner outside participant transactions. No pending-action/ledger/outbox tables
are added speculatively in 5A.

## Checkpoint and restore

`createCheckpoint` reads the latest committed Journal under the writer lock,
fully replays it, validates the snapshot, and records its version, sequence,
digest, anchor and creation time in an independent transaction. A checkpoint
failure cannot undo a previously committed append. Generation is explicit;
applications may later choose safe-stop/terminal or 50–100-event intervals.

Restore first validates the seed/policy digests, envelope/index consistency,
contiguous sequences, unique event IDs/keys, timestamps/ownership, full Journal
anchor and stored head. It replays events **after** the saved creation event via
`appendEvent`, then applies `validateCoordinationSnapshot`.

Only after this authoritative replay are checkpoint candidates tried from newest
to oldest. Version, Workflow, position, digest, snapshot validation and anchor
must match. The candidate must also equal Kernel replay of its committed prefix;
a recomputed checkpoint digest cannot legitimize an invented task projection.
The selected checkpoint replays its suffix to the latest head, and its final
validated state must equal full replay. If all checkpoints are damaged or absent,
full replay is returned. Invalid checkpoints are skipped without deletion or
repair. Journal corruption always fails; it is never hidden by a checkpoint.

This deliberately prioritizes correctness over speed: snapshots contain full
history, validation scans it, and checkpoint verification also replays prefixes.
There is no claimed incremental-restore performance improvement. Long Journals
and many checkpoints require future retention/incremental-validation design.
SHA-256 detects accidental corruption; it is **not authentication** against an
attacker who can rewrite data and digests together. Use OS access control,
backups, and future signatures/external audit where required.

## Migrations, backups and failures

Numbered migrations live in `schema.ts`, applied in order by `migrations.ts`.
Both `PRAGMA user_version` and the exact migration ledger must agree. Unknown
future versions, missing/renamed ledger entries and unversioned nonempty schemas
fail closed. DDL, ledger insertion and user_version updates commit together;
a failed migration rolls them all back and closes the connection. Add a numbered
migration and explicit compatibility tests for future changes. Do not delete
existing Journal rows during migration, and do not rerun an applied migration.

`db.backup(absoluteNewPath)` uses SQLite `VACUUM INTO` for a consistent copy of
committed data, including WAL state. The target must be new, in a private local
directory; it is created with 0600 permissions. Do not copy just the main DB file
while WAL writes are active. A failed backup may leave an empty/incomplete target;
discard it before retrying. Test restoring backups and retain them outside the
live DB directory according to deployment policy. WAL/FULL does not eliminate
OS, disk or storage-controller failures.

Treat `INTEGRITY_ERROR`, `INVALID_SEED`, unsupported schemas and invalid events
as failures requiring investigation. Never resequence, insert a repair event,
replace the saved policy with today's policy, or start execution to compensate.
The module makes no automatic data repair and no implicit user authorization.

## Validation

```sh
npm ci
npm run test:durable
npm test
npm run typecheck
npm run build
git diff --check
```

Durable tests use actual SQLite files, new connections and child processes.
They cover full task/decision/quorum/evaluation/commitment projections,
idempotent response loss, immutable policies, SQL rollback/constraints, schema
failure, malformed data, safe errors, checkpoints and actual Browser Runner
compatibility. Children are forcibly killed after Journal INSERT before COMMIT,
after COMMIT before response, and after checkpoint INSERT before COMMIT. Separate
processes also race conflicting/idempotent appends and repeatedly restore an old
checkpoint plus later committed events. All child tests have bounded timeouts.
If a sandbox restricts IPC, grant the test subprocesses the necessary local IPC
capability; verify the output contains named cases, not just file-level passes.
Windows ACL provisioning and process/locking behavior still need native Windows
CI; Linux test success is not presented as Windows execution evidence.

## Follow-on boundaries

COORD-5B adds Pending Action, Execution Ledger, Result and Evidence persistence;
its explicit server Runner setup and safety stops are documented in
[durable execution](coordination-durable-execution.md).
COORD-5C adds leases/fencing, Recovery Manager, budget reservations and explicit
safe resumption rules. COORD-5D adds a durable notification outbox and recovery
delivery using the shared transaction owner. The current COORD-4C in-memory
outbox is **not atomic with this Journal**, and notification ID/MACP contracts
are unchanged. A durable RUNNING Workflow must **not** be automatically handed
to `runUntilStop` after restart until execution recovery is implemented.
