# COORD-5D crash, process, and migration validation

The notification migration is additive Schema **11**, `011_durable_notification_outbox`, with internal contract `COORD-5D:DURABLE_NOTIFICATION:1`. Its fixed predecessor is MAP `c89b5cd497e1529e0ed64d3d3983be6665c4969d`. This document describes real temporary SQLite files and independent Node processes. The small HTTP receiver used by these process tests is a loopback test server; it is **not** counted as fixed MACP integration. See [MACP integration](coordination-macp-integration.md) and [notification validation](coordination-notification-validation.md) for the actual pinned FastAPI/SQLite/SSE suite and consolidated results.

## Atomic migration and legacy history

Migration011 creates notification tables and guards, records each existing workflow's Journal sequence/anchor and exact occurrence set/digest, then writes the migration ledger and `user_version`, all inside the constructor's `BEGIN IMMEDIATE`/`COMMIT`. It does not create pending or delivered notifications from old history. It invokes no Host Identity, transport, model, verifier, or runtime service.

`notification_migration_baselines` records what existed before v11. An authorized `syncUnresolved` transaction may subsequently capture a baseline occurrence only when the canonical current state still proves it unresolved. Such rows retain the original notification ID and occurrence time but carry `LEGACY_UNRESOLVED_SYNC`. They are **not** presented as a record saved atomically with the historical business commit, and do not recreate an old in-memory outbox's delivery history. The same sync request records its Source and management receipt atomically; replay only reads that operation. Sync does not materialize, claim, or send.

Fresh v11 business writes capture their minimal Source with the business commit regardless of delivery configuration. Their capture reason is `ATOMIC_COMMIT`. The immutable legacy baseline is never advanced by Reader, sync replay, or later business capture. Opening the DB and calling Reader do not write notification state or perform HTTP.

The populated migration fixture compares **all original columns of every pre-existing table**, rather than comparing only counts. Schema0 is genuinely empty; schemas1–10 contain the supported historical business fixture, with Seed/Journal and, where available, settled model usage, authorization/grant, and operation receipt data. Empty tables are compared too. This does not assert that every possible historical record combination was generated.

## Fixed migration SQL

`MI-01: migration001–010 generated SQL is byte-identical to fixed c89b5cd baseline` in [the migration suite](../test/coordination-notification-migration.test.ts) hashes the generated SQL strings, including dependencies imported by `schema.ts`. The expected SHA-256 values are:

| Migration | SHA-256 |
|---|---|
| 001 | `1081504f04e79db1588340ba0302991aeb42e3373b0edd9ba57810278e249566` |
| 002 | `e260ee0f529e194487c363a3f13c965846165cfc0fba7577b8e221b331698189` |
| 003 | `6586d8c14f895edf62d23612c4b4a67793a511e7c0f0eb064a944728cda7b94a` |
| 004 | `e2ef99a787649bb2bc2e0107db24513c6189e98ee73b029bca53bfa80b5ef114` |
| 005 | `a25bf6eba0319ee028c37c8b6406d96789384a54d8e052ff24c79c0eb0b787c8` |
| 006 | `a05b168f32fa5f4bbe0402d5e25918b816fa7e32368819ec714365103a779b97` |
| 007 | `1cbfc30fbe2ca6503482011f8c93e79e88683b342312496f95dce9652d04a526` |
| 008 | `e5dce90128045fea17ac4a074fd75b28208312b96f788f88e38662a64f2fb724` |
| 009 | `ce474da204af7f9b065f726847f20ab53ae8d2c5e42988a96e399df5fa5c39a4` |
| 010 | `a5240937de47521e07a4c8ac716cf8db232f05a90ef9279b53b134076b42d3a2` |

The v10 compatibility test archives and imports the **actual fixed baseline runtime** and verifies `SCHEMA_UNSUPPORTED` against a v11 file, with every table unchanged. It does not simulate old behavior by editing a schema number in current code.

## Crash evidence and limits

[The child process](../test/notification-process-child.ts) intercepts the test process's SQLite call boundary only. Before its planned `SIGKILL`, it writes a small temporary `crash-boundary.json` containing the exact operation and boundary. Parent assertions require that marker, `SIGKILL`, and `timedOut=false`. A watchdog termination, ordinary assertion failure, or unrelated process kill cannot satisfy a planned boundary. This interception and marker code lives exclusively under `test/`.

Before-COMMIT tests compare complete snapshots. After-COMMIT tests require the exact relevant Source/Attempt/Receipt/management/audit transition and compare every business table. The business+Source test explicitly permits and validates the existing `JOURNAL_APPENDED` audit emitted by the original business append; that audit is not silently excluded. Notification-only operations preserve Runtime Lease, Grant, Hold/Control, model/action ledger, and accounting rows.

HTTP tests count actual loopback requests and receiver deduplication keys. `before-http` kills after Claim commit and before the transport invokes HTTP. `after-http` kills after the receiver accepted the packet and returned its response but before MAP receipt persistence. The surviving Claim is not proof of nonreceipt. Reopening within its TTL does not restore its one-shot permit. After expiry, a different process creates a new attempt and generation; it never resumes the old attempt.

The stale-worker test uses actual `SIGSTOP`, waits for the SQLite clock to exceed the persisted Claim expiry, lets another process complete delivery, and resumes the old process using `SIGCONT`. The old return must leave **every table** identical to the new worker's committed snapshot. Receiver packet contents remain identical and its logical event count remains one.

## Crash requirement map

Paths below use `test/` relative to the repository. Names are the actual test-name prefixes; parameterized boundaries are explicit.

| ID | Suite / actual name | Executed boundaries and evidence |
|---|---|---|
| CR-D01 | `coordination-notification-crash.test.ts`: `SO-02/CR-D01: real SIGKILL business+source/...` | Ordinary Journal cancellation, before/after COMMIT; all-or-nothing business/Source/audit; Reader restart HTTP0. This is not a SIGKILL matrix over every business producer. |
| CR-D02 | Same suite: `CR-D02: real SIGKILL materialize/...` | Before/after COMMIT; zero/one fixed Delivery; restart does not send. |
| CR-D03 | Same suite: `CR-D03: real SIGKILL claim/...`; process suite: `DL-10/CR-D03: Claim COMMIT ACK loss survives independent restart...` | Before/after COMMIT; initial HTTP0; persisted Claim cannot regenerate a permit; expiry consumes a new attempt. |
| CR-D04 | Crash suite: `CR-D04/CR-D05: SIGKILL before-http...`, `...after-http...` | Before transport HTTP and after accepted response/before receipt write; SENDING retained without false receipt. |
| CR-D05 | Same HTTP crash test; pinned integration: `MC-D05/D02: receiver saves then response is lost; independent MAP process retries same packet and receiver stores once` | Loopback child kill and separate real MACP accepted-response loss/restart test. Fixed MACP code is not modified to install kill hooks. |
| CR-D06 | Crash suite: `CR-D06: real SIGKILL receipt/...` | Before/after receipt COMMIT; no partial Attempt/Receipt/Delivery/audit; committed receipt requires no further HTTP. |
| CR-D07 | `coordination-notification-process.test.ts`: `DL-07/CR-D07: two independent workers race one persistent stream Claim...` | Two processes/connections, one persisted Claim/Attempt/HTTP; Runtime Lease unchanged. |
| CR-D08 | Process suite: `DL-08/DL-09/CR-D08: SIGSTOP old worker, expire Claim, new process recovers...` | Actual suspension/expiry/takeover/resume; old collector cannot alter new generation; same packet and one receiver event. |
| CR-D09 | Crash suite: `CR-D09: real SIGKILL manage/...`, `...CLOSE/...`, `...RETRY/...`; migration suite: `MI-04/CR-D09: real SIGKILL legacy sync/...` | PAUSE, CLOSE, RETRY, SYNC before/after COMMIT; expected revision and command receipt atomic. Sync replay after kill remains one Source/receipt. |
| CR-D10 | `coordination-notification-migration.test.ts`: `MI-06/CR-D10: real SIGKILL migration011/...` | Before DDL, after DDL, after baseline insertion, before COMMIT, after COMMIT; complete v10 or complete v11 only; retry completes once. |
| CR-D11 | Migration suite: `MI-06/CR-D11: two independent migration processes...`, `...DB Busy cannot partially install schema11...` | Actual simultaneous processes; a held writer with zero busy timeout; fresh-process retry and exactly one migration ledger row. |
| CR-D12 | `coordination-notification-db.test.ts`: `SO-02/INV-D15: source audit storage failure...`, `AU-D10/RT-D11: querying notification scope predicate...`; source suite: `SO-11/SO-12/SO-13: PR36 Controlled contradictory result...` | SQL/audit failure and caught-denial rollback, plus real Controlled-result/Dispute/Source atomic path. **Partial:** no independent SIGKILL cross-product of every notification capture boundary with every 4B/4C scope. Existing 4B/4C process/crash regressions remain separate evidence. |

`SO-17: two independent Materializers create one fixed packet and no HTTP or business mutation` additionally verifies real concurrent Stage B uniqueness.

## Migration requirement map

| ID | Actual test coverage | Scope |
|---|---|---|
| MI-01 | Migration suite `MI-01: migration001–010...`; `MI-01/MI-02: populated schema0→11...` through `schema10→11...` | Generated SQL hashes and preservation of historical fixture rows/columns, foreign keys, integrity, STRICT tables. |
| MI-02 | Populated migration tests; `MI-02/MI-03/MI-04: legacy cancelled history never sends...` | No Source/Delivery/Attempt/Receipt invention at migration/open; cancelled history excluded from explicit unresolved sync. |
| MI-03 | `...explicit unresolved sync keeps original occurrence and is idempotent with HTTP0` | Current unresolved attention request, authenticated human/recipient/route/baseline; original ID/time, no HTTP or materialization. |
| MI-04 | Same idempotence test; sync COMMIT kill tests; `MI-04: two independent explicit sync requests racing a new workflow...`; `MI-04: independent legacy sync racing authorized same-workflow plan revision...` | Same command replay, ACK-loss/restart, two sync processes concurrent with new workflow or authorized same-workflow plan revision. Baseline unchanged; new atomic Source retained. |
| MI-05 | `coordination-notification-outbox.test.ts`: `SO-15/SO-16/MI-05: routing absence preserves business and Source; explicit later materialization is unique...` | Missing route does not drop Stage A; later configuration materializes once. |
| MI-06 | Migration SIGKILL, simultaneous migration, and Busy tests above | Complete migration or complete rollback; successful later retry. |
| MI-07 | `MI-07: actual fixed baseline v10 Runtime refuses schema11 without changing any row` | Unmodified c89b5cd runtime, real v11 file, all-table comparison. |
| MI-08 | `coordination-notification-redteam.test.ts`: `RT-D22: copied DB opened without explicit host opt-in...` and `RT-D07 RT-D24: changed ... after materialization...`; outbox restart test | Default-disabled copied file and changed Realm/recipient/binding refusal; ordinary reopen preserves ID/packet. **Not tested:** receiver DB deletion/reset or arbitrary production backup restoration; Host must re-establish receiver Realm/idempotency continuity. |

A normal writer after legacy lease takeover is correctly rejected by the pre-existing recovery Hold. That rejection was encountered during test development and was not bypassed. Concurrency is covered both with a new workflow and with a canonical **same-workflow authorized plan revision**: a legacy review-waiting PlanArtifact is migrated, `requestRevision`/`startAuthorized` publishes its successor while two explicit sync processes race. Depending on serialization, the original still-unresolved review is captured once or is already superseded and not captured; the new Artifact's atomic Source always exists exactly once. The old baseline is unchanged, there is one sync management receipt, no Delivery/HTTP, and exactly one authorized draft model call with zero Action/PLAN/VERIFY calls. Sync neither grants nor consumes the business authority used for that revision.

## Reproduction and recorded result

```sh
node --experimental-transform-types --loader ./test/ts-loader.mjs --test --test-concurrency=1 \
  test/coordination-notification-migration.test.ts \
  test/coordination-notification-crash.test.ts \
  test/coordination-notification-process.test.ts
```

The three suites contain **45 tests**: 25 migration, 16 crash, and 4 process tests. All passed in the final fixed-SHA ordinary `npm test` and `test:notification-outbox` runs, with fail/skip/cancelled/todo all 0 and exit 0. Their counts must not be added again to those enclosing totals. The consolidated validation document records the final tested code SHA, public HEAD location, environment, and complete enclosing-suite results. Earlier targeted development runs (44 tests, then the additional same-workflow case) are superseded by those complete results.

Development corrections were limited to the test harness: preserving the legitimate business Journal audit delta; registering the existing migration010 pure digest function in the offline historical fixture; replacing an unauthorized normal-write concurrency scenario with the authorized new-workflow scenario described above; and configuring a 10-second Claim TTL so a freshly loading child can inspect a still-current Claim under concurrent full-suite CPU load. The original 1.5-second fixture Claim legitimately expired before a fresh child loaded in one run, so its new HTTP attempt correctly violated that test's within-TTL assumption. The assertion remains intact, expiry tests still wait for the real database clock, and their wait is bounded at 15 seconds. No assertion was disabled or converted to a skip. Tests use temporary private SQLite files, local synthetic credentials, and test-only logs/markers; none is a product artifact or a committed DB/key/log.
