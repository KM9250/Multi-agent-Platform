# COORD-5D validation

## Provenance

- Baseline main: `c89b5cd497e1529e0ed64d3d3983be6665c4969d`.
- Final code/test commit: `6bfcda5ad473f4e450b342be20d074ba56fbd759`.
- Runtime implementation commit: `a8a89b72c06c55fab6504d598793745f8b4c6b66`; follow-up code/test commits change only deadline-dependent regression test harnesses.
- Branch: `codex/coord-5d-durable-notification-outbox`.
- Schema 11 / `011_durable_notification_outbox` / `COORD-5D:DURABLE_NOTIFICATION:1`.
- MACP reference: `KM9250/Multi-Agent-Command-Protocol` at `e88937d0c8132ae7d18098a24d01ee28bffda655`, unmodified.
- The final public HEAD and PR URL are recorded in the PR description. The follow-up commit after the tested SHA contains documentation only.

The [design and operating guide](coordination-durable-notifications.md) records the complete source connection map, authority boundaries, defaults, migration/sync and backup conditions. [Redteam](coordination-notification-redteam.md) and [crash/migration](coordination-notification-crash-migration.md) give separate detailed acceptance mappings. Their subset counts must not be added to `npm test` again.

## Environment and reproduction

Executed on 2026-11-13, Linux 6.18.57 x86_64, Node 24.19.0, npm 11.9.0, Node SQLite 3.53.3; Python 3.12.14, Python SQLite 3.53.1, FastAPI 0.141.1, uvicorn 0.52.1. Dependency installation used `npm ci --cache /workspace/work/npm-cache`; package-lock and runtime dependencies were unchanged. The first plain `npm ci` failed because its default home cache was unavailable; the explicit workspace cache installation succeeded.

Local integration configuration was `MACP_REPO_PATH=/workspace/work/macp-fixed` and `MACP_PYTHON=/workspace/work/macp-venv/bin/python`. MACP ran only on loopback with a temporary private SQLite DB and a random test token. Temporary tokens, databases, WAL/SHM and process logs are not deliverables. No live provider or production receiver was used.

| Command | Files | Pass / tests | Fail / skip / cancelled / todo | Exit | Seconds |
| --- | ---: | ---: | --- | ---: | ---: |
| `npm test` | 94 | 1957 / 1957 | 0 / 0 / 0 / 0 | 0 | 340.461 |
| `npm run test:durable` | 11 | 163 / 163 | 0 / 0 / 0 / 0 | 0 | 61.908 |
| `npm run test:durable-execution` | 7 | 111 / 111 | 0 / 0 / 0 / 0 | 0 | 52.520 |
| `npm run test:recovery-reader` | 25 | 495 / 495 | 0 / 0 / 0 / 0 | 0 | 119.861 |
| `npm run test:runtime-lease` | 5 | 46 / 46 | 0 / 0 / 0 / 0 | 0 | 15.672 |
| `npm run test:model-call-ledger` | 4 | 103 / 103 | 0 / 0 / 0 / 0 | 0 | 14.002 |
| `npm run test:recovery-authorization` | 3 | 90 / 90 | 0 / 0 / 0 / 0 | 0 | 12.016 |
| `npm run test:recovery-execution` | 5 | 119 / 119 | 0 / 0 / 0 / 0 | 0 | 19.382 |
| `npm run test:recovery-dispatch` | 5 | 129 / 129 | 0 / 0 / 0 / 0 | 0 | 26.953 |
| `npm run test:recovery-continuation` | 7 | 92 / 92 | 0 / 0 / 0 / 0 | 0 | 61.013 |
| `npm run test:planning-only` | 4 | 52 / 52 | 0 / 0 / 0 / 0 | 0 | 7.393 |
| `npm run test:hold-lifecycle` | 1 | 5 / 5 | 0 / 0 / 0 / 0 | 0 | 1.805 |
| `npm run test:reconciliation` | 11 | 251 / 251 | 0 / 0 / 0 / 0 | 0 | 70.044 |
| `npm run test:reconciliation-redteam` | 3 | 135 / 135 | 0 / 0 / 0 / 0 | 0 | 24.376 |
| `npm run test:notification-outbox` | 10 | 114 / 114 | 0 / 0 / 0 / 0 | 0 | 57.059 |
| `npm run test:notification-redteam` | 1 | 82 / 82 | 0 / 0 / 0 / 0 | 0 | 10.556 |
| `npm run test:macp` | 1 | 9 / 9 | 0 / 0 / 0 / 0 | 0 | 1.781 |
| `npm run test:notification-macp` | 1 | 8 / 8 | 0 / 0 / 0 / 0 | 0 | 5.806 |
| `npm run typecheck` | — | — | — | 0 | 7.119 |
| `npm run build` | — | — | — | 0 | 3.225 |

`npm ci --cache /workspace/work/npm-cache` also exited 0. Typecheck and build are not test-file counts. Vite emitted its chunk-size advisory (627.74 kB output); build completed successfully. Node experimental-loader/type-stripping notices are expected in the existing test harness.

All commands run against the code SHA above. The ordinary runner includes the new `.test.ts` files. MACP integration is explicit and fails when its required environment is absent; it is not silently skipped. MACP's durable suite has seven child scenarios and one parent test in Node's reported total. Counts in overlapping dedicated commands are not independent additions to the ordinary regression count.

## Acceptance mapping: Source

`S` is [coordination-notification-source.test.ts](../test/coordination-notification-source.test.ts), `O` is [outbox](../test/coordination-notification-outbox.test.ts), `P` is [process](../test/coordination-notification-process.test.ts), and `R` is [redteam](../test/coordination-notification-redteam.test.ts).

| IDs | Executable evidence |
| --- | --- |
| SO-01 | S: eight `SO-01: durable ...` cases compare legacy ID/classification/fixed packets; existing notification suites remain unchanged. |
| SO-02, SO-03 | S: business/source COMMIT BEFORE/ACK, planning Source COMMIT BEFORE/ACK; DB suite source-audit failure compares all tables; actual SIGKILL cases are in the crash suite. |
| SO-04, SO-05 | S: `authorized Bounded resume creates a new occurrence, wrong-reference plan is rejected before effects`. |
| SO-06 | S: canonical plan artifact/application/FINISH/source and planning BEFORE/ACK cases; no business completion notification. |
| SO-07 | S: `needs_input commits canonical request only and later model activity cannot answer it`; packet has no question text. |
| SO-08 | S: `old Artifact REVIEW is rejected without changing current notification or business tables`. |
| SO-09 | S: revision failure, needs_input and authorized cancellation preserve the earlier unresolved review. |
| SO-10 | S: finite failed planning with repeated heartbeat/inspect; generation-fenced LEASE_LOST lifecycle source. |
| SO-11, SO-12 | S: PR36 Controlled contradictory result/receipt/dispute/source COMMIT; verified reconciliation usage with missing response; repeated unverified candidates create no source. |
| SO-13 | S: actual SafeRecovery cancel/discard/reflect scope cases and COMPLETE_SAFETY_STOP NORMAL/BEFORE/ACK; planning, bounded and Controlled cases. Existing PR35/PR36 scope/audit and process regressions are in the standard commands. |
| SO-14 | S: unchanged source heads skip replay, unrelated writes create no source; repeated heartbeat/inspect; old observer double-wiring rejected. |
| SO-15, SO-16 | S and O: missing route/identity does not discard business/Source; opening or reading sends nothing; later explicit materialization creates one delivery. |
| SO-17 | P: two independent materializers create one fixed packet and no HTTP/business mutation. |
| SO-18 | O: `uncertain failure survives connection restart and retries byte-identical packet with the original ID and Realm`; fixed packet/digest/time and MACP replay tests. Only template contract v1 is supported; a future template upgrade is not implemented or claimed tested. |
| SO-19 | S: canonical sourceRef/kind corruption rejected; R: packet/command injection and forbidden SQL. |
| SO-20 | S: verified dispute after actual terminal cancellation remains required. |

## Acceptance mapping: delivery and authorization

`D` is [DB review](../test/coordination-notification-db-review.test.ts), `C` is [crash](../test/coordination-notification-crash.test.ts), `W` is [worker](../test/coordination-notification-worker.test.ts), `Q` is [ordering](../test/coordination-notification-ordering.test.ts), `V` is [reader](../test/coordination-notification-reader.test.ts), and `M` is [fixed MACP integration](../test/integration/coordination-notification-macp.integration.ts).

| IDs | Executable evidence |
| --- | --- |
| DL-01 | O normal explicit runOnce; M actual authenticated 201, SQLite/history/SSE and unchanged business tables. |
| DL-02 | O persisted network uncertainty; M receiver commit followed by discarded response and independent MAP process replay yielding the same event. |
| DL-03, DL-04 | C claim COMMIT before/after SIGKILL; P claim ACK loss and restart, no recreation of an old send permit. |
| DL-05, DL-06 | C receipt COMMIT before/after SIGKILL; R receipt initial return and lost COMMIT ACK with current VIEW/OUTPUT, no unnecessary HTTP. |
| DL-07 | P actual process competition for one stream; D independent DB runtimes share the configured active-claim limit across workflows. |
| DL-08, DL-09 | P SIGSTOP/expiry/new worker/old ACK fencing with real loopback requests; M proves fixed receiver idempotent event identity on duplicate requests. |
| DL-10 | O restart preserves attempt/packet; P independent claim ACK-loss restart preserves counters and waits for real claim expiry. |
| DL-11 | O HTTP400/401/403/404/409/422 stop; transport retryable status tests; M real 401/409 and explicit authorized recovery. |
| DL-12 | R malformed/forged/hostile receipts stop as INVALID_RESPONSE with UNKNOWN and no second HTTP; transport response-size bounds. |
| DL-13, DL-14 | Q two canonical simultaneously required sources: prior UNROUTED/PAUSED/FAILED blocks later source, authorized CLOSE advances; O and M isolate other workflows. |
| DL-15, DL-16 | O resolved never-sent vs unknown prior send; R 502/503/504 and network uncertainty before CLOSE. D narrow collector proof can refine CLOSED to SUPPRESSED only when no previous unknown remains. |
| DL-17 | O repeated cycles after DELIVERED have one receipt/HTTP and unchanged business tables; source resolution never rewrites received history. |
| DL-18 | R deferred in-flight PAUSE/CLOSE with valid receipt or failure; SEND revocation with separate collector; D expired administratively changed SENDING attempt recovery. |
| DL-19 | R synchronous CPU delay, hostile/aborted signals and fixed monotonic deadline; actual transport late response/body/timeout cases. |
| DL-20 | R callback reentry and hostile transport values; one-shot permit/claim-ACK process tests; W concurrent runOnce joins one cycle. |
| DL-21 | O automatic and lifetime bounds through manual retry and connection restart. |
| DL-22 | W bounded concurrency, scan batch and cursor; D DB-global claim cap. Existing action/result/usage regressions still pass while sources have no queue-cap rejection. |
| DL-23 | W inert constructor, explicit start/runOnce, finite stop and no queued second claim; O DB open/reader HTTP0. |
| DL-24 | R binding/realm/recipient/alias change and packet mutation; D whole registry replacement during OUTPUT; no forwarding to another receiver. |
| AU-D01, AU-D02 | R unverified/role-only and foreign subject; V row-specific denial returns the same empty page, filters denied corrupted bodies, and exposes only authorized ordinal positions. |
| AU-D03 | R VIEW/PLAN-like permission does not grant management/claim/send; exact permission is required. |
| AU-D04 | R initial/cached reader, management and receipt ACK-loss VIEW/OUTPUT; V allowed-row OUTPUT denial still rejects with HTTP/business0. |
| AU-D05 | R revocation immediately after claim; D final Registry/OUTPUT/SEND ordering and packet checks before HTTP. |
| AU-D06 | O and R same-request replay, conflicting command and stale revision; C PAUSE/CLOSE/RETRY/SYNC COMMIT boundaries. |
| AU-D07, AU-D08 | R callbacks throwing synthetic secrets, production identity/route/auth/idempotency absence, binding/recipient changes; fixed errors and HTTP0. |
| AU-D09, AU-D10 | DB and R exact-row SQL scope, known-ID forgery, callback reentry and caught-denial full rollback; every delivery case compares business tables including leases/grants/holds/accounting. |

MI-01..08 and CR-D01..12 are mapped in [crash/migration](coordination-notification-crash-migration.md). RT-D01..24 are mapped in [redteam](coordination-notification-redteam.md). MC-D01..08 are covered by M using the unmodified fixed MACP: authenticated 201/200/401/409, immutable receiver event/task rows, authenticated history, live SSE, lost response plus independent MAP restart, same-DB MACP restart/outage, independent streams and the four new canonical kinds. The synthetic redteam transport counters are not presented as real HTTP evidence.

## Corrections discovered during implementation

- Node 24 exposes `Error.stack` as an accessor. Treating every accessor on a real DeliveryError as hostile accidentally classified real 401/409 as retryable network failure. Classification now reads only validated fixed data descriptors; real HTTP regressions pass.
- OUTPUT callbacks could mutate a returned DTO. Policy inspects a separate safe copy; the actual returned DTO remains pristine. Final registry/transport identity and SEND checks also cover callback-induced revocation or replacement.
- Hostile AbortSignal proxies/accessors/forged prototypes were rejected before effects using native branding and captured intrinsics.
- Malformed receipt values now stop as INVALID_RESPONSE; retry cannot mask them as network errors. 5xx after a started request conservatively preserves receipt uncertainty.
- PAUSE/CLOSE and expired claims now derive uncertainty from attempt history, not only the current delivery-state label. Late valid collection is separate from SEND authorization. A late proof of no send can refine a closed delivery only under strict SQL evidence checks.
- The concurrency limit was initially process-local; a claim-transaction count and expiry index now enforce it across DB connections/processes.
- Reader row-level VIEW denial initially distinguished an empty stream from a denied row. Metadata authorization now precedes protected parsing, and public cursor/position counts only authorized rows. Current ACL changes may shift pagination.
- A residual old migration test expected version 10 after all migrations. It now expects 11 while old SQL hashes/old-row checks remain intact.
- Under parallel load, an old admission-expiry fixture's 50 ms admission could expire before the intended Provider call. The test now proves admission first and waits beyond the persisted deadline within a finite 500 ms window, retaining usage-settlement/no-new-read assertions. A lease crash fixture starts its contender before acquiring the short test lease, avoiding process-startup expiry during the observation.
- A dedicated recovery-reader run exposed a second short-window fixture: a 25 ms model deadline could expire during pre-dispatch ledger validation. The boundary tests now prove entry before the persisted deadline and then deliberately cross the actual execution/collection deadline within a finite 500 ms budget. READ timeout, late evidence denial, unresolved Usage, and no-replacement assertions remain intact.
- A subsequent full run exposed the same pre-entry issue in a 200 ms Controlled start-grant fixture. The admitted-call tests now use finite 1-second start/step windows, prove real callback entry, and wait beyond the persisted grant/send/execution/collection deadline appropriate to each case. They retain late-Usage settlement or refusal, no late Evidence, no replacement call, and immutable receipt replay. A related Verification adoption fixture uses 1.5 seconds to establish its positive pre-expiry setup, then checks the actual persisted expiry. Negative-only expiry cases and the original 25 ms Controlled monotonic-timeout regressions remain unchanged.
- New crash fixtures initially used an unauthorized normal action after takeover and a claim TTL shorter than fresh child startup. They now use canonical authorized business transitions and a finite 10-second claim with bounded expiry wait. No product authorization was weakened and no assertion was removed or skipped.
- An archived preliminary baseline run lacked Git metadata for the old-runtime archive test; final tests run in the actual checkout. Preliminary failed runs are superseded by the fixed-SHA results above, not reported as successful tests.

## Performance and storage

Measured at implementation commit `a8a89b72c06c55fab6504d598793745f8b4c6b66`, exit 0. The complete `services/` tree and performance harness are byte-identical at the final code/test SHA above. All Source/Delivery counts matched; HTTP0; temporary DBs were removed. Single warm-cache run on shared five-logical-CPU cloud resources with `nice +10`.

| Sources / Deliveries | Capture cumulative (s) | Materialize cumulative (s) | Authorized reader mean / p95 (ms) | Indexed due mean / p95 (ms) | Whole DB logical bytes |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 0.718 | 1.799 | 4.923 / 8.045 | 0.148 / 0.245 | 2,596,864 |
| 1,000 | 7.256 | 14.747 | 7.289 / 12.853 | 0.433 / 0.394 | 12,800,000 |
| 10,000 | 67.333 | 279.148 | 18.856 / 39.911 | 0.286 / 0.466 | 115,359,744 |

At 10,000 sources the live DB was 115,208,192 bytes, WAL 4,297,192 bytes, and process RSS 304,635,904 bytes. The logical DB total includes the business workflows/leases/audits as well as notifications. The cancellation packet was 613 bytes; representative Source/Delivery/Attempt JSON encodings were 743/about 1,705/469 bytes. Those are JSON sizes, not SQLite allocation or a complete per-notification retention estimate.


The benchmark uses legitimate DB APIs to create one two-event workflow per source, then materializes its fixed delivery. It samples 100 authenticated single-row reads and 100 indexed due SQL diagnostics per population, and ten synthetic successful attempts per population. These 30 synthetic replies do not count as HTTP integration. The indexed SQL measurement is not end-to-end worker throughput. A single workflow with 10,000 occurrences, cold cache, disk exhaustion and production-scale retention are not benchmarked. Changed source-bearing workflow histories still require full validation; Reader authorization can scan routing metadata proportional to that workflow's source count.

There is no history purge/compaction in v1. Plan for Source/Delivery, up to 10 delivery attempts and their delivery receipts, plus source/materialization/management audits and management receipts, indexes, SQLite page overhead and WAL. Management history is not capped by the attempt limit. A consistent backup includes all notification tables and migration baselines. Receiver idempotency retention and namespace continuity remain Host requirements.

## Publication checks and remaining limits

The complete baseline-to-public diff contains 64 files. A high-confidence private-key, GitHub/Google/AWS credential and JWT scan of candidate file bytes and branch commit patches found no matches. Path/binary checks found no actual DB, WAL/SHM, key, log, environment file, archive, node_modules, work directory or generated dist artifact in the public diff. An independent broader assignment/URL-userinfo review found seven deliberate synthetic test inputs and no real secret. Relative documentation links and `git diff --check` passed.

The final code/test SHA was held fixed for the complete command run; its `services/`, `test/` and package files were checked unchanged afterward. The publication follow-up changes only the five documentation files listed below; the public HEAD and Draft PR URL are recorded in the PR description to avoid a self-referential document commit hash. Only the feature branch is published; main is not pushed and automatic merging is not enabled.

- `docs/coordination-durable-notifications.md`
- `docs/coordination-notification-validation.md`
- `docs/coordination-notification-redteam.md`
- `docs/coordination-notification-crash-migration.md`
- `docs/coordination-macp-integration.md`

Not established by local tests: production identity/provider/receiver integration, Windows, browser administration UI, OS push/sound/vibration, readership or business approval, multi-recipient fan-out, receiver DB deletion/reset, arbitrary production backup restoration, or cryptographic protection against an OS/DB administrator. Default-disabled copied databases were tested; deliberately enabling two independent copies in the same producer namespace is unsupported. The full Cartesian combination of every existing 4B/4C scope with every SIGKILL point was not exercised; actual process boundaries and scope-specific SQL/COMMIT fault injection are documented separately. Only the fixed template v1 is implemented, not a future template migration.

`DELIVERED` confirms MACP receipt. `CLOSED_UNCONFIRMED` stops retry while past receipt remains unknown. Finite retry and current authorization mean permanent receiver outage or revoked permissions can end in a preserved stopped state; unconditional eventual delivery or external exactly-once is not claimed.
