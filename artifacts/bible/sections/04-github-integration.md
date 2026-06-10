---
title: GitHub Integration
icon: "⎇"
status: active
updated: 2026-06-10
---

All projects work **through GitHub**: agents branch, commit, and open PRs; deterministic CI gates merges; the dashboard mirrors PR and CI state. Connection mechanism: the authenticated **`gh` CLI + polling** (decision D-003) — zero extra infrastructure, works behind any network, and the seam allows webhook push later.

## GitHubProvider (the seam)

```ts
interface GitHubProvider {
  listPRs(remote: string): Promise<PullRequest[]>
  prStatus(remote: string, number: number): Promise<PrStatus>     // reviews + checks
  ciRuns(remote: string, branch?: string): Promise<CiRun[]>       // Actions runs + conclusions
  createPR(remote: string, opts: CreatePrOpts): Promise<PullRequest>
  syncIssues(remote: string): Promise<Issue[]>                    // GitHub Issues ⇄ local tasks
}
```

First implementation shells out to `gh` via `execa` (`gh pr list/view/create --json …`, `gh run list --json …`, `gh issue list --json …`). The interface is the contract; a webhook-fed implementation can replace polling without touching consumers.

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

- **Cadence:** 60s for projects with active runs or open PRs · 10min for idle projects · immediate refresh after any agent git action.
- Responses are cached in SQLite; the dashboard always renders instantly from cache and shows a staleness stamp.
- Deltas (PR state change, CI conclusion change) are emitted on the EventBus as `github_update` WS messages — the dashboard streams them through the same socket as agent events, no new plumbing.

## Failure modes

| Condition | Behavior |
|-----------|----------|
| Offline / rate-limited | serve cache, mark data stale in UI, back off exponentially |
| `gh` not authenticated | core health warning on the dashboard; GitHub features degrade, runs still work |
| Remote deleted/renamed | project flagged `attention`; verification reports the broken invariant |
