# Jarvis System Refinement — Design Spec

**Date:** 2026-06-10
**Status:** Approved
**Scope:** Re-baseline of the Jarvis agentic harness design: compiled project bibles, multi-project registry, GitHub integration, two-layer CI/CD verification, and the Command Deck dashboard.

---

## 1. Problem

The Phase 0 project bible is a single flat markdown file rendered through a generic template. The system's core ideas (multi-project management, GitHub connections, CI/CD verification, knowledge-graph dashboard) existed only as abstract bullet points. This spec turns them into concrete, buildable designs and establishes the bible as **living HTML documentation that agents can safely update as the system grows**.

## 2. Decisions (locked during brainstorming 2026-06-10)

| # | Decision | Choice | Rejected alternatives |
|---|----------|--------|----------------------|
| D-002 | Bible source of truth | **Compiled bible**: structured md sections + live DB data compiled into one rich HTML doc | Hand-authored HTML (agents editing big HTML files is error-prone); markdown-first status quo (flat file doesn't scale, no live data) |
| D-003 | GitHub connection | **`gh` CLI + polling**, SQLite cache, `GitHubProvider` seam | GitHub App + webhooks (needs public endpoint; heavy for personal self-host) |
| D-004 | CI/CD verification | **Two-layer**: GitHub Actions for deterministic CI; agent-team verification skill for audit/repair/judgment | Local-only agent verification (invisible on GitHub, machine must be on); agents-as-CI (slow, token cost per push) |
| D-005 | Project model | **Registry, both paths**: register existing local repo by path OR clone from GitHub URL into managed workspace | Managed-workspace-only; path-registration-only |
| D-006 | Dashboard IA | **Command Deck**: icon sidebar + ⌘K command bar + metrics row + swappable stage + activity strip; per-project workspace with 7 tabs incl. per-project knowledge graph | Mission-Control card grid (graph buried); graph-first constellation (everything else one level down) |
| D-007 | Design language | **Precision minimal**: near-black, hairline borders, single indigo accent, mono numerals, 150ms micro-interactions | Aurora glass (GPU cost, fights data density); sci-fi HUD (gimmick risk) |

(D-001, Architecture A with B-seams, predates this spec and is unchanged.)

## 3. The Compiled Bible

**Every project managed by the harness has a bible.** The harness itself is project zero and uses the identical mechanism.

### Source layout

```
<bible-dir>/
├── manifest.json        # title, project meta, ordered section list
└── sections/NN-slug.md  # one file per section, YAML frontmatter
```

- Harness bible lives at `artifacts/bible/`; registered projects use `<repo>/docs/bible/`.
- Section frontmatter: `title`, `icon`, `status: stable|active|draft`, `updated: YYYY-MM-DD`.
- Agents edit **sections**, never the compiled HTML. Small files → clean diffs → safe automated updates.

### Live data directives

Sections may embed `<!-- @live:NAME -->` comments. The compiler replaces them with HTML blocks computed from SQLite at compile time:

| Directive | Renders |
|-----------|---------|
| `@live:stats` | run counts, token totals, cost totals |
| `@live:recent-runs` | last 5 runs with status/cost |
| `@live:roadmap-progress` | progress bars computed from the roadmap section's checkboxes |
| `@live:health` | registered projects + health scores |

Unknown or failing directives render a graceful "no data yet" placeholder — the bible never fails to compile because the DB is empty.

### Compiler

`core/src/bible.ts` → `compileBible(bibleDir?)`:
1. Read manifest + sections, parse frontmatter.
2. Render markdown (existing `marked` setup), resolve live directives.
3. Emit a single **self-contained** HTML file (no external requests): sticky section nav with scroll-spy, status badges, per-section updated stamps, roadmap progress bars, decision cards, copy-to-clipboard on code blocks, `j`/`k` section navigation.
4. Upsert concatenated md into the `artifacts` table so the existing artifacts API/DocViewer keep working.
5. Triggered on core startup and via `POST /api/bible/compile`.

## 4. Project Model

```ts
Project {
  id: uuid
  name: string
  localPath: string          // where the repo lives on disk
  githubRemote?: string      // owner/repo — required for managed projects
  workspaceManaged: boolean  // true if harness cloned it into the workspace dir
  bibleDir: string           // relative path to the bible source (default docs/bible)
  healthScore?: number       // 0-100, written by verification runs
  lastVerifiedAt?: number
  createdAt: number
}
```

**Onboarding paths:** (a) register an existing folder by path; (b) give a GitHub URL — the harness runs `gh repo clone` into the managed workspace.

**Every registered project MUST have:** a GitHub remote, a bible (`docs/bible/`, scaffolded by onboarding if missing), and CI workflows (scaffolded/repaired by the verification skill). These three invariants are what the verification skill enforces.

## 5. GitHub Integration

`GitHubProvider` interface (seam, like ModelRouter): `listPRs`, `prStatus`, `ciRuns`, `createPR`, `syncIssues`. First implementation shells out to the authenticated `gh` CLI via `execa`.

- **Polling cadence:** 60s for projects with active runs/PRs, 10min idle, immediate refresh after any agent git action.
- Results cached in SQLite; changes emitted on the EventBus as `github_update` WS messages so the dashboard streams them with zero extra plumbing.
- Failure modes: offline/rate-limit → serve cache, mark staleness in UI; `gh` unauthenticated → surfaced as a core health warning.

## 6. Two-Layer Verification

**Layer 1 — deterministic CI (GitHub Actions):** lint, typecheck, tests, build on every push/PR. Free, standard, runs when the local machine is off. The verification skill authors and repairs these workflow files.

**Layer 2 — `verify-project` skill (agent team):** triggered manually from the dashboard, on schedule, or on `ci.failed` events. Team roles:

| Agent | Audits |
|-------|--------|
| CI auditor | workflows exist, pass, cover lint+test+build; repairs broken config |
| Test-coverage scout | untested critical paths; scaffolds missing tests |
| PR reviewer | open PRs get review comments |
| Doc-freshness checker | bible sections stale vs. recent commits; updates them |

Output: `VerificationReport { projectId, score 0-100, findings[], fixesApplied[], startedAt, completedAt }` persisted to SQLite and pushed to the dashboard.

**Health score** = CI status 40% + test-coverage trend 20% + bible freshness 20% + open findings 20%.

## 7. Dashboard — Command Deck

### Frame (always present)

- **Icon sidebar** (left, 52px): ⌂ Home · ▦ Projects · ◉ Fleet Graph · ▶ Runs · ✓ Tasks · ⚒ Skills · ∿ Metrics · ▤ Docs · ⚙ Settings
- **⌘K command bar** (top): natural-language dispatch to Jarvis + fuzzy navigation; scopes itself to the current project when inside a workspace
- **Stage** (center): swappable content area per destination
- **Activity strip** (bottom): live agent runs with status pulses, last completed action, pause-all

### Home stage

Metrics row (tokens today, cost today, active runs, open tasks, fleet health) → project cards sorted by needs-attention (CI state, stale bible, waiting PRs, suggested action) → fleet graph pane (projects + shared dependencies; click to enter).

### Project workspace (7 tabs)

Overview · **Knowledge Graph** · Runs · Tasks · PRs & CI · Verification · Bible

The per-project Knowledge Graph is first-class: GitNexus-sourced, WebGL force-directed (`react-force-graph`), level-of-detail toggles (modules/files/symbols/hot-paths), node inspector with live facts (failing tests, last-touched-by run) and **dispatch-agent actions** ("fix failing tests in this module").

### Design tokens (precision minimal)

| Token | Value |
|-------|-------|
| Background / surface / raised | `#0a0a0f` / `#111116` / `#16161d` |
| Hairline border | `#26262e` (1px) |
| Text / muted | `#e7e7ea` / `#8b8b93` |
| Accent (interactive only) | `#6366f1` |
| Status | green `#22c55e` · amber `#eab308` · red `#ef4444` |
| Type | Inter (UI) · JetBrains Mono (numerals, code, ids) |
| Motion | 150ms ease-out micro-interactions; 250ms stage transitions; no decorative animation |

Charts and graphs are the visual heroes; chrome stays quiet. Density over whitespace; every pixel either informs or is silent.

## 8. Re-baselined Roadmap

- **Phase 0** (current): finish Fastify gateway, dashboard skeleton, e2e pass — unchanged, plus bible compiler (this spec).
- **Phase 1**: visibility core + project registry + GitHubProvider + bible adoption per project.
- **Phase 2**: Command Deck dashboard build-out, fleet/project graphs (GitNexus), verify-project skill.
- **Phase 3+**: skills registry, model router live, eval loop, multi-device, scale-out (as before).

## 9. Out of scope for the first implementation

Dashboard Command Deck implementation, GitHubProvider implementation, registry API + onboarding skill, verify-project skill implementation, GitNexus embedding. Each follows as its own plan; this spec is their shared reference.
