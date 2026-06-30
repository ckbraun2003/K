---
title: GitHub Integration
icon: "⎇"
status: active
updated: 2026-06-17
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
