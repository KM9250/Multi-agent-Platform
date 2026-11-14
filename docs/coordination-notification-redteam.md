# COORD-5D notification security validation

The notification boundary uses its own identity, permissions, exact-row SQL scope, persistent Claim generation, and one-use send permit. It does not acquire a Workflow Runtime Lease or call an Action, model, Runner, approval, or WorkflowResume. The implementation baseline is `c89b5cd497e1529e0ed64d3d3983be6665c4969d`; schema 11 and `COORD-5D:DURABLE_NOTIFICATION:1` retain the MACP `macp/0.1.0` wire contract.

## Evidence and threat model

[`coordination-notification-redteam.test.ts`](../test/coordination-notification-redteam.test.ts) uses the real DurableDatabase and temporary SQLite databases. Synthetic credentials are opaque objects recognized by a test-only identity verifier. The foreign subject knows all notification, delivery, workflow, and recipient identifiers but has no permission on the target. Neither those identifiers nor self-declared roles authenticate it.

Host identity, authorization, output, Registry, and Transport implementations are trusted startup dependencies. Tests deliberately make their callbacks throw, mutate inspection inputs, return hostile objects, or reenter the DB to verify failure containment. They do not model arbitrary host JavaScript or an OS/DB administrator as a sandboxed adversary. Raw SQLite connections and `DatabaseSync.prototype.exec` interception are explicit fault-injection tools, not actor capabilities. A digest detects inconsistency; it is not a secret or an authentication mechanism.

The dedicated suite's instrumented `transport.send()` counter is the external-call boundary. It proves zero transport invocations for preflight rejection; it is not an actual HTTP server. Real HTTP, receiver SQLite, authenticated history, SSE, and independent-process counters belong to the integration suites listed below. The planning-prose attack additionally runs the actual bounded planning implementation with counted synthetic providers/executors.

Snapshot comparisons enumerate every non-SQLite-internal table dynamically. Preflight denials and rejected management commands compare **all tables**, together with the send counter. Successful delivery, post-Claim denial, in-flight management, and failure collection compare **every business table**, excluding only `notification_*`; notification changes are then checked explicitly. Thus an expected Claim, Attempt, Receipt, or Audit is permitted only at the relevant boundary. Workflow Lease, Journal, grants, Invocation, Control/Hold, evidence, execution/model ledgers, and accounting remain in the business comparison.

## Dedicated suite result

Run on 2026-11-13 with Node `v24.19.0`:

```sh
npm run test:notification-redteam
```

The complete dedicated run passed **82/82 tests**, exit 0, with fail/skip/cancelled/todo all 0. This is one suite/file, not the sum of earlier partial runs. Current duration, other suite results, final code SHA, public HEAD, and execution environment are recorded in [the validation report](coordination-notification-validation.md). This count must not be added to a full `npm test` count, which already includes it.

The separate [PR37 audit suite](../test/coordination-notification-audit-pr37.test.ts)
adds 22 regressions for migrated baseline non-disclosure, exact sync target/current
authority, service-only delivery permissions, post-Claim revocation, safe minimal
OUTPUT, no-send branches, restart, and the unchanged migration011 SQL hash.
[Before/after evidence](coordination-notification-audit-correction.md) records the
two failures reproduced at the audited HEAD and their corrected behavior.

## Findings corrected during implementation

- **Mutable output inspection:** a policy callback could change the returned page to `executionAllowed: true` and inject an arbitrary summary. The Reader now returns a pristine copy after inspecting a separate copy. Tests also ensure SEND output inspection cannot rewrite the packet reaching Transport and that receipt/audit metadata is inspected, not just the packet.
- **Hostile AbortSignal:** proxies, own accessors, and a forged AbortSignal prototype could execute attacker methods or expose raw exceptions. Preflight now rejects them using descriptors, proxy detection, and the native brand getter before any materialization, Claim, or HTTP. Native listener methods are used for accepted signals.
- **Binding change after output policy:** a callback could replace `transport.send` after the initial Registry check. A final binding check prevents the replacement from receiving a packet.
- **Malformed response retry classification:** hostile thenables/receipt objects and invalid receipt fields stop with `INVALID_RESPONSE`, retain UNKNOWN, and do not cause a second automatic HTTP call or Attempt. Actual network errors remain eligible for bounded retry.
- **Uncertain 5xx receipt:** 502/503/504 can follow receiver-side persistence. They retain UNKNOWN; closing such a delivery produces `CLOSED_UNCONFIRMED`.
- **PAUSE/CLOSE during an active send:** uncertainty is derived from Attempt evidence as well as the current delivery state. PAUSE cannot erase it before CLOSE. A legitimate in-flight receipt may subsequently establish `DELIVERED`; a failed collection preserves UNKNOWN.

The first dedicated run had 59 passes and one output-mutation failure. Four subsequently added AbortSignal probes failed before the correction. Their assertions remain in the final passing suite. The binding, 5xx, and in-flight cases were identified during review and retained as regressions. No failed assertion was removed to obtain the result.

## Requirement-to-test map

`R` below means [the dedicated redteam file](../test/coordination-notification-redteam.test.ts). A quoted prefix identifies the exact test title or a parameterized family in that file. Supporting files are separately linked; coverage locations do not replace their execution results in the validation report.

| Requirement | Executable coverage and boundary |
|---|---|
| RT-D01 | R: `model and Artifact prose claiming completion or approval creates only canonical planning review, never completion or business grants`. Actual planning returns only `planning_review_required`, fixed text, zero Action/Runner PLAN/VERIFY calls, and unchanged business grants. Existing [notification projections](../test/coordination-notifications.test.ts), `suspension, raw statusReason, model prose and non-notification events generate nothing`, cover ordinary event prose. |
| RT-D02 | R: `management cannot override fixed packet` / `summary` / `endpoint`; `SEND output callback cannot change the stored packet that reaches transport`. Unknown command fields cannot inject payload or routing. |
| RT-D03 | R: `authenticated other subject knowing notification and delivery IDs cannot read or manage another recipient`. All tables and transport count remain unchanged. |
| RT-D04 | R: `old revision and request-ID collision cannot affect a new management state; idempotent return applies current OUTPUT`. [Source suite](../test/coordination-notification-source.test.ts): `SO-08: old Artifact REVIEW is rejected without changing current notification or business tables`. |
| RT-D05 | R: `unverified role/permission DTO cannot read, materialize or claim; every table and HTTP remain unchanged`; `VIEW and PLAN-like identity access does not imply PAUSE/RETRY/CLOSE permission`. Missing and self-declared credentials do not obtain dedicated permission. |
| RT-D06 | R: `management cannot override fixed notificationId` / `packet` / `receiverRealm`. [Outbox suite](../test/coordination-notification-outbox.test.ts): `DL-11: HTTP 409 stops automatic delivery without changing ID or business`. Actual MACP409 is a separate integration test. |
| RT-D07 | R: `changed … after materialization cannot redirect a fixed packet or reach HTTP`, parameterized for Realm, Subject, Audience, Endpoint, implementation digest and destination alias; `OUTPUT callback cannot replace the registered transport after its initial binding check`. |
| RT-D08 | R: `transport self-report of idempotency cannot replace Host Realm confirmation`. A transport boolean does not authorize automatic delivery. |
| RT-D09 | R: hostile management inputs, credentials, transport results and AbortSignals. Getters, toJSON, thenables, proxies, cycles, excessive depth and size are rejected without invoking attacker methods. [Transport suite](../test/coordination-macp-transport.test.ts) separately exercises packet and HTTP-client preflight. |
| RT-D10 | R: `registry callback cannot reenter a business writer even with an otherwise valid live runtime lease`; `transport callback cannot reenter a business writer or inherit another notification write scope`; post-OUTPUT transport replacement. [Source suite](../test/coordination-notification-source.test.ts) also rejects legacy Observer double wiring before append. |
| RT-D11 | R: `SQL predicate and known persisted claim DTO never confer mutation authority`; caught raw SQL tests. [DB suite](../test/coordination-notification-db.test.ts): `AU-D10/RT-D11: querying notification scope predicate cannot grant capture power and caught denial aborts the enclosing business transaction`. |
| RT-D12 | [Independent-process suite](../test/coordination-notification-process.test.ts): `DL-08/DL-09/CR-D08: SIGSTOP old worker, expire Claim, new process recovers; resumed old ACK cannot overwrite new generation`. This uses two processes, real loopback HTTP, generation checks and an unchanged post-recovery DB snapshot. |
| RT-D13 | R: `wall-clock rollback cannot mint a fresh Claim or send using the previous time anchor`; `synchronous CPU delay cannot turn an overdue receipt into an in-deadline success`. [Outbox suite](../test/coordination-notification-outbox.test.ts): `DL-21: automatic and lifetime attempts remain bounded across manual retry and restart`. Process Claim expiry/restart is separate. |
| RT-D14 | R: `disallowed endpoint form … never reaches transport`, covering protocol, userinfo, path, query and fragment; unauthenticated production binding refusal. [Transport suite](../test/coordination-macp-transport.test.ts) verifies fixed POST options, redirect refusal, bounded responses and no production fallback. |
| RT-D15 | R: `wrong task/event/status or replay flag cannot manufacture DELIVERED`; hostile transport results. Receipt count remains zero after forged responses; `DELIVERY_FAILED` retains UNKNOWN and a second cycle creates neither HTTP nor another Attempt. |
| RT-D16 | [Source suite](../test/coordination-notification-source.test.ts): `SO-11/SO-12/SO-13: PR36 Controlled contradictory result, receipt, verified dispute and source share COMMIT` includes eight unverified candidate submissions and eight renewals producing zero sources before the genuine boundary. `SO-10/SO-14: finite failed planning emits one Recovery confirmation; heartbeat and inspect emit none` repeats eight heartbeat/inspect cycles. These are bounded synthetic repetitions, not a production load/DoS certification. |
| RT-D17 | R: `inbound ACK` / `READ` / `retry_requested` / `WorkflowResumed is not a delivery-management command or business approval`. All tables and transport count remain unchanged. Receipt first-return and lost-ACK tests demonstrate accepted delivery without executing business operations. |
| RT-D18 | R: the same inbound-command rejections, authorized notification CLOSE/PAUSE and in-flight collection cases retain every business table. Notification management does not change Hold, Invocation, grants or accounting. |
| RT-D19 | R: first/cached Reader VIEW/OUTPUT withdrawal; SEND/OUTPUT revoked immediately after Claim COMMIT; management first return and lost COMMIT ACK; receipt first return/lost ACK returns only the Service acknowledgement under current OUTPUT, while detailed Reader VIEW/OUTPUT remains mandatory; full receipt/audit output inspection and pristine-copy checks. PR37 adds delivery-only SEND/COLLECT/OUTPUT withdrawal immediately after Claim. |
| RT-D20 | R: network failure then CLOSE; HTTP502/503/504 then CLOSE; in-flight PAUSE then CLOSE with either failure or a valid receipt. [Outbox suite](../test/coordination-notification-outbox.test.ts): `DL-15/DL-16: resolved never-sent source and unknown prior send have different terminal meanings`. |
| RT-D21 | R: known persisted claim DTO/SQL predicates cannot grant scope; destination alias mutation cannot duplicate or redirect a fixed Source. [Independent-process suite](../test/coordination-notification-process.test.ts) tests a single persistent stream Claim and byte-identical recovery. |
| RT-D22 | R: `copied DB opened without explicit host opt-in cannot send or recreate a source`. This verifies default-disabled copied stores. It does not claim to detect an operator deliberately enabling two independent copies with identical production bindings. |
| RT-D23 | R: caught raw notification SQL denial rolls back preceding business append/audit and an earlier generic extension-table write. [DB suite](../test/coordination-notification-db.test.ts): `SO-02/INV-D15: source audit storage failure rolls back business, source, and every table before any HTTP`; [Crash suite](../test/coordination-notification-crash.test.ts) covers actual SIGKILL boundaries. |
| RT-D24 | [Source suite](../test/coordination-notification-source.test.ts): `SO-19: source row origin and packet fields are verified against canonical records`. R additionally rejects command packet/source-routing substitutions and direct source/cursor/baseline SQL forgery. |

## Boundaries not established by this suite

The 82 dedicated tests do not by themselves establish production identity-provider integration, production recipient configuration, real HTTP/SSE behavior, Windows behavior, OS push, user readership, business approval, or receiver-side exactly-once delivery. Actual fixed-MACP and independent-process results must be read separately in [the validation report](coordination-notification-validation.md) and [crash/migration notes](coordination-notification-crash-migration.md).

A copied DB explicitly re-enabled by an operator, a reset/replaced receiver DB, or an unverified receiver namespace requires a separate deployment decision. Tests do not certify simultaneous active replicas with cloned authority. ACL/necessity changes after the final preflight can race an already-started HTTP request; subsequent sends are stopped and the receipt/UNKNOWN evidence is retained. `DELIVERED` means MACP receipt confirmation. `CLOSED_UNCONFIRMED` means no further sends are requested while past receipt remains unknown.
