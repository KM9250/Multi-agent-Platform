# Multi-agent-Platform

Multi-agent-Platform is an experimental implementation project for a simple but important idea:

**the future of advanced AI systems may depend less on a single super-agent, and more on structured cooperation between multiple agents with different roles.**

Instead of treating intelligence as something that must be concentrated into one model, this project explores a platform-based approach where AI agents can specialize, evaluate each other, hand off tasks, and work under human supervision.

## Motivation

My working hypothesis is that scalable and reliable AI systems will require:

- specialization instead of monolithic design
- evaluation layers instead of blind execution
- handoff and coordination instead of isolated outputs
- institutional structure and role boundaries instead of trust in a single agent

This repository is an attempt to turn that hypothesis into a working platform.

## What this repository explores

Multi-agent-Platform focuses on the implementation side of multi-agent orchestration:

- agent coordination
- task routing and handoff
- role-based execution
- human-in-the-loop control
- experimental UI / workflow for multi-agent operation

This is not intended to be a finished product yet.  
It is a prototype environment for testing how a network of AI agents can function as a practical system.

## Getting started

Requirements: Node.js 22.13+ and local, protected storage for the application DB
and attachments. DATA-1 uses server sessions and server-side provider calls.
A real Gemini key is needed only for explicitly enabled real-provider use.

```bash
npm ci
npm run build
```

Follow the [DATA-1 runbook](docs/map-data-1-runbook.md) to provision a local account,
start the authenticated server, and log in. The runbook includes an explicit
synthetic development provider, storage-only operation, and production TLS and
model/pricing configuration. Keep the data root outside the repository, static
web directory, Vault and synchronization folders.

The browser no longer loads saved rooms automatically from localStorage. Use the
explicit migration screen and [migration/backup/restore procedure](docs/map-data-1-migration.md).
Refreshing or connecting from another browser reads server-confirmed data;
reconnection never starts another generation. Ambiguous provider results remain
available for diagnosis and require an explicit decision to regenerate.

Provider credentials must be supplied to the Node process. Vite does not embed
keys. For a deployment previously built with a client-side key, rotate that key
through the provider's account controls and remove old bundles, source maps and
CDN/service-worker caches. This change does not rotate keys automatically.

- [Architecture and limits](docs/map-data-1-architecture.md)
- [Design decisions and compatibility changes](docs/map-data-1-adr.md)
- [Validation results and production gates](docs/map-data-1-validation.md)
- [PR #38 initial audit corrections and validation](docs/map-data-1-pr38-audit.md)
- [PR #38 window-one follow-up and latest validation](docs/map-data-1-pr38-pin-followup.md)

```bash
npm test
npm run typecheck
npm run build
npm run test:app-data
npm run test:app-data-redteam
npm run test:app-data-crash
npm run test:app-data-import
npm run test:app-data-backup
npm run test:app-data-browser
npm run bench:app-data
```

The browser suite uses installed Chromium (set `CHROMIUM_PATH` when necessary).
Real-provider testing is a separately gated command, `npm run test:app-data-provider`;
it is never part of ordinary tests or an automatic startup probe. DATA-1 does not
implement MEM-1–4 or publish `/memory` to an Obsidian Vault. Production readiness
requires the separately documented live-provider and target-host restore gates.

## Related repository

The design philosophy and protocol-level ideas are documented separately in:  
**[Multi-Agent-Command-Protocol](https://github.com/KM9250/Multi-Agent-Command-Protocol)**

In short:

- **Multi-Agent-Command-Protocol** = protocol / architecture / operating concept
- **Multi-agent-Platform** = implementation / experimentation / prototype platform

## Status

Work in progress.  
The goal is to build a foundation for AI systems where intelligence emerges from **coordination, structure, and controlled interaction**, not only from model size.

## Internal-state separation

DATA-1 stores canonical classified segments and immutable revisions on the server.
Normal message readers return authorized public content; the explicit internal
reader checks the current session and exact Room, Persona and visibility grants.
Room display/separation settings do not grant access or reclassify saved private
content. Public generation excludes private history, private worker reports and
private memory. `/memory` produces a classified internal memo and does not publish
to a Vault. Debug summaries are application-requested concise summaries, not
provider-hidden chain of thought.

The earlier client-side separation helpers remain covered by historical isolated
contract tests. Their localStorage persistence, prompt-based private-history
injection, streaming and replacement semantics describe that earlier client, not
the production DATA-1 app. See the [DATA-1 architecture](docs/map-data-1-architecture.md)
and [compatibility decisions](docs/map-data-1-adr.md) for the current contracts.

## SubAgent execution foundation (Phase SA-0)

Persona Agents are conversation participants. SubAgents are private task workers owned by a Persona Agent. SubAgent output never enters public Room history directly. The model-independent task boundary, provider registry, and independent run lifecycle are documented in [the SubAgent architecture](docs/subagent-architecture.md).

The earlier Phase SA-1 client injected private worker reports into its owner's
generation without saving them to Room history; isolated regression tests retain
that historical contract. DATA-1's fixed serial pipeline persists classified
worker reports and current source references. Authorized reports may feed the
next private worker, but are excluded from public-answer context. The current
session's grants also apply when explicitly reading saved private reports.

## Autonomous coordination foundation

The UI-independent coordination domain model establishes bounded WorkflowRun and CoordinationSession lifecycles, immutable policy identity, finite budgets, fail-closed risk decisions, an append-only idempotent journal, and commitment-only completion semantics. See [the autonomous coordination architecture](docs/autonomous-coordination.md).
