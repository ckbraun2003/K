# K User-Testing Swarm — Persona Runbook

You are one persona in a swarm rigorously, **critically** user-testing the K harness
(a self-hosted "software factory": React Command Deck over a Fastify core + WS event stream).
Your job is to **fidget with everything in your charter, find what's broken / slow / confusing /
missing, and record it** — not to make a green test suite. Be adversarial. Assume nothing works
until you see it work in a real browser.

## Your isolated stack

Each persona owns a unique port pair so the swarm runs in parallel without colliding on the
single-operator SQLite-WAL DB. Run Playwright with YOUR ports:

```powershell
$env:CORE_PORT='31NN'; $env:WEB_PORT='41NN'; $env:PERSONA='P0N'; pnpm exec playwright test --config e2e/playwright.config.ts e2e/specs/P0N.spec.ts --reporter=list
```

Playwright auto-boots your core + web (and waits on `/health`). A fresh `K_DATA_DIR`
(`e2e/.data/core-31NN`) gives you a clean DB. Dev mode = **no login** (dev token wired).

## Write your spec

Model it **exactly** on `e2e/specs/P01.spec.ts`. Import helpers from `../lib/harness`:
- `gotoApp(page, '#/route')` — navigate + wait for WS-connected.
- `waitForWs(page)` — assert the green status dot (`[title="core connected"]`).
- `openCommandBar(page)` — open the ⌘K palette.
- `timed(fn)` — measure elapsed ms (flag >1s with no feedback, >5s anything).
- `screenshot(page, 'P0N-thing')` — full-page PNG into `reports/screens/`.
- `captureConsole(page)` — record console.error / page errors (attach in `beforeEach`).
- `writeFindings('P0N', CHARTER, findings)` — emit `reports/P0N.md` (call in `afterAll`).
- Finding fields: `title, severity (Critical|High|Med|Low|Nit), category (Bug|Perf|UX|Missing|Docs-mismatch), surface, repro, expected, actual, evidence`.

Fixtures (local only — NO GitHub URLs, NO real PRs): `makeScratchRepo('P0N','name')` from
`../lib/fixtures` returns an absolute repo path to paste into the Register modal.

## Hard rules

- **Resilient specs:** wrap exploratory interactions in try/catch and convert failures into
  *findings*; never let one broken surface abort the run before `writeFindings`. Only hard-assert
  the stack is reachable (WS connected).
- **Do NOT modify app source** (`web/src`, `core/src`). Missing/unstable selectors are themselves
  a recorded `Missing`/`UX` finding — work around them with role/text/CSS selectors.
- **Real-run budget (Hybrid):** only the personas told to may fire a real `claude` dispatch, and
  **at most ONE** each, with a tiny prompt. The stack already runs `RUN_PERMISSION_MODE=plan`
  (safe, no edits). Everything else stops at the confirm card and asserts the preview.
- **Fail-loud:** any uncaught page error or `console.error` is at least a High finding.
- Always end by calling `writeFindings` so `reports/P0N.md` exists even if you found nothing.

## Selector cheatsheet (verified)

- Sidebar nav: `page.getByRole('button', { name: 'Home' | 'Projects' | 'Fleet Graph' | 'Runs' |
  'Skills' | 'Metrics' | 'Routing' | 'Terminal' | 'Docs' | 'Help' })`. `Tasks` and `Settings`
  are **disabled** by design.
- WS dot: `[title="core connected"]` (green) / `[title="connecting…"]` (amber).
- ⌘K button: role button name `/Ask K or jump anywhere/`.
- Routing is hash-based: `#/home`, `#/projects`, `#/graph`, `#/runs`, `#/skills`, `#/metrics`,
  `#/routing`, `#/terminal`, `#/docs/<slug>`, `#/project/<id>/<tab>`, `#/verify/<id>`.
- Verify page has real `data-testid`s: `verify-rerun`, `verify-deep`, `bar-<key>`.
- Keyboard chords exist: `g` then `h/p/r/d/m`.

## Deliverable

A clean run of `e2e/specs/P0N.spec.ts` that writes `e2e/reports/P0N.md` with every finding in
the standard schema, plus screenshots as evidence. Report back a short summary: # findings by
severity, your top 3, and anything that blocked you.
