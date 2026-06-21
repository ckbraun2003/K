---
title: User Guide
icon: "❔"
status: active
updated: 2026-06-21
---

A task-oriented walkthrough for a new operator. It mirrors the README quick-start and stays consistent with §06 (Dashboard) and §09 (Operations) — those sections hold the design spec and the full operations reference; this one is the *how do I actually use it* guide. Reach it any time from the **Help** entry in the sidebar (it opens this bible in **Docs**).

## Getting started — install & run

Prerequisites: **Node 20+**, **pnpm 10+**, an authenticated **`claude`** CLI (agent runs dispatch through it), and optionally an authenticated **`gh`** CLI (only needed for GitHub features).

```bash
pnpm install      # native deps build automatically
pnpm dev          # core (http://localhost:3001) + dashboard (http://localhost:5173) in parallel
```

Open **http://localhost:5173**. Core boots in a few seconds; until it's ready the dashboard's API proxy returns a brief `503 {"error":"core starting"}` — that's expected, the dashboard connects automatically once core is up. To run the services in separate terminals use `pnpm --filter @k/core dev` and `pnpm --filter @k/web dev`. Configuration is optional (sane defaults) — copy `.env.example` to `core/.env` to customize; see §09 for the full variable list.

## Registering a project

Go to **Projects** (▦ in the sidebar) and use the **Register** action. A project is either:

- a **local path** — point K at a repo already on disk, or
- a **GitHub URL** — K clones it into `workspace/` for you.

Once registered, the project appears as a card on **Home** and in the Projects list, and opens into its 7-tab **project workspace** (Overview · Knowledge Graph · Runs · Tasks · PRs & CI · Verification · Bible).

## Dashboard tour

The shell has four persistent zones: the icon **sidebar** (left), the **command bar** (top), the swappable **stage** (center), and the **activity strip** (bottom).

**Sidebar destinations:**

| Icon | Destination | What it's for |
|------|-------------|---------------|
| ⌂ | **Home** | Fleet overview — metric cards, project cards sorted by *needs attention*, the fleet graph |
| ▦ | **Projects** | Register and manage projects |
| ◉ | **Fleet Graph** | Every project as a node, sized by activity and colored by health |
| ▶ | **Runs** | Live and past agent runs, with replayable consoles |
| ⚒ | **Skills** | Author and trigger reusable skills (onboarding, verify-project, …) |
| ∿ | **Metrics** | Tokens, cost, and run trends over time |
| ⇄ | **Routing** | Model routing stats |
| ▤ | **Docs** | This bible and other compiled artifacts (the **Help** entry lands here) |

Each icon shows a tooltip on hover/focus; the active destination gets the accent pill. Keyboard `g` then a letter jumps (`g p` → Projects, `g d` → Docs).

**⌘K command bar** — one input, two behaviors ranked in a single result list:

- **Navigate** — fuzzy-jump to any project, run, or destination.
- **Dispatch** — type a goal in natural language → a **confirm card** (target project, model, estimated scope) → a supervised run.

**Activity strip** (bottom, always visible) — live runs with pulsing status dots and one-line progress, the last completed action, day totals (runs · cost · tokens), and pause-all. Click any entry to open its full run console.

## The knowledge graph

The graph is a **diagnostic surface**, not decoration. Two views:

- **Per-project graph** — the **Knowledge Graph** tab inside a project workspace.
- **Fleet Graph** — the ◉ destination: one node per project, sized by activity, colored by health score.

**Nodes & colors.** In a project graph, nodes are modules/files/symbols; color carries health — failing modules glow **red**, untested **amber**, healthy **green**. In the Fleet Graph each node is a whole project colored by its health score.

**Building / refreshing.** A fresh project has no graph until it's indexed. Use the **Build / Refresh** button on the Knowledge Graph tab — it runs GitNexus analysis; a spinner shows while building and last-built / stale / error chips report status. The graph also marks itself stale and rebuilds (debounced) after a run that touched the project.

**Node inspector & dispatch-from-node.** Click a node to open the right-panel inspector — live facts (symbol type, last-touched run, verify findings, bible links) plus **dispatch actions**. Choosing one (e.g. "fix failing tests in this module") opens a confirm card and launches a node-scoped supervised run.

## Dispatching an agent run

1. Press **⌘K** (or open the command bar from the top bar).
2. Type the goal in plain language. Inside a project workspace the dispatch is automatically scoped to that project; otherwise pick the target.
3. Review the **confirm card** — target project, model, estimated scope — then confirm.
4. The **live run console** streams the agent's events as they happen. Watch it inline, or click the run in the activity strip / **Runs** destination to open the full console. Every event is durable, so a finished run can be replayed from its log.

When a run finishes against a GitHub project, the console offers **Create PR from Run →**, which jumps to the project's PRs & CI tab.

## Running verification (health score)

From a project's **Overview** or **Verification** tab, press **Run verification**. K runs a deterministic, single-shot audit and returns a **health score** (CI, coverage, bible freshness, and findings), with a findings list by severity and a report timeline. An optional **deep** verification also fires the Layer-2 `verify-project` agent in the background; the deterministic report still returns immediately.

## Onboarding a project

Onboarding enforces the project invariants by **scaffolding** whatever is missing — a starter bible and/or a starter `.github/workflows/ci.yml`. Trigger it from the **Skills** tab (the `onboarding` workflow) or via the API. Important: scaffolded files are written into the working tree **uncommitted**, for you to review — nothing is committed or pushed on your behalf. Inspect them with `git status` / `git diff`, then commit manually if you accept them.

## Editing a project's bible

Open the project workspace's **Bible** tab. The compiled bible renders in-app; each section has an **edit** action that opens the markdown source. Save your edit, then **recompile** — the tab triggers a fresh compile and re-renders. (Under the hood: sections live as markdown under the bible directory; the compiler regenerates the self-contained HTML. Never hand-edit the compiled HTML — it's regenerated and your changes would be lost.)

## Troubleshooting

Most first-run hiccups (dashboard errors on first load, `EADDRINUSE` port conflicts, SQLite "database is locked", stale worktrees after a crash) are covered in the **README Troubleshooting** section and, in depth, in **§09 Operations**. Start there.
