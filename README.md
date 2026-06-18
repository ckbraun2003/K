# K

K is a self-hosted, single-operator agentic engineering harness: one entry point for directing AI agents to do real engineering work across a fleet of projects — managing goals, contributing code through GitHub pull requests, running verification skills, and making all of it visible on a high-clarity dashboard.

## Quick start

Prerequisites: **Node 20**, **pnpm 10**, an authenticated `claude` CLI, and (optionally) an authenticated `gh` CLI for GitHub features.

```bash
pnpm install
pnpm dev        # runs core + web in parallel
```

- Core API + WS: http://localhost:3001
- Dashboard (web): http://localhost:5173

Configure the core via `core/.env` (see the Operations section of the bible).

## Documentation

The living documentation is the project bible, compiled to a self-contained page at `artifacts/project-bible.html`. It is built from the structured sources under `artifacts/bible/` and regenerates on core startup.
