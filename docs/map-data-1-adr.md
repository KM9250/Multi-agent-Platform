# ADR: MAP-DATA-1 server conversation persistence

Status: proposed for DATA-1 review. Contract: `MAP-DATA-1:SERVER_CONVERSATION:1`.

Audit amendment: PR #38 F-01–F-04 keeps schema 1 and the original COORD boundary.
Historical-only Persona identities use an immutable server-created JSON
discriminator in the existing identity/revision tables, without executable
configuration. Room DTOs separate these from active Persona definitions.
Acceptance retry schedules only an unstarted QUEUED run; a saved call record
cannot become send authority. Context now preserves canonical speaker envelopes,
first-message pinning, explicit framework instructions and supported native
thinking budgets. Nonstandard frameworks always use private structured debug
summaries, including when Room separation is off. This deliberately avoids
restoring the old public debug-tag format. See the
[audit report](map-data-1-pr38-audit.md) for compatibility and validation evidence.

The [window-one follow-up](map-data-1-pr38-pin-followup.md) supersedes the old
single-slot pin behavior: an effective one-slot window cannot replace the
accepted input with an earlier Message. Reject that conflict before call
reservation, retain the input/attachments and configuration, and show an actionable
setting change. Import/read/save remain valid. Other audit corrections are unchanged.

## Context and scope

The baseline is `c945bd1228af2c346791012ef3a6935bd5a82d17`. Its React application
persisted rooms, persona settings, attachments and conversations in browser
localStorage and invoked model providers from the browser. Losing browser storage
could lose the only copy, and client-side visibility controls were not a server
authorization boundary.

This change implements DATA-1. The supplied overall DATA/MEM design was reviewed
for stable source references, scope, revisions and change records. MEM-1–4,
Obsidian publication, vector search, embedding, automatic conversation summaries
and dynamic worker selection are outside this change. A saved `/memory` segment
does not represent published or approved long-term memory.

## Decisions

1. Use a thin client and a same-origin Node BFF. Browser state contains the current
   view, drafts and pending uploads; the server owns accepted data, context
   assembly and provider credentials. Login uses host-provisioned local accounts
   and revocable opaque server sessions. There is no public account bootstrap.
2. Use `app-data.sqlite`, application schema 1 and migration
   `app_001_conversation_persistence`. The existing COORD schema 11 and migrations
   001–011 remain separate. Opening a foreign database must fail before schema or
   journal changes. SQLite WAL is for a single host with local storage; it does
   not provide atomic transactions across COORD and application databases.
3. Preserve stable message/persona IDs and immutable revisions, using expected
   revisions to reject stale updates. Original timestamps and ingestion times
   have different meanings. Deletion is a current access decision, not a license
   to expose an old revision through a history or export endpoint.
4. Bind idempotency to actor, workspace, operation and input digest. Receipt
   recovery reads an existing operation. Explicit regeneration creates another
   run and budget, with a link to the previous result. Text equality alone never
   suppresses an intentional second message.
5. Persist dispatch intent before external calls. Only the live path that directly
   observes its successful commit can send once. Reading an intent, recovering an
   ACK or restarting the process cannot reconstruct that authority. An ambiguous
   outcome becomes diagnostic state and is not automatically retried. This is a
   conservative at-most-one-send policy, not a claim of exactly-once provider
   execution or of the complete COORD durability contract.
6. Maintain a call ledger for decision, fixed serial subagent, persona and memory
   calls. Unknown usage retains its reservation; rejected text is not evidence of
   zero cost. A provider adapter owns provider-specific request/usage semantics.
   The Gemini adapter uses a configured model and one HTTP attempt.
7. Compile public context only from sources authorized for its audience. Private
   source text is not included with a prompt telling the model to keep it secret.
   Private readers use explicit content grants, with current checks on initial
   results, retries, pagination, history and export. Display flags do not alter
   saved classifications. Administration does not confer private reading rights.
8. Store attachments as protected immutable files with digest metadata and scoped
   references. File persistence and SQLite commit are separate boundaries. A file
   becomes usable only after verification and metadata commit; abandoned staging
   files cannot be treated as successful uploads. Arbitrary client paths and URL
   fetching are not supported.
9. Use bounded, resumable import with source-ID mapping and digest reconciliation.
   Incomplete batches remain hidden. Legacy role, owner, approval, API-key and
   streaming fields never become authority or execution receipts. Backups use a
   consistent database snapshot plus verified attachment manifest. Restore targets
   a separate empty root, revokes sessions and leaves dispatch disabled.
10. Separate repository, authorization, session, attachment, context, generation,
    provider and operations contracts. This permits replacement of adapters
    without changing original IDs or ownership. It does not require separately
    deployed microservices.

## Alternatives not adopted

Browser IndexedDB would retain the same authority and data-loss problem.
Embedding conversation writes in COORD workflows would couple ordinary chat to
an unrelated workflow protocol. Full event sourcing is unnecessary for the
required revision history. Distributed transactions, Kafka and multi-writer
deployment are outside the initial single-host design. Prompt-only private-data
protection cannot enforce an output audience. Transparent retry after an
ambiguous send can duplicate external effects and billing.

## Compatibility and deployment consequences

Public generation no longer consumes a persona's private history or private
subagent reports. This deliberately changes the previous client prompt behavior.
An explicit future declassification/projection feature would require separate
review; no such approval workflow is claimed here. Original client-side provider
helpers remain for existing isolated regression contracts, but are not imported
by the production app entry point.

The target machine's filesystem behavior, TLS deployment and restore procedure
need deployment validation. Synthetic provider tests do not establish live
provider connectivity, pricing accuracy or production readiness. See the
validation report for observed results and unexecuted gates.
