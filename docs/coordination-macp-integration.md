# MAP–MACP notification integration (COORD-4C)

The MAP HTTP adapter runs in a trusted Node process. The Vite application does
not send authenticated MACP notifications. The operator supplies the destination
and token; neither a model nor external content chooses them.

## Node wiring

```ts
import { MacpHttpNotificationTransport } from '../services/coordination/notifications/macpTransport';
import {
  InMemoryNotificationOutbox, createCoordinationNotificationObserver,
  createNotifyingCoordinationStore, reconcileCoordinationNotifications,
  deliverPendingCoordinationNotifications, createCoordinationRunner,
} from '../services/coordination';

const outbox = new InMemoryNotificationOutbox();
const observer = createCoordinationNotificationObserver(outbox);
const store = createNotifyingCoordinationStore(baseStore, observer);
const runner = createCoordinationRunner({ ...dependencies, store });
const transport = new MacpHttpNotificationTransport({
  endpoint: process.env.MACP_NOTIFY_URL!, // trusted server deployment configuration
  token: process.env.MACP_TOKEN,         // server environment only
  idempotencyConfirmed: true,            // verify COORD-4B on this destination first
  // allowDevelopmentLoopback: true,     // only for explicit local development
});

// Explicit recovery, then independent notification delivery:
await reconcileCoordinationNotifications(store, workflowRunId, observer);
await deliverPendingCoordinationNotifications(outbox, transport, store);
```

Keep a single outbox/store for the runtime. Delivery never invokes the Runner.
It reads current committed snapshots before sends and rechecks after backoff.
WorkflowResumed with a wrong/missing approval or review reference is not proof
of resolution. The notification remains pending/deferred until Runner re-blocks
or the Journal establishes a valid resolution. A matching resume ends that
notification occurrence; a subsequent block with the same logical reference
gets a new notification ID. Completed/cancelled notifications are historical
facts and are delivered normally. Suppressed and delivered history is immutable.

This remains an ephemeral outbox: a process restart can replay Journal history
but does not restore delivery bookkeeping. Stable producer event IDs let MACP
recognize identical retries; durable state and distributed exclusion are COORD-5
work. Cross-system resume-versus-HTTP races are not atomic. No Kernel lock is held
while sending. A delivered notification is not proof of user approval.

## Reproduce real-server integration

Prerequisites: Node >=22.7, Python 3.10+, MAP npm dependencies, and an unmodified
MACP checkout with COORD-4B merged. The reference tested commit is
`e88937d0c8132ae7d18098a24d01ee28bffda655` (MACP main PR #5).

```sh
git clone https://github.com/KM9250/Multi-Agent-Command-Protocol.git ../macp
# Pin the reference contract for reproducible verification:
git -C ../macp checkout e88937d0c8132ae7d18098a24d01ee28bffda655
python3 -m venv ../macp-test-venv
../macp-test-venv/bin/python -m pip install -r ../macp/requirements.txt
npm ci
MACP_REPO_PATH=../macp MACP_PYTHON="$(pwd)/../macp-test-venv/bin/python" npm run test:macp
npm test
npm run typecheck
npm run build
git diff --check
```

Use an absolute `MACP_PYTHON` path when selecting a custom interpreter; it is
launched with a temporary working directory. The example
above expands the path before launch. The system default is `python3`.
The integration command intentionally fails if MACP_REPO_PATH is absent; it is
separate from `npm test`, so CI without the second repository can run unit tests
without claiming integration success.

The test launches the actual upstream FastAPI app on an ephemeral loopback port.
It creates a temporary SQLite DB, disables JSONL, generates a temporary token
passed only in the child environment, consumes upstream logs without displaying
them, and stops the server/removes temporary files in a finally block. No
MACP source is copied into MAP and no real LLM or external action is used.

Scenarios verified:

- A: committed completion → POST → SQLite row → `/api/tasks` and task detail → live SSE.
- B: actual Runner approval stop → safe review packet → Workflow remains BLOCKED.
- C: duplicate POST → same event ID, unchanged SQLite count, no duplicate live SSE.
- D: server persists then response is discarded → identical retry → one event and DELIVERED.
- E: stop the actual server → bounded failure → unchanged Workflow and executor counts.
- F: actual security hold → no attack text/reviewRef in MACP → BLOCKED remains.
- G: independent workflows isolate failed/successful deliveries.
- Real 401 and 409 responses remain permanent failures without extra SQLite events.

Unit tests additionally cover all six suppression kinds, valid/invalid review
references, repeated logical cases, terminal facts, retry/ack state guards,
snapshot errors, concurrency, fixed packets, 429/5xx/permanent failures,
response validation, timeout, cancellation, backoff and browser/config rejection.
