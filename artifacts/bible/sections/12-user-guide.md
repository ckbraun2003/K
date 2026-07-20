---
title: User Guide
icon: "❔"
status: active
updated: 2026-07-20
---

The mental model is **you direct an agent organization**: you talk to **K** — a genuine engineering
agent that **reads and analyzes code directly but never edits it** (every change happens in a
delegated, auditable run or pipeline) — and K delegates real work to pipelines, orchestrator leads,
or a **domain manager** (the Chief is the built-in Engineering manager) who supervises everything
running in its domain (§03). The org tiers, the K-home chat, and the
Direct/Observe IA **shipped with Phase 5** (§03, §08) — this guide covers the day-to-day basics
(dispatching runs, projects, verification, the graph) and notes where the org reshapes them.
It mirrors the README quick-start and stays consistent with §08 (Dashboard) and §11 (Operations) —
those hold the design spec and the full operations reference; this is the *how do I actually use it*
guide. This section is part of the compiled bible (reach it in-app via a project's Artifacts tab or
the Docs view); the sidebar **Help** entry now opens the **in-app multi-page guide** instead (D-116,
below), no longer this bible.

## Getting started — install & run

Prerequisites: **Node 20+**, **pnpm 10+**, an authenticated **`claude`** CLI (agent runs dispatch through it), and optionally an authenticated **`gh`** CLI (only needed for GitHub features).

```bash
pnpm install      # native deps build automatically
pnpm dev          # core (http://localhost:3001) + dashboard (http://localhost:5173) in parallel
```

Open **http://localhost:5173**. Core boots in a few seconds; until it's ready the dashboard's API proxy returns a brief `503 {"error":"core starting"}` — that's expected, the dashboard connects automatically once core is up. To run the services in separate terminals use `pnpm --filter @k/core dev` and `pnpm --filter @k/web dev`. Configuration is optional (sane defaults) — copy `.env.example` to `core/.env` to customize; see §11 for the full variable list.

## Registering a project

Go to **Projects** (▦ in the sidebar) and use the **Register** action. A project is either:

- a **local path** — point K at a repo already on disk, or
- a **GitHub URL** — K clones it into `workspace/` for you.

Once registered, the project appears as a card on **Home** and in the Projects list, and opens into its 7-tab **project workspace** (Overview · Knowledge Graph · Runs · Tasks · PRs & CI · Verification · Artifacts).

## Dashboard tour

The shell has four persistent zones: the icon **sidebar** (left), the **command bar** (top), the swappable **stage** (center), and the **activity strip** (bottom).

**Sidebar destinations (today):**

| Icon | Destination | What it's for |
|------|-------------|---------------|
| ⌂ | **Home** | Fleet overview — metric cards, project cards sorted by *needs attention*, the fleet graph |
| ▦ | **Projects** | Register and manage projects |
| ◉ | **Fleet Graph** | Every project as a node, sized by activity and colored by health |
| ▶ | **Runs** | Live and past agent runs, with replayable consoles |
| ⚒ | **Skills** | The four-tab **capability catalog** (Catalog · MCP · Hooks · Automations, see below) — host + K skills, MCP trust, and the automation registry (onboarding, verify-project, …) |
| ⋔ | **Workflows** | The delegation loop as designed + a live sub-agent tree for a chosen run |
| ∿ | **Metrics** | Tokens, cost, and run trends over time |
| ⇄ | **Routing** | Model routing stats |
| `>_` | **Terminal** | Guarded web terminal (default-off; needs `ENABLE_TERMINAL` + a `TERMINAL_TOKEN`) |
| ⚙ | **Settings** *(footer)* | Provider/auth status (no secrets) + the guarded global CLAUDE.md editor |
| ❔ | **Help** *(footer)* | Opens this bible |

Each icon shows a tooltip on hover/focus; the active destination gets the accent pill. Keyboard `g` then a letter jumps (`g p` → Projects, `g w` → Workflows, `g ,` → Settings). **Phase 5** regrouped these into **Direct** (K-home · Chief · Orchestrators · Workflows · Projects · Skills · Memory) and **Observe** (Runs · Graph · Metrics · Routing · Evals · Terminal), with K-home as the landing (§08).

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

Open the project workspace's **Artifacts** tab (formerly "Bible"). The compiled bible renders in-app; each section has an **edit** action that opens the markdown source. Save your edit, then **recompile** — the tab triggers a fresh compile and re-renders. (Under the hood: sections live as markdown under the bible directory; the compiler regenerates the self-contained HTML. Never hand-edit the compiled HTML — it's regenerated and your changes would be lost.)

The section **edit** and **Recompile** actions live **only** in this project-workspace Artifacts tab. Other in-app views of a bible (the Docs view) are **read-only** (they just render compiled artifacts), so reach for the workspace Artifacts tab when you actually want to change a section.

## Help — the in-app guide (D-116)

The sidebar **❔ Help** entry opens a **multi-page guide built into the app** — a dialog with a left
page rail and an article body, navigated with the **← / →** arrow keys or the **Prev / Next**
buttons. It ships **seven pages** and needs no backend (the content travels with the web app, so it
works offline and versions alongside the UI it documents):

1. **Welcome to K** — the you-direct-an-org mental model.
2. **Messaging K & dispatching** — the Message Dock, K-routing, and confirm-card escalation.
3. **Runs & reviewing changes** — the run console and the Changes review surface (below).
4. **Projects, bibles & artifacts** — registering projects, editing bibles, the artifact gallery.
5. **Agents & the org** — the roster, skills, and pipelines.
6. **Insights & budget** — metrics, charts, and the autonomy budget.
7. **Settings & shortcuts** — configuration and the keyboard chords.

This guide (the bible §12) and the in-app Help guide are complementary: the in-app guide is a quick,
task-oriented tour that follows the app's own navigation; this section is the fuller reference. Help
**no longer deep-links the bible** — the two are maintained separately.

## Reviewing a run's changes (the Changes tab)

When a run edits code, its console carries a **Console / Timeline / Changes** toggle. Open **Changes**
to review what the run wrote as a real diff:

- The left **file list** shows every changed file with its `+`/`−` line counts; clicking a file marks
  it **viewed ✓** (the mark persists, so you can track your way through a large review).
- The right **diff pane** renders syntax-highlighted code (the `--code-*` theme, §08).
- **Expand context** widens a checkpoint diff from 3 to 24 surrounding lines when you need more of the
  file around a change.
- You can leave **comments** on lines, then **Request changes** (bundles your comments into a fix run)
  or **Approve → PR** (publishes the run's final checkpoint as a `k-review/*` branch and opens a PR
  against the project's default branch).

## Reviewing a GitHub PR (full-screen review)

From a project's **PRs & CI** tab, each PR row has an **Open review** action that opens a
**full-screen PR review** at `#/pr-review/<project>/<n>` — the *same* file-list-plus-diff surface as a
run's Changes tab, so viewed marks and code coloring work identically. The PR view is **read-only**:
you can read the diff and mark files viewed, but comments are not posted back to GitHub (K reviews the
diff; it never writes GitHub comments). Use it to read a PR's changes without leaving the dashboard.

## Using host skills, MCP servers, and local models

K discovers what your Claude Code install already has — global skills, project skills, plugin
skills, and MCP servers — into a **capability catalog** (§04). Everything lands **disabled** until
you opt it in, and K never modifies your `~/.claude`.

1. **Browse the catalog.** Open **Skills** (the Catalog tab). Each row carries a **source badge**
   (k · global · project · plugin — the plugin badge names the plugin), a **model-compat badge**
   (universal / claude-only / mcp-dependent), and a **token chip**. The strip at the top totals
   your enabled set — `Enabled skills … MCP … Total context overhead` — as **estimates, not
   billed tokens** (chars/4, ±25%).
2. **Enable a host skill.** Preview its SKILL.md, then flip the enable toggle. That is a K-scoped
   overlay row — the file on disk is untouched, and the skill still mounts nowhere until a tier
   admits it and a profile (or the org default) grants it.
3. **Trust + enable a discovered MCP server.** On the MCP tab a host server starts untrusted.
   **Trust & enable** opens a review dialog showing the exact command, args, and env **names**
   (never values) — read it; you are authorizing code execution inside runs. If the host config
   later changes, K auto-disables the server and clears trust until you re-review.
4. **Probe its cost.** After trust+enable, **Probe** connects to the server for real (15s cap) and
   fills in its tool count and token estimate — until then the chip reads unestimated.
5. **Mount it on a lead.** Open **Orchestrators → a lead → Skills / MCP servers** (or **Settings →
   Org-default authority**) and add the capability through the picker — discovered entries show
   their badge + token chip, and anything disabled is grayed with a link back to the catalog.
   K and the Chief take no discovered capabilities (read-only by design, §03).
6. **Run on a local model.** Dispatch with an Ollama model routed/selected as usual — skills and
   MCP now work there too. The run console badge tells you what engine you got: **"local ·
   tools"** (full tool loop) or **"local · prompt-only"** (the model can't call tools, so skills
   were inlined and the run is prompt-only — it never silently switches to claude).
7. **Rescan when the host changes.** Installed a new plugin or edited `~/.claude.json`? Press
   **Rescan** on the Skills page — your enables survive; vanished assets flag `missing`.
8. **Create a skill.** From the catalog, open the **Skill Creator** (`#/skill-creator`): write a
   brief → an authoring run drafts the SKILL.md → edit or **refine** with feedback → **evaluate**
   it with the same eval harness real skills use → **save**, which lands it in K's own library
   (`agent-config/skills/`) and registers it in the catalog. Until you save, the header honestly
   reads "agent-generated draft — not saved".

## Setting up the Autonomous Org

By default the org does nothing on its own — it acts only when you talk to K or dispatch a run.
**Phase 5 (Autonomy)** lets the org generate its own work, pull it, retry its own failures, and cap
its own spend, all behind **one switch that ships OFF**. Turn it on from **Settings → Autonomous Org**:

1. **Flip the master toggle on.** Nothing autonomous runs until you do — a fresh install is inert.
   Toggling applies immediately, no restart.
2. **Pick which behaviors you want** (each needs the master on): **Generate proposals** (K's
   deterministic collectors watch CI, verification, open issues, and bible staleness and drop
   suggestions into **Personal → Inbox** as proposal cards — approve one to add it to the backlog,
   dismiss to stop it nagging), **Auto-pull backlog** (the org claims the oldest approved backlog item
   and dispatches it, up to your **max-concurrency**), and **Self-heal failed runs** (a failed
   autonomous run is retried once on a fallback model, or parked in your Inbox with a one-line
   diagnosis).
3. **Set a budget cap (recommended even with autonomy off).** The **org daily budget cap** is a
   *safety* cap on **measured** spend over a rolling 24h window — it applies to manual and autonomous
   dispatches alike, so it protects you even when the master is off. At the cap a dispatch is refused
   with a reason (not queued); raise the cap to proceed. Your own interactive chats with K are never
   budget-blocked. Per-project caps live on each project. There is **no forecasting** — only real,
   measured cost.
4. **Watch it on Insights → Charts** — a **budget burn-down** (measured, 24h) and a **retry-rate**
   chart show what the autonomy is spending and how often it is self-correcting.

Two honest limits worth knowing: a project-scoped proposal is **one-shot per project** (once it
exists in any state, a later recurrence won't re-appear until the row clears), and an Inbox **dismiss
has no undo**. Both are deliberate for this first, default-OFF cut.

## Messaging your agents (the Messages surface)

**Messages** in the sidebar (`g m`) is every conversation in one place: your K threads first, then
one ongoing conversation per durable agent — each manager and each lead. Open any conversation and
type: you can message **any** agent directly, not just K. Unread counts clear as you read a
conversation; your own sent messages never show as unread.

- **Normal vs urgent.** A normal message is delivered at the agent's **next stopping point** —
  immediately if it is idle or waiting between turns, otherwise when its current turn ends.
  **Urgent** does the same *plus* a nudge asking the agent to wrap up its current turn early — so it
  lands sooner where the CLI supports interrupts, and at the natural stopping point where it
  doesn't. Urgent never kills work in flight; if a message truly can't be delivered you get a
  notification, never silence.
- **Where results land now.** When you delegate work — or a pipeline finishes, or a manager files a
  report — the outcome arrives as a **message from that agent**: delegated outcomes come back to
  the K thread where you asked, and each agent's own conversation shows what it sent and received.
  You see who said it, not an anonymous status line.
- **K threads are managed here.** Rename, archive, and delete moved to Messages from Personal →
  Chats (old links redirect). Agent detail pages also embed that agent's conversation, so you can
  talk to a lead straight from its page.
- Each conversation shows whether the agent is **live** (a warm process, instant replies) or
  **resumable** (it wakes on your next message — same memory, a beat slower), plus its context
  meter. You never have to manage this; sessions warm up and wind down on their own.

## Domains & managers

Agents are organized into **domains**, each overseen by a **manager** (the Chief is the built-in
Engineering manager). A manager automatically supervises everything running in its domain — you
don't wire anything up, and it stays on even with the Autonomous Org master off (only budget and
rate caps govern it).

- **Create a domain** from Agents → Org → Domains: the create dialog takes the domain's name plus a
  manager name and identity, and creates both in one step — a "Research" domain with its own
  manager is a dialog, not a code change.
- **Identity overlays.** Every agent has an editable identity block (its "who am I", layered on top
  of its role charter). Edit a manager's from the Domains panel, a lead's from its detail page.
  Clearing the text silences the built-in seed identity.
- **Briefings.** A manager's conversation shows its supervision at work: when stages finish, gates
  park, runs fail, or budgets warn, the manager wakes with a **briefing** — a message headed
  **`[domain briefing · <domain> · <event>]`** summarizing what changed since it last looked,
  urgent when a gate needs a decision. The manager acts through its tools — **approve or reject the
  gate**, steer an agent, or `report` to you — and that report lands in your K conversation.
  Briefings are rate-capped per manager and fire only while the domain has active work, so silence
  means nothing is running, not that supervision is off.

## Troubleshooting

Most first-run hiccups (dashboard errors on first load, `EADDRINUSE` port conflicts, SQLite "database is locked", stale worktrees after a crash) are covered in the **README Troubleshooting** section and, in depth, in **§11 Operations**. Start there.
