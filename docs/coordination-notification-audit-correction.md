# PR37 audit correction: RT-01 and F-01

Audited HEAD: `2c98889c15c6825bbb0bc3ed1558af4b66fb17a1`.
Corrected code/test SHA: `e3b2a4cf070911d14707c7e064c21afc632f1679`.
Baseline main remains `c89b5cd497e1529e0ed64d3d3983be6665c4969d`.
The existing [Draft PR #37](https://github.com/KM9250/Multi-agent-Platform/pull/37)
contains this correction; its description records the final public HEAD. No main
push or automatic merge is part of this work.

## Reproduced before, verified after

The two reproducing tests ran first with all runtime files unchanged at the
audited HEAD: **0/2 passed, 2 failed**, no skip/cancel/todo. The same two tests
then passed **2/2** after the correction. The completed audit file contains
**22 tests**, included in both the ordinary runner and notification Outbox suite.
These counts overlap; they are not additional independent totals.

| Finding | Before at audited HEAD | After correction |
| --- | --- | --- |
| RT-01 | Two actual schema10 histories migrated through 011 produce empty ordinary VIEW pages with different `baseline.digest` and `journalSequence` (2 versus 4). The page-equality assertion fails. | Pages are identical and contain no baseline fingerprint or Journal position. HTTP0 and every table unchanged by reading. A materialized row denied by recipient ACL is likewise indistinguishable from an empty page. |
| F-01 | The Service has only MATERIALIZE/CLAIM/SEND/COLLECT. `materialize → read` throws `NOTIFICATION_UNAUTHORIZED`; one Delivery was created, but transport0, Attempt0, Receipt0. Every business table stays unchanged. | `runOnce` returns only the fixed cycle acknowledgement, transport1, Delivery1, Attempt1, valid Receipt1. Business tables stay unchanged. Repeated materialize/runOnce and connection reopening create no extra row or send. Service Reader/AUDIT remain denied; the authorized human sees receipt and audit. |

The reproduction uses the existing test-only synthetic transport, so its send
counter is not presented as real HTTP. Real loopback HTTP, fixed MACP, independent
restart and SIGKILL are rerun separately in the full validation commands.

The actual v10 fixture has a two-event unresolved attention Workflow and a
four-event cancelled Workflow with two historical occurrences. It checks version
10 before opening the current runtime, version 11 afterward, every historical
row/column, and distinct baseline occurrence sets. No schema version is merely
rewritten in a v11 file; no SQL guard is disabled.

## Changed authority boundaries

`NotificationPage` no longer contains `baseline`. `readSyncBaseline` provides
that unchanged Workflow-wide migration metadata only under explicit current
SYNC permission, exact Workflow/Owner/recipient/destination/Realm binding and
OUTPUT. It rechecks authority and binding after callbacks. It neither writes nor
sends, and requires no VIEW permission. The Host must treat SYNC as permission to
inspect the complete baseline; row-limited VIEW does not imply it.

`syncUnresolved` continues to require an authorized human and the expected
baseline digest. Its authorization target now explicitly includes the supplied
Owner, matching the dedicated read. The operation still returns a detailed page
and therefore still needs VIEW/OUTPUT. The regression obtains the baseline via
the new API, syncs the unresolved original ID/reference/version/digest/time,
checks `LEGACY_UNRESOLVED_SYNC`, and proves idempotent replay, no Delivery/HTTP,
unchanged business tables and unchanged migration baseline.

Delivery `materialize`/`runOnce` use `NotificationServiceResult` instead of calling
the Reader. The only fields are Workflow ID, operation, fixed
`NOTIFICATION_SERVICE_CYCLE_COMPLETE` code and `executionAllowed: false`.
The code acknowledges a bounded cycle, including no-work/no-route/stopped cases;
it does not claim a send or receipt. Returning it checks current SERVICE identity,
MATERIALIZE or CLAIM permission, and OUTPUT, without granting VIEW/AUDIT.
Packet OUTPUT, SEND, COLLECT, Claim generation, one-use permit, fixed packet/ID/
Realm and receipt recovery remain unchanged.

The existing receipt first-return/lost-COMMIT-ACK redteam cases now explicitly
separate these outputs: withdrawing VIEW permits only the Service acknowledgement
and still denies the human Reader; withdrawing OUTPUT denies both applicable
outputs. They retain the exact Receipt1, HTTP1, all-business-table and no-resend
assertions. No test is skipped and no denial is reduced to checking an error alone.

The real process Host and pinned MACP fixture also deny VIEW/AUDIT to the Service.
Their separate human inspection credentials retain those permissions. Delivery
never gains business Runtime Lease, Action/model/Runner, approval or resume
capabilities through this change.

## Added refusal and integrity evidence

The new audit file checks:

- Missing SYNC, wrong Workflow, Owner or destination, row-Owner denial, OUTPUT
  refusal, authority withdrawal during OUTPUT, and Registry mutation. Every
  table and HTTP count remain unchanged; rejected pre-authorization targets do
  not reach OUTPUT with baseline data.
- Baseline replay under current OUTPUT and mutation of the policy's inspection
  copy without changing the returned object.
- SEND, COLLECT or OUTPUT withdrawal immediately after Claim COMMIT, with HTTP0
  and every business table unchanged. Source/baseline/management receipt rows
  stay unchanged. SEND/OUTPUT refusal records `NOT_SENT_PROVEN` and PAUSED when
  collection is still authorized; COLLECT denial preserves the SENDING evidence
  without inventing a receipt. Attempt and Audit deltas are asserted explicitly.
- Service result OUTPUT refusal/mutation, no-source/no-route/disabled/aborted/
  paused branches, denied detailed Reader/AUDIT, and restart without duplicate
  sends or rows.
- Migration011 SQL SHA-256
  `a7563451450fea30fcfdc783f3bb542977d08055fd4ef9e1607e9c611b8ee0c7`.
  The existing 001–010 hash and actual old-runtime rejection tests remain intact.

## Single-Workflow performance (P3)

Both 100-Source and 300-Source populations completed their measurement and integrity assertions. Each Source is in the same Workflow; its Journal grows from 201 to 601 events. Times below are seconds.

| Sources | Requested / returned rows | Reader mean | Reader min–max | Longest read transaction | Sampled peak RSS (MiB) |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 50 / 50 | 11.935 | 11.298–12.464 | 12.450 | 367.65 |
| 100 | 200 / 100 | 22.555 | 22.398–22.674 | 22.660 | 382.90 |
| 300 | 50 / 50 | 74.245 | 68.860–77.445 | 77.429 | 426.64 |
| 300 | 200 / 200 | 265.635 | 221.644–292.161 | 292.104 | 413.01 |

| Sources at measurement | New deliveries / batches | Materialize total | Longest read transaction | Longest write transaction | Sampled peak RSS (MiB) |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 100 / 1 | 34.037 | 11.388 | 0.328 | 382.90 |
| 300 | 200 / 2 | 335.237 | 59.992 | 1.646 | 413.08 |

Creating the first 100 canonical Sources took 42.877 seconds; adding the next 200 took 375.746 seconds. These are setup costs. Materialization used one read transaction and 100 write transactions at the first population, then two read transactions and 200 write transactions at the second. The second row measures the 200 newly materialized deliveries against the 300-Source history, not all 300 from an empty Outbox.

The initial exploratory command also requested 1000. After all 300-row measurements and assertions were persisted, the supervisor deliberately stopped the process before measuring 1000 and removed its owned temporary database. This is not a completed 1000-row benchmark or a successful full-default benchmark exit. Thousand-row behavior, cold cache and production throughput remain unverified. The observed 292-second read transaction already establishes the long-Workflow concern. No digest or Journal validation was removed to obtain these results.

This exploratory measurement started in the corrected working tree before the
code commit; its runtime files are unchanged in `e3b2a4c`. The committed harness
also asserts progress after every materialization batch; the measured API calls
and provenance checks are the same. The 20 regression commands below ran after
the complete code/test commit was fixed.

The opt-in [measurement harness](../test/notification-long-workflow-performance.ts)
uses one Workflow and real authorized bounded `needs_input` applications to
create canonical atomic Sources. Providers and identities are synthetic. Each
population has three Reader samples at requested page sizes 50 and 200, then
materialization in batches of 100. Reader measurements at the later population
include the deliveries already materialized at the earlier population; the
remaining rows are UNROUTED. Setup time includes business/model simulation and
must not be described as notification worker time.

Test-only interception of `BEGIN`/`BEGIN IMMEDIATE` through COMMIT/ROLLBACK measures
read/write transaction duration. RSS is sampled at operation boundaries and
transaction completion, without forced GC; it is not an exact OS high-water mark.
The warm-cache shared-cloud run used `nice +10` and overlapped ordinary regression
work. Timings include instrumentation and a brief diagnostic pause during the
last materialization batch. No Journal, source digest or provenance validation
was disabled. Each
completed population asserts canonical Source/Delivery counts, unchanged
business-table digest and provider counters across Reader/materialize, HTTP0,
and Action/Runner PLAN/VERIFY0. All synthetic model calls belong to setup.

A preliminary measurement fixture returned a new transport object on each
Registry resolution and was correctly refused by the existing binding check.
It was stopped and excluded from the measurements. The corrected fixture retains
one registered transport object; no Registry or provenance check was relaxed.

For a bounded reproduction, choose explicit populations and a private output
path (the default also requests 1000 and can be expensive):

```sh
node --experimental-transform-types --loader ./test/ts-loader.mjs \
  test/notification-long-workflow-performance.ts /private/work/result.json 100 300
```

The next performance task is to compute the canonical projection once per
Workflow per consistent read transaction, then validate each selected Source
against that map. Materialization also needs a transaction-scoped reuse strategy
with a complete dependency/version boundary covering Journal and non-Journal
origins. Any reuse across callbacks or transactions must invalidate on relevant
changes and retain fresh per-target authorization, necessity and binding checks.
It must not cache an authorization decision or trust a stored Source digest alone.
Adversarial origin mutation and between-transaction changes must remain detectable.
This correction does not implement that optimization or certify throughput for
long histories; the measured repeated replay remains a known performance issue.

## Complete regression and remaining limits

The [consolidated validation report](coordination-notification-validation.md)
records all 20 commands, counts, durations, environment and exact tested SHA.
The ordinary tests include atomic business/Source, SQL authority, notification
single-use permits, unknown outcome, all existing redteam and 45 real
migration/crash/process tests. Explicit MACP runs cover the pinned receiver's
200/201/409 behavior, identical packet retry, ACK loss, independent MAP restart,
receiver restart, authenticated history and SSE.

Production identity/receiver integration, Windows and production-scale retention
remain unverified. A successful MACP receipt does not establish human readership
or business approval. The measured long-Workflow cost is a performance limit,
not a claim of production throughput. No new production credentials or receivers
are configured by this audit correction.
