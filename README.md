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

Requirements: Node.js 20+ and a Google Gemini API key ([Google AI Studio](https://aistudio.google.com/apikey)).

```bash
npm install

# Configure the API key
echo "GEMINI_API_KEY=your-api-key-here" > .env.local

# Development server (http://localhost:3000)
npm run dev

# Production build
npm run build
```

> **Note:** The API key is injected into the client bundle at build time
> (`vite.config.ts` → `define`). Anyone who can load the page can extract it,
> so do not deploy a build made this way to a public URL with a key you care
> about — use a server-side proxy for real deployments.

## Related repository

The design philosophy and protocol-level ideas are documented separately in:  
**[Multi-Agent-Command-Protocol](https://github.com/KM9250/Multi-Agent-Command-Protocol)**

In short:

- **Multi-Agent-Command-Protocol** = protocol / architecture / operating concept
- **Multi-agent-Platform** = implementation / experimentation / prototype platform

## Status

Work in progress.  
The goal is to build a foundation for AI systems where intelligence emerges from **coordination, structure, and controlled interaction**, not only from model size.
