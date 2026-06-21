# Phase 4 (Multi-Device) + User-Testing Readiness

Branch: `feat/phase-4-and-testing-readiness` (off `main`, after Phase H + Wave 0 dev fix landed).
One reviewable commit per wave via the delegation loop (implementer → spec-review → quality-review →
controller verifies/commits → CI/live smoke). Controller writes no code; all impl/fix/review/verify
is delegated. Whole-implementation review before the final `--no-ff` merge.

Plan: `~/.claude/plans/read-and-analyze-the-linked-bengio.md`

## Wave 0 — Land Phase H (pnpm dev fix + merge)  ✅ DONE
- [x] Diagnosed + fixed the `pnpm dev` Vite-proxy/500 bug (`node --watch --import tsx` + `concurrently` + proxy 503 handler); verified proxy 200 in ~3s, typecheck/build green
- [x] `--no-ff` merge Phase H into `main` (`fb8141c`) + pushed to origin (`224a4a6..fb8141c`)

## Track A — User-Testing Readiness

### Wave R1 — Install / Run documentation  ✅ (commit de1c956)
- [x] Overhauled `README.md` into a 5-min quick-start (prereqs, install, `pnpm dev`, ports, `.env`, troubleshooting from bible §09); also fixed `.env.example` RUN_PERMISSION_MODE default comment
- [x] Spec-review (controller): every command matches verified source
- [x] Verify: `pnpm dev` proxy 200 (Wave 0), `pnpm -r test` green (core 389), typecheck/build green

### Wave R2 — In-app Getting Started + surface core workflows  ✅
- [x] `GettingStarted.tsx` 3-step card on empty states (Home + ProjectsPage); step 1 reflects live progress
- [x] OverviewTab Quick Actions: Onboard (`POST …/onboard` + result notice), Build-graph; Verify/Dispatch already existed; added `api.projects.onboard`
- [x] Enabled Fleet Graph sidebar entry; added tooltips + aria-labels to all nav items
- [x] Spec + quality review → CLEAN (AFRAME rule honored, motion/glass conventions, API correct); 2 NITs fixed (comment accuracy, redundant AnimatePresence)
- [x] Verify: live Playwright smoke — ALL routes non-blank, 0 console/page errors, Fleet Graph canvas renders (2 nodes), Getting Started visible; typecheck/build/test green (web 95)

### Wave R3 — Bible "How to Use K" user guide + in-app Help  ✅
- [x] New bible section `artifacts/bible/sections/10-user-guide.md` (task-oriented: install/run, register, dashboard tour, graph, dispatch, verify, onboard, edit bible, troubleshooting) + registered in `manifest.json`
- [x] In-app **Help** sidebar item (❔) → opens the bible in Docs (`view:docs param:project-bible`)
- [x] Spec review (controller): sidebar-icon table matches real DESTINATIONS; content consistent with README/§09; Sidebar `view ?? id` preserves all existing nav
- [x] Verify: core compiled 10 sections, `<section id="10-user-guide">` present in project-bible.html; web typecheck/build clean

## Track B — Phase 4 (Multi-Device)

### Wave P1 — Remote-access hardening  [prereq for P2/P3 exposure]
- [ ] Replace insecure default `HARNESS_TOKEN` flow with real auth (passkey/TOTP or strong generated token + first-run setup); validate at the API boundary
- [ ] Document Tailscale / reverse-proxy exposure + guardrails (bible §04/§09; `core/src/index.ts` auth)
- [ ] Security-review agent (mandatory) + spec + quality
- [ ] Verify: auth enforced on API + WS; documented Tailscale path works end-to-end

### Wave P2 — Tauri desktop app
- [ ] Tauri shell wrapping the web UI + bundled/launched core, tray icon, native notifications (run completion, CI status); new workspace package + build scripts
- [ ] Spec + quality (+ build-error-resolver for Rust/Tauri toolchain as needed)
- [ ] Verify: app launches, connects to core, tray + a native notification fire

### Wave P3 — PWA mobile
- [ ] Installable PWA (manifest, service worker, icons) + push notifications; responsive dashboard/graph on mobile
- [ ] Spec + quality
- [ ] Verify: Lighthouse PWA installability passes; install + push notification verified

## Whole-implementation review + merge
- [ ] Whole-impl review across R1–P3 (security, integration, regressions, lessons adherence, dead-code)
- [ ] CI green (`pnpm typecheck && pnpm -r test && pnpm build`) + final live smoke
- [ ] `--no-ff` merge `feat/phase-4-and-testing-readiness` into `main`, push

## Deferrals (noted, out of scope unless requested)
- Wire coverage signal + agent-layer verification scoring into the health score (bible §05 flags both)
- Adaptive polling cadence / webhook push / learned routing (bible Phase 5)

## Review notes
_(appended as waves land)_
