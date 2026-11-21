# MAP-DATA-1 operations and recovery

This runbook applies to `MAP-DATA-1:SERVER_CONVERSATION:1`, App Schema **1**, migration `app_001_conversation_persistence`. It does not migrate COORD Schema 11 or enable MEM-1–4. The server stores originals, versions, attachments, authorizations and generation receipts. Browser storage is only read by an explicit legacy migration action.

## Prepare an account and a protected data root

Use Node.js 22.13 or newer on a single host with local storage. The validation environment uses Node 24. WAL storage on network filesystems and multiple-host writers are unsupported. Choose an absolute private directory outside the checkout, public static root, Obsidian Vault and synchronized cloud folders. Directories must have mode `0700` on POSIX. Do not put a live DB or attachment store in Git.

```bash
npm ci
npm run build
export MAP_DATA_ROOT=/absolute/protected/map-data
umask 077
mkdir -p "$MAP_DATA_ROOT"
chmod 700 "$MAP_DATA_ROOT"
read -r -s -p 'New account password: ' MAP_NEW_PASSWORD
printf '\n'
printf '%s\n' "$MAP_NEW_PASSWORD" | npm run app:admin -- account-create --username operator
unset MAP_NEW_PASSWORD
```

The CLI reads the password only from stdin; it rejects an interactive TTY instead of echoing a password. A secret-manager pipe is also suitable. Passwords must be 12–1024 UTF-8 bytes. Store the returned `actorId` and `workspaceId` as administration identifiers. Account creation has no public HTTP endpoint, default password or automatic administrator fallback.

`account-create --workspace WORKSPACE_ID` adds an account to an existing workspace. By default, the trusted host command explicitly grants each public conversation operation for that workspace. To provision a narrower reader, pass `--no-public-grants true`, then grant individual operations. Creating an account does not grant private-segment, backup or restore content permissions.

Passwords use Node's scrypt with `N=131072`, `r=8`, `p=1`, a random 16-byte salt and a 64-byte output. The cost is approximately 128 MiB per hash, with at most two concurrent hash operations per server process. Both account and network-address login buckets permit at most ten attempts in fifteen minutes, including successful attempts. There is no username or password in audit events.

## Run a synthetic local session without keys

```bash
export MAP_DEV_HTTP=1
export MAP_PROVIDER=fake
export MAP_HOST=127.0.0.1
export MAP_PORT=3001
export MAP_ORIGIN=http://127.0.0.1:3001
npm run app:serve
```

Open that exact origin, log in, create a Room and Persona, choose the `synthetic` model, and send a message. Synthetic answers are identified as such. Add a text or supported image attachment, reload, and log in from another browser to check the persisted result. A successful server receipt represents DB acceptance; the later saved-result state represents committed output. The UI distinguishes cancellation, failure and an uncertain result that requires review.

For a Vite development UI, run `npm run dev` separately and set `MAP_ORIGIN=http://127.0.0.1:3000` while retaining server port `3001`. The development proxy preserves Host. Use `127.0.0.1` consistently; `localhost` is a different configured origin.

For explicitly unavailable-provider development, set `MAP_PROVIDER=unavailable`. This mode exposes no enabled model list, preserves accepted input, and reports unavailable generation without sending a request. It never silently substitutes synthetic or another real provider. Production requires complete provider and TLS configuration.

The browser polls the authenticated generation reader every two seconds; DATA-1 does not expose SSE. Reload, reconnect and polling never start a new generation. If an acceptance response is lost, retry the same pending request. Explicit **Regenerate** creates a new run and budget, while retaining the previous successful revision until a replacement commits. After process interruption, queued/running work is diagnosed as `NEEDS_REVIEW`; dispatch intents become `OUTCOME_UNKNOWN`. Reading these records cannot reconstruct a dispatch capability.

## Real provider and TLS configuration

Real calls require an explicit operational decision and approved cost limits. No real-provider call is part of `npm test`, server startup, or the synthetic instructions above. Set the real key only in the server process environment or a protected secret injection; never place it in a Vite variable, frontend JSON, source map or persona export.

Required real-provider settings are:

| Variable                        | Meaning                                                |
| ------------------------------- | ------------------------------------------------------ |
| `MAP_PROVIDER=gemini`           | Select the Google adapter                              |
| `GEMINI_API_KEY`                | Server-only credential                                 |
| `MAP_MODELS`                    | Comma-separated allowed model IDs                      |
| `MAP_DEFAULT_MODEL`             | One model from the allowlist                           |
| `MAP_PRICING_VERSION`           | Operator-controlled pricing configuration version      |
| `MAP_INPUT_MICROS_PER_MILLION`  | Integer micro-currency units per million input tokens  |
| `MAP_OUTPUT_MICROS_PER_MILLION` | Integer micro-currency units per million output tokens |
| `MAP_ORIGIN`                    | Exact HTTPS origin, including a nonstandard port       |
| `MAP_TLS_CERT`, `MAP_TLS_KEY`   | Protected PEM paths for direct HTTPS                   |

Remove `MAP_DEV_HTTP` for production. The default bind address is loopback. LAN binding is an explicit `MAP_HOST` setting and still requires HTTPS and the exact allowed Host/Origin. Direct HTTPS validates configuration before opening the listener. Do not assume a missing key permits anonymous or synthetic operation.

Alternatively, terminate TLS at a trusted local reverse proxy with `MAP_TRUST_LOOPBACK_PROXY=1`. The server then requires a loopback bind and connection, the configured public Host, and `X-Forwarded-Proto: https`. The proxy must overwrite forwarding headers instead of trusting client-supplied values. Requests with forwarding headers are rejected when this mode is disabled. There is no wildcard CORS or forwarded-host trust.

Production cookies are opaque, `HttpOnly`, `Secure`, `SameSite=Strict`, and root-path scoped. Session IDs are hashed at rest. Sessions expire after twelve hours or thirty minutes idle. Login always issues a fresh token; password reset, account revocation and logout invalidate existing sessions. Mutations require the exact Origin plus the current session CSRF token. API responses use `Cache-Control: no-store`; session tokens are never put in URLs or logs.

If an older deployment embedded a Gemini key, arrange a key rotation, withdraw its old bundles/source maps, and invalidate CDN/service-worker/browser caches. Rotation is an operator action; this implementation does not rotate real credentials.

The separately gated smoke test is `npm run test:app-data-provider`. Before an
authorized run, build the UI and install Chromium (or set `CHROMIUM_PATH`). Inject
`GEMINI_API_KEY` securely and set all of the following explicitly:

| Variable                             | Test requirement                             |
| ------------------------------------ | -------------------------------------------- |
| `MAP_LIVE_PROVIDER_ENABLE`           | Exactly `synthetic-only-billable-test`       |
| `MAP_LIVE_MODEL`                     | Approved Gemini model ID                     |
| `MAP_LIVE_MAX_CALLS`                 | `1`                                          |
| `MAP_LIVE_MAX_COST_MICROS`           | Approved positive ceiling, at most `1000000` |
| `MAP_LIVE_INPUT_MICROS_PER_MILLION`  | Current approved input pricing               |
| `MAP_LIVE_OUTPUT_MICROS_PER_MILLION` | Current approved output pricing              |
| `MAP_LIVE_PRICING_VERSION`           | Identifier for that pricing configuration    |

The test creates a temporary account and synthetic conversation, authenticates
over loopback, sends one real provider request, verifies persisted response and
complete usage, then reloads the authenticated browser twice. It reports model,
actual HTTP count, usage and configured-price cost without printing a credential
or raw prompt. Missing configuration or browser support fails the command; it
does not count as a skipped success. Reservations limit attempted work, but a
provider's actual billing or pricing changes cannot be guaranteed by this local
ceiling. This command has not been executed for the current DATA-1 submission.

## Scope and private readers

Public means public within the authorized Room, not public across workspaces. Conversation read, generation, provider egress, editing, import/export and private reads are separate operations. Administration does not imply private access. A private read grant requires an exact Room, Persona and visibility category:

```bash
npm run app:admin -- grant --actor ACTOR_ID --workspace WORKSPACE_ID --operation READ_CONVERSATION --room ROOM_ID
npm run app:admin -- grant --actor ACTOR_ID --workspace WORKSPACE_ID --operation READ_PRIVATE_SEGMENT --room ROOM_ID --persona PERSONA_ID --visibility self_only
npm run app:admin -- revoke --actor ACTOR_ID --workspace WORKSPACE_ID --operation READ_PRIVATE_SEGMENT
npm run app:admin -- account-revoke --actor ACTOR_ID
```

The supported private categories are `self_only`, `self_and_gm`, `gm_only` and `developer_only`; grant the intended category explicitly. Wildcard Room/Persona grants cannot grant private reads. A Persona owner or UI checkbox is not authorization. Turning separation off does not change stored segment classification. Normal message DTOs contain public segments only; the explicit internal-state reader applies current private grants.

Public output uses public-approved source/configuration. Private worker summaries and memory output are not silently injected into public answers. `/memory` is stored as classified `memory_export`. See the [MEM-1 runbook](map-mem-1.md) for scoped candidate review and Vault publication.

Account revocation, password reset and grant changes use short DB transactions and can run while the HTTP process is active. These identity-management commands do not take the maintenance host lock, so emergency revocation is effective immediately. Backup, restore, resumption and orphan maintenance require exclusive host access. Ordinary message and generation readers, cache retries and attachment downloads all recheck current authority.

## Legacy localStorage migration and export

1. In the old browser, use **Migration → Export legacy rooms**. Only the known `rooms` and optional `activeRoomId` keys are read by the migration feature. Keep this export in a private location.
2. Log in to the new server, choose the JSON/source identifier, and run **Dry run**. Review counts and fixed warnings, including unknown classifications and incomplete legacy generation.
3. Start import explicitly. The batch is bound to actor, workspace, source, request and manifest digest. Repeating the same batch resumes/converges. A conflicting old ID under the same source is rejected. Different browsers need distinct stable source identifiers; matching Persona names are not merged.
4. Review reconciliation, including original text/segment digests, binary attachment digests, timestamps and ID mappings. Incomplete batches remain hidden from normal Rooms. Importing `isStreaming` or role/owner flags cannot start a model or grant authority.
5. Open the imported Rooms and attachments from a fresh browser. Keep the old browser storage until this check succeeds. The migration panel's separate explicit clear action removes only the known old keys; it never clears all browser storage.

The server legacy import envelope is limited to 16 MiB, 50 Rooms, 16 Personas per Room, 20,000 messages, 1,000 attachments and 4 MiB per legacy attachment. The browser file selector has a smaller 8 MiB limit. Depth and HTTP node-count bounds also apply; divide larger sources into deliberately identified manifests while preserving original IDs and provenance instead of increasing limits casually. Unknown internal information is quarantined; source originals and normalization mappings are retained, not promoted to public text.

Use **Export** to download bounded chunks of at most 200 authorized messages with revisions, classification/source references and an attachment manifest. Download every advertised continuation chunk. Export files are not encrypted; store them outside public folders. Export permission does not add private read permission. Attachment originals remain available only through their authenticated download routes.

## Backup and restore

Stop the application gracefully with SIGINT/SIGTERM before backup. Shutdown stops queued dispatch, aborts/collects active work for a bounded interval, and preserves unresolved calls as unknown. The process holds `.server.lock` for its lifetime. A stale lock after a crash requires an operator to confirm its recorded PID is no longer running before removing that lock; startup never guesses that an existing lock is safe to steal. Restart once to diagnose interrupted generations, then stop again if a backup reports active intents.

```bash
npm run app:admin -- backup --destination /absolute/protected/map-backup-001
npm run app:admin -- restore --source /absolute/protected/map-backup-001 --destination /absolute/protected/map-restored-001
```

Destinations must be empty, private and outside the source root. Backup uses `VACUUM INTO`, not a copy of a live DB file, then copies verified immutable attachment originals. The manifest records schema, DB and attachment digests, references, deletion state, import state and counts. Backup success has `restoreTested:false`; it is not evidence that a restore was tested.

Restore validates the snapshot and references in a separate root, writes `restore-report.json`, clears sessions, invalidates restored password verifiers, rotates cursor protection, and writes `RESTORED_DISABLED`. Generation workers and jobs do not resume automatically. Preserve the original root until the separate restore is verified.

Reset at least one active restored account before explicit resumption:

```bash
read -r -s -p 'Restored account password: ' MAP_NEW_PASSWORD
printf '\n'
printf '%s\n' "$MAP_NEW_PASSWORD" | npm run app:admin -- password-reset --root /absolute/protected/map-restored-001 --actor ACTOR_ID
unset MAP_NEW_PASSWORD
npm run app:admin -- resume --root /absolute/protected/map-restored-001
```

The host-only password-reset transaction is permitted during maintenance; normal application writes remain blocked. `resume` rechecks references/attachment digests and requires a changed active credential. Reset other accounts individually before use. Reconfigure TLS and provider secrets on the restored host, point `MAP_DATA_ROOT` at the new root, and start explicitly. Old sessions remain invalid, and old generation intents remain diagnostic records. Reverting requires stopping the new instance and explicitly choosing the preserved original root, not overwriting it.

COORD backup is a separate existing-runtime operation. Schedule the two maintenance procedures deliberately; there is no atomic snapshot across the two SQLite databases and DATA-1 does not stop an existing COORD Runtime automatically.

For interrupted attachment staging or unreferenced files, run an exclusive report first:

```bash
npm run app:admin -- attachment-check
npm run app:admin -- attachment-check --remove-orphans true
```

The second command is an explicit removal action. It preserves every referenced blob, including retained/deleted historical references. There is no automatic retention deletion. Monitor disk capacity and keep backups according to a host policy; DATA-1 does not choose retention years.

`npm run app:admin -- status` reports DB/attachment capacity, queued/unknown work and fixed warnings. Set a host threshold with `status --warning-bytes BYTES`; it does not activate deletion. Startup also logs the aggregate health report. Request logs contain fixed routes, status and duration rather than IDs, text, credentials or raw provider responses.

## Bounds and checks

Normal messages are limited to 32,768 characters, settings to 65,536, current page size to 50 by default/200 maximum, uploads to 8 MiB binary/12 MiB JSON, attachments to eight per message, Personas to sixteen per Room, and segments to sixteen per revision. SVG and HTML attachment types are rejected. External URLs are not fetched. Attachment names are display metadata; clients never choose a server path. POSIX symlink/hardlink/root traversal checks are covered; Windows Junction/Reparse Point behavior still needs target-OS verification.

Default generation caps are eight Personas, three subagents per Persona, forty calls per run, two concurrently executing runs, one hundred history messages, 16,384 input tokens per call, 2,048 output tokens per call, 131,072 total tokens, and 1,000,000 micro-currency units. Acceptance/dispatch windows are thirty seconds, run deadline 120 seconds and collection window 180 seconds. Unknown usage retains its reservation; over-budget confirmed usage is recorded without truncation and stops later calls. `historyWindow=0` uses finite host bounds. Server shutdown waits up to five seconds for active dispatch cleanup.

Context size checks are conservative resource bounds rather than an exact model
tokenizer. Before reading any attachment body, the compiler checks the aggregate
metadata against `maxInputTokens × 3` bytes, accounting for base64 images and up
to six times text bytes for JSON escaping. An upload within the storage limit can
therefore still exceed the per-call context limit. The compiled request is
checked again before dispatch; missing provider usage counters remain unknown.

After the PR #38 audit corrections, `pinFirstMessage` defaults to true and occupies
one slot within the finite history window. If that effective window has only one
slot and the pin is a different Message from the accepted input, generation fails
with `HISTORY_WINDOW_PIN_CONFLICT` before reserving or sending a call. The screen
instructs the user to increase history to at least two messages or turn off the
first-message pin. The saved input, its attachments and the settings remain intact.
The first turn (where the input is the pin) and a one-message window with pinning
off still work. A failed Request ID stays failed on replay; changing settings does
not authorize its replay as a new generation. See the [follow-up report](map-data-1-pr38-pin-followup.md).
CoT and
ReAct apply their distinct summary instructions and require structured output
even with Room separation off. Their explicit debug summaries remain private;
this does not enable tools or expose provider-hidden reasoning.

The numeric `thinkingBudget` setting now reaches Persona and fixed-worker provider
requests. The effective output cap (at most 2048, or a smaller worker/Host cap)
bounds thinking as well as final output. Larger values fail with
`THINKING_BUDGET_LIMIT`; they are not clamped silently. Declared adapter capabilities:

| Model                    | Numeric budget                                                     |
| ------------------------ | ------------------------------------------------------------------ |
| `gemini-2.5-flash`       | 0 to disable, or 128–2048 within the effective output cap          |
| `gemini-2.5-flash-lite`  | 0 to disable, or 512–2048 within the effective output cap          |
| `gemini-2.5-pro`         | 128–2048 within the effective output cap; zero is rejected         |
| Gemini 3 family          | Numeric budget rejected; no inferred thinking-level conversion     |
| Other allowlisted models | Positive budgets rejected; legacy zero means no reasoning override |

Capability support does not add a model to the Host allowlist. Unknown model
variants are not remapped. An omitted worker budget retains the provider default;
the finite output/usage/cost limits still apply. Zero on supported Flash models
is now sent explicitly, correcting the old omission of the setting. The adapter
uses the provider's native field without `includeThoughts`. These requests were
verified over synthetic loopback HTTP, not against a billable provider.

Acceptance retry may schedule a still-unstarted QUEUED run, including recovery
from an exception after acceptance COMMIT but before the HTTP scheduling step.
This is not provider retry: current authorization/deadlines are checked again,
and any persisted call on a QUEUED run requires review. Readers/polling never
schedule execution. See the [PR #38 audit report](map-data-1-pr38-audit.md).

Run `npm run test:app-data`, `npm run test:app-data-browser` and the individual import/crash/backup/redteam commands listed in `package.json`. The CLI integration test performs a real process sequence: create account → backup → separate restore → refused premature resume → password reset → resume → login/read original; it checks old-session rejection and zero Provider calls. Synthetic tests do not prove live Provider behavior, target-host restore or Windows filesystem guarantees. Use the verification report for actual results and outstanding production gates.
