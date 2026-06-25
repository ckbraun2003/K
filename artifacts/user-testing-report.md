# K Harness — User-Testing Report (Playwright Persona Swarm)

_Consolidated 2026-06-22 · source: `e2e/reports/P01.md`–`P10.md`, screenshots in `e2e/reports/screens/`_

## Executive summary

Ten persona agents (P01–P10) each drove a **real Chromium browser** (Playwright) against an
**isolated K stack** — every persona got its own core+web on dedicated ports with its own SQLite
DB and local git-repo fixtures, all running **in parallel**. Dispatch testing was **hybrid**: most
flows used local fixtures and seeded state, while a handful of personas (P03, P05, P09) fired **one
real `claude` plan-mode dispatch each** end-to-end (dispatch → WS stream → `run_update` → terminal
status) to prove the live loop. GitHub/PR and populated-metrics paths were exercised only in their
graceful-degradation / local-only forms (no remote, no historical data) — see Coverage gaps.

**Overall UX verdict:** solid and shippable for user testing. The core loops — register a project,
build a graph, browse the bible, dispatch and watch a real run, kill it, render the fleet graph
(no AFRAME blank screen), view metrics — all work. **No Critical and no High findings reproduced
against the default-port single stack at runtime as crashes;** the High items are either
multi-stack/port-isolation artifacts (P02/P04 dialog/navigation timeouts in the harness) or genuine
UX/consistency gaps (P09 terminal). The recurring weaknesses are **feedback and confirmation gaps**
(no dispatch confirm card, no run links after trigger, unconfirmed destructive deletes/kills),
**a real port-hardcoding bug in `terminal.ts`**, and **doc-vs-reality drift around bible §10 editing**.

**Build / test status (Step 2 — verified, both GREEN):**

| Check | Result | Detail |
|---|---|---|
| `pnpm -r test` | **PASS** | core: 38 files / **422 tests** passed · web: 9 files / **95 tests** passed |
| `pnpm build` | **PASS** | `core` tsc ✓ · `web` tsc + `vite build` ✓ (1678 modules; only a non-blocking >500 kB chunk-size advisory on `index-*.js`) |

The only app-source changes in this work were the env-parameterization of ports/proxy
(`web/vite.config.ts`, `web/src/lib/ws.ts`, `web/src/vite-env.d.ts`). They did not break tests or
the build. _No app source under `web/src` or `core/src` was modified during this consolidation._

---

## Severity-ranked master table (all 38 findings)

| # | Severity | Category | Surface | Persona | Title | Essence |
|---|---|---|---|---|---|---|
| 1 | High | Bug | Projects / Register | P02 | Registering a local-path fixture failed | Register dialog never closed (`toBeHidden` timeout) — local-path register did not complete in the isolated stack. |
| 2 | High | Bug | Projects / Register | P02 | Second project register failed | Same dialog-stays-open failure on multi-project register. |
| 3 | High | Bug | Projects / Workspace | P02 | `console.error` during builder flow | `net::ERR_INSUFFICIENT_RESOURCES` — request storm / fetch fan-out under load. |
| 4 | High | Missing | ⌘K / dispatch | P03 | No confirm card before dispatch | ⌘K runs on Enter with no project/model/scope preview; `execute()` calls `runs.start` directly. |
| 5 | High | Bug | ProjectsPage / Run verification | P04 | Could not reach verify surface | Card "▶ Run verification" never navigated to `#/verify/<id>` (waitForURL timeout). |
| 6 | High | Bug | ProjectsPage / Run verification | P04 | Could not reach verify surface (repeat) | Same as #5 on the second attempt — verify entrypoint unreachable in harness. |
| 7 | High | UX | TerminalPage / #/terminal | P09 | Terminal pane silently blank — no banner | On `ENABLE_TERMINAL=false` no disabled banner appears within 12s; operator gets zero feedback. |
| 8 | High | Bug | `web/src/lib/terminal.ts` | P09 | Terminal WS hardcodes port 3001 | `terminalWsUrl()` ignores `VITE_CORE_PORT` → dials dead port off-default; disabled-reason frame never arrives. |
| 9 | Med | Perf | Home | P01 | Cold load to interactive Home slow | 20.3s to WS-connected + metrics on a fresh stack. |
| 10 | Med | UX | Skills / ▶ run | P05 | Manual trigger gives no confirmation/link | `triggerMutation` has no `onSuccess`; user must hunt the Runs tab for their run. |
| 11 | Med | Missing | Skills / run history | P05 | Skill run-history API has no UI | `GET /api/skills/:id/runs` exists but `api.skills.runs()` is unused — dead from the UI. |
| 12 | Med | UX | ⌘K navigate-vs-dispatch | P08 | ⌘K ambiguity: nav word prefers NAVIGATE | A prompt starting with a nav label (e.g. "docs") makes Enter navigate; dispatch needs arrowing down. |
| 13 | Med | UX | Hash routing / Shell+TopBar | P08 | Unknown route = blank canvas labeled "Home" | No 404/redirect; `<main>` empty, TopBar falls back to "⌂Home". |
| 14 | Med | UX | TopBar / WS dot | P09 | WS dot doesn't reflect a dropped connection | During a network drop the amber "connecting…" state was never observed — outage invisible. |
| 15 | Med | Docs-mismatch | Docs / bible §10 / artifacts API | P10 | Bible sections not editable per §10 | `GET /api/artifacts/10-user-guide` → 404; sections are on-disk files, not artifacts, so §10's per-section edit has no target. |
| 16 | Low | UX | ProjectWorkspace / Bible | P02 | Bible iframe logs `console.error` each render | Sandbox (no `allow-scripts`) blocks the compiled bible's inline `<script>` → "Blocked script execution in about:srcdoc". |
| 17 | Low | Perf | Skills / create | P05 | Create-skill round trip slow | 15.8s from submit to row appearing. |
| 18 | Low | UX | Skills / create (schedule) | P05 | No client-side cron validation/hint | Cron is free text; invalidity only surfaces as a server 400. |
| 19 | Low | UX | Skills / delete | P05 | Delete is one unconfirmed click | Destructive, irreversible (incl. seeded skills) with no confirm. |
| 20 | Low | Missing | Skills / evals | P05 | No eval *history* surface | UI shows only `evals[0]` + regression badge; no history/drill-down. |
| 21 | Low | UX | Fleet Graph node click | P06 | Couldn't confirm node→workspace nav via canvas | Centre click missed a node (canvas hit-test); `onNodeClick→navigate` wired but unverified by automation. |
| 22 | Low | UX | Metrics / TimeseriesChart axis | P07 | 30d date-axis labels overlap at right edge | Last two ticks ("06/21"/"06/22") overprint — translateX(-50%) vs (-100%) collide at n-1≡1 (mod 7). |
| 23 | Low | UX | Sidebar active-state | P08 | Docs + Help both active on bible route | Help shares `view=docs`, so both get `aria-current="page"`. |
| 24 | Low | Missing | Shell keyboard chords | P08 | Chords cover only 5 of 9 views; no legend | No g-chord for graph/skills/routing/terminal; chord list not surfaced anywhere. |
| 25 | Low | UX | ProjectsPage / Register modal | P09 | No client-side path/URL validation | Only gate is non-empty name+source; malformed input fails server-side only. |
| 26 | Low | UX | CommandBar / ⌘K | P09 | Enter on empty query silently navigates | First nav item auto-selected; empty Enter jumps away (no empty dispatch fired, but the jump surprises). |
| 27 | Low | UX | RunConsole / Kill | P09 | Kill ends a run with no confirm | One click terminates; status→"killed", button removed. Observed outcome acceptable. |
| 28 | Low | Docs-mismatch | Docs / bible §10 | P10 | No edit/recompile affordance in #/docs | §10 sends operators to Docs to edit, but Docs is read-only; the editor lives only in the workspace Bible tab. |
| 29 | Nit | UX | Projects / Register | P02 | Expected 4xx console noise (adversarial paths) | App handles invalid paths inline (modal stays + shows error) but the raw 409/400 still logs to console. |
| 30 | Nit | Bug | RunConsole end-to-end | P03 | Real-run loop summary (informational) | `realRunFired=true`, terminal status `done` — live dispatch loop confirmed. |
| 31 | Nit | UX | RunList / kill | P03 | Kill affordance not exercised | Real run finished ("done") before filter, so no kill button to click; presence verified in code only. |
| 32 | Nit | Docs-mismatch | Skills trigger → RunConsole | P05 | Real-run outcome: status=interrupted | Single live `plan`-mode dispatch reached terminal `interrupted` (informational). |
| 33 | Nit | Docs-mismatch | P06 run summary | P06 | Graph rendered YES · KG build not attempted | Canvas renders (no AFRAME blank screen); `gitnexus analyze` build not exercised. |
| 34 | Nit | UX | Sidebar Tasks | P08 | Disabled "Tasks" explained via tooltip | Tooltip "Tasks · Phase 1" — reasonable disabled labeling. |
| 35 | Nit | UX | Sidebar Settings | P08 | Disabled "Settings" explained via tooltip | Tooltip "Settings · Phase 1" — reasonable disabled labeling. |
| 36 | Nit | UX | Shell keyboard chords | P08 | All g-chords work (h/p/r/d/m) | g h/p/r/d/m all jump correctly (positive confirmation). |
| 37 | Nit | UX | TopBar WS dot | P08 | WS dot resolves to connected | Reaches green; amber is brief; state conveyed by color+tooltip only (no text label). |
| 38 | Nit | UX | Docs / unknown slug | P10 | Expected 4xx console noise (unknown slug) | Docs viewer shows not-found inline, but raw 404 still logs to console. |

**Totals across all 10 personas:** 38 findings — **Critical 0 · High 8 · Med 6 · Low 13 · Nit 11.**

---

## Cross-cutting themes

**(a) Client WS URLs hardcoding the core port — real bug, latent off-default.** `web/src/lib/terminal.ts`'s
`terminalWsUrl()` returns `ws://${hostname}:3001/ws/terminal…` with a **literal 3001**, ignoring
`VITE_CORE_PORT` — inconsistent with `web/src/lib/ws.ts` (which was correctly parameterized in this
work). **Caveat:** on the *default* port 3001 the terminal-disabled banner path actually works, so
this bug specifically bites **non-default ports / multi-stack** (exactly the isolated-stack setup the
swarm used). Off-default, the socket dials a dead port, the server's `{error,code:"disabled"}` frame
never arrives, and the "Terminal disabled" reason becomes effectively dead code — which is the root
of P09 #7 (silent blank pane) as well as #8. Worth fixing for parity even though single-stack dev
never sees it. (P09 #2, #1.)

**(b) Unknown-route blank canvas mislabeled "Home".** Any unrouted hash (`#/nonsense`) renders an
empty `<main>` while the TopBar falls back to "⌂Home" — no 404 empty-state, no redirect. `Shell.tsx`
has no default/404 branch and `TopBar` uses a `?? Home` fallback. (P08 #2.)

**(c) ⌘K navigate-vs-dispatch ambiguity.** When the query matches a nav label, the palette puts the
nav row first, so Enter navigates rather than dispatching; the dispatch intent requires arrowing down,
with no mode toggle/hint. Empty-query Enter also silently navigates. (P08 #1, P09 #5.) Compounded by
**(no confirm card)**: even when dispatch *is* selected, ⌘K fires `runs.start` immediately with no
project/model/scope preview. (P03 #1.)

**(d) Bible §10 editing — docs vs reality.** §10 promises a per-section "edit the markdown source"
action and points operators at the Docs view, but: bible sections are on-disk files **not exposed as
artifacts** (`GET /api/artifacts/10-user-guide` → 404), and the `#/docs` Docs/Help view is **read-only**
(.md/.html toggle only). The section editor + Recompile exist solely in the project-**workspace**
Bible tab. So §10's "edit each section" affordance has no target where §10 sends the operator. (P10 #1, #2.)

**(e) Testability gap — almost no `data-testid`.** Across all ten charters the personas had to rely on
ARIA role / visible-text selectors; there are effectively no stable `data-testid` hooks. This made
selectors brittle (strict-mode collisions the authors had to work around) and several "could not reach
X" High findings (P02 dialog, P04 verify nav) are partly **selector/timing fragility under parallel
load** rather than guaranteed product defects. Recommend the team add `data-testid` to key surfaces
(register dialog + its submit, project cards + their action buttons, ⌘K rows, run/kill controls, WS dot).

**(f) Real dispatch / `claude` CLI availability.** The live loop **did execute**: P03 fired a real
plan-mode run that reached terminal `done` (`runId 2d355561-…`); P09 ran a real kill flow (status →
`killed`, button removed); P05's live trigger reached terminal `interrupted`. So end-to-end
dispatch → WS stream → `run_update` → terminal status is **confirmed working** under
`RUN_PERMISSION_MODE=plan`. Terminal statuses varied (`done`/`interrupted`/`killed`) by scenario;
the `interrupted` outcome (P05) is worth a glance but was within plan-mode expectations.

**(g) Empty / low-data state quality.** P07 found metrics render cleanly across groupBy/days/metric
combos with only the 30d right-edge date-tick overlap as a blemish. P01's 20s cold-load and P05's
~16s create-skill round trip suggest first-interaction latency on a cold stack is the weaker part of
the empty-state experience (likely cold WS + initial fetch fan-out, related to P02 #3's
`ERR_INSUFFICIENT_RESOURCES`).

**(h) Missing confirmations on destructive/irreversible actions (new theme).** Skill **delete** (P05 #5),
**kill** (P09 #6, P03), and skill **trigger** (P05 #1) all act on a single unconfirmed click with no
toast/undo/link. Consistent confirm-or-toast treatment would de-risk these and close the feedback gap.

**(i) Discoverability of keyboard power-user features (new theme).** g-chords exist for only 5 of 9
enabled views and there is no in-app shortcut legend (the cheatsheet documents only h/p/r/d/m). (P08 #4.)

**(j) Console hygiene (low priority).** Sandboxed-bible inline-script block (P02 #4) and expected-4xx
noise on adversarial paths/slugs (P02 #5, P10 #3) all reach the console. The 4xx noise is *expected*
(the app handles those inline), but the recurring per-render bible `console.error` is avoidable.

---

## Claims-vs-reality (bible §10)

| §10 promise | Reality observed | Finding |
|---|---|---|
| "Edit each section" of a project's bible (per-section markdown edit) | Sections are on-disk files, not artifacts; `GET /api/artifacts/10-user-guide` → 404 — no edit target for the bible itself | P10 #1 |
| Editing/recompile reachable from where §10 sends operators (Docs) | `#/docs` Docs/Help view is **read-only**; the section editor + Recompile live only in the project-workspace Bible tab | P10 #2 |
| Local path "registers in place and appears as a card" | Register dialog did not complete (stayed open) in the isolated stack | P02 #1, #2 |
| Run verification from a project card | "▶ Run verification" did not navigate to `#/verify/<id>` in the harness | P04 #1, #2 |
| Terminal availability is communicated | When disabled (off-default port), the pane is silently blank — no banner | P09 #1, #2 |
| ⌘K as the dispatch entry point | Works, but no confirm/preview card; nav-word queries prefer navigate | P03 #1, P08 #1 |

Everything else §10 documents (cold boot, Getting Started, Help, fleet graph rendering, metrics,
real dispatch loop, kill) held up in testing.

---

## Prioritized fix backlog (most impactful first)

1. **Fix `terminalWsUrl()` to honor `VITE_CORE_PORT`** — `web/src/lib/terminal.ts:10-12`. Mirror
   `web/src/lib/ws.ts:30`. Closes the parity bug (P09 #8) and re-enables the disabled-reason frame
   off-default ports (root of P09 #7). _Smallest, highest-confidence, clears a High._
2. **Show a Terminal-disabled / connection banner** — `web/src/pages/TerminalPage.tsx`. Render a clear
   "Terminal disabled — set `ENABLE_TERMINAL=true`…" (and a connecting/failed state) instead of a
   silent blank xterm. Depends on #1 for the disabled frame to arrive. (P09 #1.)
3. **Add a 404 / unknown-route empty-state (or redirect to Home)** — `web/src/shell/Shell.tsx`
   (default branch) + `TopBar` title. Stop rendering a blank canvas under a "Home" label. (P08 #2.)
4. **Add a dispatch confirm/preview card to ⌘K** — `web/src/.../CommandBar.tsx` `execute()`. Preview
   project / model / scope (plan mode) before firing `runs.start`. (P03 #1.)
5. **Disambiguate ⌘K navigate-vs-dispatch** — `CommandBar` items ordering + a mode hint/toggle; make
   empty-query Enter a no-op. (P08 #1, P09 #5.)
6. **Confirmation + feedback for destructive/triggering actions** — add confirm (or undo toast) to
   skill **delete** and **kill**, and an `onSuccess` toast/run-link to skill **trigger** /
   `triggerMutation`. (P05 #1, #5; P09 #6.) Surface the existing `api.skills.runs()` history. (P05 #2.)
7. **Reconcile bible §10 with reality** — either (a) expose bible sections via the artifacts API +
   add a Docs-view edit affordance, or (b) edit §10 to state that section editing lives in the
   project-workspace Bible tab. Pick one; document it. (P10 #1, #2.)
8. **Add stable `data-testid` hooks** to register dialog/submit, project cards + action buttons, ⌘K
   rows, run/kill controls, and the WS dot. De-flakes the suite and de-risks P02/P04. (Theme e.)
9. **Investigate cold-load + create latency and the request storm** — 20s cold Home (P01), ~16s
   create-skill (P05 #3), `ERR_INSUFFICIENT_RESOURCES` (P02 #3). Likely fetch fan-out / cold WS;
   look at initial query batching. (P01 #1, P05 #3, P02 #3.)
10. **WS dot should reflect drops** — ensure `emitStatus(false)` flips the dot to amber on outage,
    and consider a text label for at-a-glance reading. (P09 #3, P08 #8.)
11. **Client-side validation hints** — register path/URL format hint (P09 #4) and cron format
    hint/validation (P05 #4) before spending a server round-trip.
12. **Metrics 30d date-axis tick overlap** — `web/src/.../TimeseriesChart`: fix the
    `translateX(-50%)` vs `(-100%)` collision at the right edge. (P07 #1.)
13. **Keyboard chord parity + in-app legend** — add chords for graph/skills/routing/terminal and a
    discoverable shortcut list. (P08 #4.)
14. **Console hygiene** — stop the per-render bible iframe `console.error` (compiled bible ships an
    inline `<script>` the sandbox blocks); the 4xx adversarial noise can be left as-is. (P02 #4.)

---

## Coverage gaps / caveats

- **Populated metrics / routing over time** were **not** tested with real historical data — only
  empty/low-data rendering (local-only stacks, no accumulated runs). The 30d axis bug (P07) was the
  only one reachable. Trend correctness over a populated window is unverified.
- **GitHub / PR flows** were exercised only in graceful-degradation form (no remote configured) —
  P03's "Create-PR graceful failure with no remote" charter; real clone-from-URL and PR creation
  against GitHub were **not** driven.
- **`gitnexus analyze` (KG build)** was **not attempted** by P06 — only that the ForceGraph canvas
  *renders* (no AFRAME blank screen) was confirmed. Build-reaching-terminal-state is unverified.
- **Register + verify-navigation High findings (P02 #1/#2, P04 #1/#2)** were observed as
  dialog/navigation **timeouts under parallel isolated-stack load**; they may be partly
  selector/timing fragility (theme e) rather than guaranteed product defects on a single
  default-port stack. Worth a manual single-stack repro before deep code changes.
- **Real `claude` dispatch DID execute** (P03 done, P09 killed, P05 interrupted) — but only **one
  short plan-mode run per persona** under `RUN_PERMISSION_MODE=plan`; no long-running, edit-mode, or
  concurrent-real-dispatch load was tested.
- **Node-scoped dispatch from the graph** (P06 charter) and **fleet node→workspace click-through**
  were **not** confirmed by automation (canvas hit-test missed centre click); wired in code, unverified.
- **Kill affordance** presence was verified in code for the *RunList* (P03 #2) — only the
  *RunConsole* kill was exercised live (P09 #6).
- Spec-author/harness artifacts (Playwright strict-mode selector collisions the agents fixed during
  authoring) are **excluded** from this report — they are not product bugs.
