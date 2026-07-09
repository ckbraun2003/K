---
title: GitHub Integration
icon: "⎇"
status: active
updated: 2026-07-09
---

All projects work **through GitHub**: agents branch, commit, and open PRs; deterministic CI gates merges; the dashboard mirrors PR and CI state. Connection mechanism: the authenticated **`gh` CLI + polling** (decision D-003) — zero extra infrastructure, works behind any network, and the seam allows webhook push later.

## GitHubProvider (the seam)

```ts
interface GitHubProvider {
  listPRs(remote: string): Promise<PullRequest[]>                 // implemented
  ciRuns(remote: string, branch?: string): Promise<CiRun[]>      // implemented — Actions runs + conclusions
  prStatus(remote: string, number: number): Promise<PrStatus>    // (planned — not yet implemented)
  createPR(remote: string, opts: CreatePrOpts): Promise<PullRequest>  // (planned — not yet implemented)
  syncIssues(remote: string): Promise<Issue[]>                   // (planned — not yet implemented; GitHub Issues ⇄ local tasks)
}
```

The first implementation (`core/src/github.ts`) shells out to `gh` via `execa`. Today it implements PR listing and CI-run reads only — `fetchGithubStatus` runs `gh pr list --json …` and `gh run list --json …`, caches both in SQLite, and broadcasts deltas. The PR-status, create-PR, and issue-sync methods above are part of the seam's contract but are **not yet implemented**. The interface is the contract; a webhook-fed implementation can replace polling without touching consumers.

## Connection points

| Harness action | gh surface |
|----------------|-----------|
| Clone on onboarding | `gh repo clone` |
| Agent opens PR after a run | `gh pr create` (from the run's worktree branch) |
| Dashboard PR panel | `gh pr list/view --json` |
| CI status on cards + workspace | `gh run list --json status,conclusion` |
| Verification trigger on CI failure | poll detects `conclusion: failure` → emits `ci.failed` |
| Tickets ⇄ GitHub Issues | `gh issue list/create/close` |
| Remote creation for path-registered repos | `gh repo create` |

## Polling and caching

- **Cadence:** a single fixed interval (`GITHUB_POLL_MS`, default 60s) polls every registered project with a remote; set `ENABLE_GITHUB_POLL=false` to disable. There is no adaptive/idle cadence today — every project is polled on the same timer. *(Future enhancement: an adaptive cadence — faster for projects with active runs or open PRs, slower for idle ones, plus immediate refresh after an agent git action.)*
- Responses are cached in SQLite; the dashboard always renders instantly from cache and shows a staleness stamp.
- Deltas (PR state change, CI conclusion change) are emitted on the EventBus as `github_update` WS messages — the dashboard streams them through the same socket as agent events, no new plumbing.

## Failure modes

| Condition | Behavior |
|-----------|----------|
| Offline / rate-limited | serve cache, mark data stale in UI; the failed poll is logged and the next fixed-interval poll retries (exponential back-off is a future enhancement) |
| `gh` not authenticated | core health warning on the dashboard; GitHub features degrade, runs still work |
| Remote deleted/renamed | project flagged `attention`; verification reports the broken invariant |

## Branch protection — requiring `k/verify` (Phase 2, D-083)

Verification is **GitHub-native**: when a run's E-04 battery runs, K publishes its result as a
commit status named **`k/verify`** onto the run's **final checkpoint sha**, which is the head of the
run's review branch (`k-review/<runId8>`). So on the PR that branch opens, `k/verify` shows up as an
ordinary **commit status on the PR head** — visible in the PR checks list and usable in **branch
protection** like any CI context. The state maps straight through: `running → pending`,
`pass → success`, `fail → failure`, `error → error`, and a **skipped** verify (no recipe) publishes
**nothing at all** — there is never a fabricated pass.

**Making `k/verify` a required check.** To require it on a repo's default branch:

```
gh api -X PUT repos/<owner>/<repo>/branches/<default>/protection \
  -H "Accept: application/vnd.github+json" \
  --input - <<'JSON'
{ "required_status_checks": { "strict": false, "contexts": ["k/verify"] },
  "enforce_admins": false, "required_pull_request_reviews": null, "restrictions": null }
JSON
```

**Require `k/verify` ONLY on recipe-configured projects.** Because a skipped verify (a project with
no operator-authored recipe) publishes **no status at all**, making `k/verify` a *required* context
on such a repo would **block every PR forever by design** — the required check can never arrive.
Require it only where a verify recipe actually exists.

**K's merge does not depend on branch protection.** K's one-click merge (`gh pr merge --merge`)
**re-checks the checks rollup server-side** before it merges — guarded on the PR being OPEN with
checks green — so a required `k/verify` context is a belt-and-suspenders convenience on the GitHub
side, not the thing K relies on. **Auto-merge defaults OFF** and never bypasses that server-side
readback.
