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

Requirements: Node.js 22.7+ and a Google Gemini API key ([Google AI Studio](https://aistudio.google.com/apikey)).

```bash
npm install
```

### Gemini API key setup

Create `.env.local` in the project root (the same directory as `package.json`) and add your Gemini API key in this format:

```env
GEMINI_API_KEY=your_actual_gemini_api_key
```

Never commit a real API key. `.env.local` is covered by the `*.local` rule in `.gitignore`.

After creating or editing `.env.local`, restart the Vite dev server so the environment variable is reloaded:

```bash
npm run dev
```

#### Windows PowerShell encoding note

On Windows, avoid creating `.env.local` with PowerShell commands such as `echo ... > .env.local` or `Out-File`: depending on the environment, they can save the file as UTF-16 LE. Vite may then fail to read `GEMINI_API_KEY`, which can cause this app error:

```txt
The API key is missing. Set GEMINI_API_KEY in .env.local and restart the dev server.
```

Use an editor that saves `.env.local` as UTF-8 no BOM, or create the file safely from PowerShell with UTF-8 no BOM:

```powershell
$apiKey = "your_actual_gemini_api_key"
$content = "GEMINI_API_KEY=$apiKey`n"
[System.IO.File]::WriteAllText(
  (Join-Path (Get-Location) ".env.local"),
  $content,
  [System.Text.UTF8Encoding]::new($false)
)
```

If needed, inspect the first bytes of `.env.local`:

```powershell
Format-Hex .env.local -Count 16
```

If the file starts with `FF FE`, it is likely UTF-16 LE and Vite may not read it correctly. A normal UTF-8 file should begin with the bytes for `GEMINI...`, for example `47 45 4D 49 4E 49 ...`.

```bash
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
