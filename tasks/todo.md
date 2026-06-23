# Phase 4 (Multi-Device) + User-Testing Fixes

Branch: `feat/phase-4-multidevice` (off `main`, after Phase H + Track A readiness merged).
One reviewable commit per wave via the delegation loop (implementer → spec-review → quality-review →
controller verifies/commits → CI/live smoke). Controller writes no code; all impl/fix/review/verify
is delegated. Whole-implementation review before the final `--no-ff` merge.

**Order of work:** **Track C (user-testing fixes) runs next**, before Phase 4 P2/P3 — highest-impact
while the system is in active user testing. P1 auth (already built) just needs review + verify +
commit. P2/P3 follow Track C.

Plans: `~/.claude/plans/read-and-analyze-the-cryptic-pearl.md` (this reconciliation),
`~/.claude/plans/read-and-analyze-the-linked-bengio.md` (original Phase 4 plan).

## Wave 0 — Land Phase H (pnpm dev fix + merge)  ✅ DONE
- [x] Diagnosed + fixed the `pnpm dev` Vite-proxy/500 bug (`node --watch --import tsx` + `concurrently` + proxy 503 handler); verified proxy 200 in ~3s, typecheck/build green
- [x] `--no-ff` merge Phase H into `main` (`fb8141c`) + pushed to origin (`224a4a6..fb8141c`)

## Track A — User-Testing Readiness  ✅ MERGED (`d87d192`, pushed)
- [x] **R1** — README quick-start overhaul + `.env.example` RUN_PERMISSION_MODE fix (`de1c956`)
- [x] **R2** — In-app Getting Started card + surfaced Onboard/Verify/Build-graph + enabled Fleet Graph + nav tooltips/aria (live Playwright smoke green)
- [x] **R3** — Bible §10 "How to Use K" user guide + in-app **Help** sidebar entry (compiled 10 sections; web typecheck/build clean)

---

## Track C — User-Testing Fixes  ⬅ NEXT

Folds in the prioritized fix backlog from `artifacts/user-testing-report.md` (38 findings —
0 Critical · 8 High · 6 Med · 13 Low · 11 Nit). Each wave runs the standard
implementer → spec-review → quality-review → verify loop and lands one reviewable commit. Report
backlog item numbers are shown in `(report #N)`.

### Wave C1 — Terminal port + disabled banner  ✅ DONE (committed `a4e5511`)  [clears a High]
- [x] Fixed `terminalWsUrl()` (`web/src/lib/terminal.ts`) to take a **required** `port` param
      (no default → a future caller can't silently regress to a hardcoded port); `TerminalPage`
      computes `VITE_CORE_PORT ?? '3001'` exactly like `web/src/lib/ws.ts:30` and passes it
      (report #1; finding #8)
- [x] `TerminalPage.tsx` now renders a **connecting / disabled / failed** status badge + a
      pane-scoped overlay instead of a silent blank xterm; effect-scoped `reported` flag keeps a
      server gate frame (e.g. `disabled`) from being clobbered by the unclean-close message
      (report #2; finding #7). Added `data-testid` `terminal-status` / `terminal-overlay`
- [x] Spec + quality review (code-reviewer agent) → **APPROVE**, 0 Critical/High/Med; applied the
      LOW copy-consistency nit; rejected the NIT (unconditional `setConnecting(false)` is the more
      robust choice — prevents a stuck-"Connecting…" path on a clean close before open)
- [x] Verify: web typecheck clean · `web test` **96 passed** (+1 new) · `build` ✓ · live Playwright
      smoke on **non-default** port 3190 (`P09` terminal test) — disabled banner shown and the core
      logged `GET /ws/terminal` arriving at **:3190** (proves the port is honored, not dead `:3001`)

### Wave C2 — Routing + ⌘K dispatch  ✅ DONE (committed)
- [x] 404 / unknown-route empty-state — `web/src/pages/NotFound.tsx` rendered from `Shell.tsx`'s
      default branch via the shared `isKnownView()`/`KNOWN_VIEWS` in `web/src/lib/route.ts`; TopBar
      shows "Not found" (⌀), not "Home"; `data-testid="route-404"` (report #3; finding #13)
- [x] Dispatch **confirm / preview card** in `CommandBar.tsx` — `execute()` now stages a confirm
      card (Project / Model / Scope·permission) before `fireDispatch()` calls `api.runs.start`;
      Enter confirms, Esc cancels (report #4; finding #4). Model/permission shown as **defaults**
      with explicit "(default · routing/env may override)" caveats so the card can't misrepresent the
      effective run config — makes bible §10's confirm-card language true without lying
- [x] Disambiguate navigate-vs-dispatch via `decideEnterMode()` (pure, unit-tested) + a footer
      mode toggle (Tab flips Navigate/Dispatch, `data-testid="enter-mode-toggle"`); empty-query
      Enter is now a no-op (report #5; findings #12, #26)
- [x] Spec + quality review (code-reviewer) → **CHANGES REQUESTED** → fixed: confirm-card `flex-col`
      stacking, default-caveats, cancel-confirm-on-edit, `role=dialog`+focus+aria, dead Esc/`navMatch`
      dedup. Re-run clean
- [x] Verify: web typecheck · `web test` **100 passed** (command-parse 12→16) · build ✓ · **live
      browser smoke 5/5** (no blank-screen regression, 404 state, confirm card stacks below w/ caveats,
      empty Enter no-op, mode toggle) — zero console errors

### Wave C3 — Destructive-action confirms + skill feedback  ✅ DONE (committed)
- [x] Reusable `ConfirmDialog` gates skill **delete** + run **kill** at **both** kill sites
      (RunConsole + RunList); `api.skills.delete`/`api.runs.kill` only fire from the dialog confirm
      (report #6; findings #19, #27). testids `skill-delete-*` / `run-kill-*`
- [x] `Toast` on skill **trigger** linking to the **real** run (trigger returns `{runId}` →
      `navigate('runs', runId)`); trigger/delete now have error feedback too (report #6; finding #10)
- [x] `SkillRunHistory` surfaces the previously-dead `api.skills.runs()` (react-query, list/empty/
      error states, each row links to its run) (report #6; finding #11)
- [x] Spec + quality review (code-reviewer) → CHANGES (4 MED) → fixed: ConfirmDialog `aria-labelledby`,
      Toast timer-reset (ref'd onDismiss), trigger/history error states, delete-error in dialog
- [x] Verify: web typecheck · `web test` **109 passed** (skill-runs + api-204 unit tests) · build ✓ ·
      **live smoke 5/5** (no blank screen; delete/kill confirm gate; trigger toast+link navigates;
      history renders). Smoke **caught a real bug** — `DELETE /api/skills/:id` returns 204 but
      `req<void>()` called `res.json()` → "Unexpected end of JSON input", so a successful delete
      errored in the UI. Root-caused in `web/src/lib/api.ts` `req()` (204/empty short-circuit) +
      unit test; **re-verified live** (dialog closes, row clears without reload, zero console errors)

### Wave C4 — Testability hooks  ✅ DONE (committed)  [de-risks the P02/P04 High timeouts]
- [x] Added stable `data-testid` across the surfaces (report #8; theme e): register dialog
      (`register-open`/`-dialog`/`-name`/`-source`/`-submit`), project cards + verify action
      (`project-card-${id}`, `project-verify-btn-${id}` — keyed by id to avoid Playwright strict-mode
      collisions on the grid), ⌘K input + rows (`cmdk-input`, `cmdk-row-dispatch`/`-nav`), run controls
      (`run-row` [intentionally non-unique], `run-filter-${f}`; kill `run-kill-btn`/`-dialog` already
      landed in C3), WS dot (`ws-dot` + `data-ws-status`). Dropped a dead `data-cmdk-row` attr
- [x] Single-stack repro (`e2e/specs/C4-repro.spec.ts`, gated out of the persona swarm via `PERSONA`)
      proves **P02 register-dialog (#1,#2) and P04 verify-nav (#5,#6) are harness parallel-load
      flakiness, NOT product defects**: register #1/#2 close the dialog + render cards in ~1.3s each,
      verify-nav reaches `#/verify/<id>` in ~85ms; spec asserts dialog-close, card-count ≥2, the URL
      carries the real project id, and **zero unexpected 4xx/5xx** (so a server error can't pass
      silently). No product defect → no code fix needed
- [x] Spec + quality review (code-reviewer) → **CHANGES REQUESTED** (1 HIGH testid-uniqueness, 3 MED
      repro-rigor, 2 LOW) → all fixed: id-keyed `project-verify-btn`, asserted `net4xx5xx`,
      URL-carries-id assertion, self-sufficient 2nd register test, swarm gate, `run-row` comment, dead
      attr removed. Re-run clean
- [x] Verify: web typecheck · `web test` **109 passed** · build ✓ · repro spec **3/3** on a non-PERSONA
      single default-port stack (0 console/page errors, 0 HTTP ≥400)

### Wave C5 — Polish & hygiene
- [ ] WS dot reflects a dropped connection (amber "connecting…" on outage); consider a text label
      (report #10; findings #14, #37)
- [ ] Client-side hints: register path/URL format (finding #25) and cron format/validation before the
      server round-trip (finding #18) (report #11)
- [ ] Metrics 30d date-axis right-edge tick overlap — `TimeseriesChart` `translateX(-50%)` vs `(-100%)`
      collision (report #12; finding #22)
- [ ] Keyboard-chord parity (add g-chords for graph/skills/routing/terminal) + in-app shortcut legend
      (report #13; finding #24)
- [ ] Stop the per-render bible iframe `console.error` (sandboxed inline `<script>`) (report #14;
      finding #16). Leave the expected-4xx adversarial console noise as-is (findings #29, #38)
- [ ] Spec + quality review
- [ ] Verify: outage flips the dot; invalid path/cron caught client-side; axis ticks legible; chords
      + legend present; bible iframe quiet

### Wave C6 — Cold-load / latency investigation  [investigate, don't blind-fix]
- [ ] Investigate cold Home ~20s (finding #9), create-skill ~16s (finding #17), and the
      `net::ERR_INSUFFICIENT_RESOURCES` request storm (finding #3) — likely cold WS + initial fetch
      fan-out; look at initial query batching (report #9)
- [ ] Spec + quality review
- [ ] Verify: measure cold-load + create round-trips before/after; no request storm in console

---

## Track B — Phase 4 (Multi-Device)

### Wave P1 — Remote-access hardening  ✅ DONE (committed `5d629b1`)
- [x] Replaced insecure default `HARNESS_TOKEN` flow with a strong **generated + persisted first-run
      token** (`core/src/auth.ts`: env → `data/auth-token` → `crypto.randomBytes(32)` first-run +
      banner; `unsafeBootReason` refuses a non-loopback bind with a weak/empty token; constant-time
      `tokensEqual`/`wsTokenOk`). Wired in `core/src/index.ts` (`resolveHarnessToken`,
      `unsafeBootReason`, first-run banner). Web: `web/src/lib/auth.ts` + `LoginScreen.tsx` (401 →
      token login, sessionStorage), `ws.ts`/`api.ts` use `effectiveToken()`
- [x] Documented Tailscale / reverse-proxy exposure + guardrails — bible §09 "Remote access" section
      (token resolution, safety gate, Tailscale/HTTPS-proxy guidance, WS `4401` auth)
- [x] **Security-review (mandatory) + quality + spec-conformance** of the auth surface →
      security **APPROVE** (post-fix), quality **CHANGES→fixed**, spec **CONFORMS**. Blockers fixed:
      WS `4401` no longer infinite-reconnects (shared `auth-events` surfaces login on REST+WS),
      `ws.ts` uses `wss://` over HTTPS, `vite.config` never bakes a real token (DEV-gated
      `effectiveToken`), Fastify `disableRequestLogging` (no bearer in logs), `terminalGate`
      constant-time + a non-loopback `TERMINAL_TOKEN` boot gate. Deferred (documented): HMAC-equalized
      compare (token is fixed-length base64url(32) — length not secret)
- [x] Verify: core **425** + web **96** tests · build ✓ · **8/8 live runtime smoke** — first-run
      gen+persist (banner == `data/auth-token`), REST `401`(none/wrong)/`200`(valid), WS `4401`/open,
      non-loopback weak-token boot refusal for **both** HARNESS_TOKEN and TERMINAL_TOKEN
- [x] Committed `5d629b1` (auth surface + README remote-access + §09); e2e harness + lockfile landed
      separately in `4738d01` (`test:`)

### Wave P2 — Tauri desktop app
- [ ] Tauri shell wrapping the web UI + bundled/launched core, tray icon, native notifications (run completion, CI status); new workspace package + build scripts
- [ ] Spec + quality (+ build-error-resolver for Rust/Tauri toolchain as needed)
- [ ] Verify: app launches, connects to core, tray + a native notification fire

### Wave P3 — PWA mobile
- [ ] Installable PWA (manifest, service worker, icons) + push notifications; responsive dashboard/graph on mobile
- [ ] Spec + quality
- [ ] Verify: Lighthouse PWA installability passes; install + push notification verified

## Bible §10 reconciliation (doc-vs-reality)
- [ ] **Edit-affordance pointer (report #7; findings #15, #28):** §10 already points editing to the
      project-**workspace Bible tab** (correct), but the **Help → Docs** path lands readers in
      read-only Docs. Add one sentence making clear that section editing + Recompile live in the
      workspace Bible tab (not the read-only Docs/Help view) so §10's "edit each section" promise has
      a real target. _(Doc-only — done in this reconciliation pass; see Review notes.)_
- [ ] Confirm-card / node-dispatch language in §10 is intentionally **kept** — it converges to reality
      when **Wave C2** lands the confirm card (node-dispatch is already wired). Do not delete/re-add.

## Whole-implementation review + merge
- [ ] Whole-impl review across Track C + P1–P3 (security, integration, regressions, lessons adherence, dead-code)
- [ ] CI green (`pnpm typecheck && pnpm -r test && pnpm build`) + final live smoke
- [ ] `--no-ff` merge `feat/phase-4-multidevice` into `main`, push

## Deferrals / known coverage gaps (out of scope unless requested)
- **Live run-config in the ⌘K confirm card (from C2):** the card previews the *default* model +
  permission mode with an explicit "(default)" caveat. The truly-effective values come from core env
  (`CLAUDE_MODEL`/`RUN_PERMISSION_MODE`) and the per-project router. A `GET /api/run-config` endpoint
  (+ per-dispatch routing preview) would make the card show exact effective values — Phase 4 follow-up.
- Wire coverage signal + agent-layer verification scoring into the health score (bible §05 flags both)
- Adaptive polling cadence / webhook push / learned routing (bible Phase 5)
- **Untested in the user-testing swarm (verify before claiming these work):** populated
  metrics/routing **trends over time** (only empty/low-data rendering tested); real **GitHub clone +
  PR creation** (only graceful no-remote degradation); `gitnexus analyze` **KG build to terminal
  state** (only that the canvas renders, no AFRAME blank); **fleet node → workspace click-through**
  (canvas hit-test; wired but unverified by automation); **edit-mode / long-running / concurrent real
  dispatch** (only one short plan-mode run per persona)

## Review notes

### Doc reconciliation pass (2026-06-22)
Folded the user-testing report's 14-item prioritized backlog into a new **Track C** (Waves C1–C6),
grouped by theme, each ready for the delegation loop; every backlog item maps to a wave item with its
`report #N` / `finding #N` reference. Corrected the tracker branch to `feat/phase-4-multidevice`.

Verified against source (not just the report):
- **P1 auth is built and uncommitted** — `core/src/auth.ts`, `core/src/index.ts` (banner at :47/:226/:262),
  web login flow, and bible §09 "Remote access" all present; remaining work is security-review +
  verify + commit only.
- **Still open, confirmed in source:** `web/src/lib/terminal.ts:11` hardcodes `:3001` (Wave C1);
  `web/src/shell/CommandBar.tsx:84` `execute()` calls `api.runs.start` with no confirm card (Wave C2).

Bible §10 edit-affordance pointer clarified in this pass; confirm-card language intentionally kept
(converges when C2 lands). No product/source code touched.
