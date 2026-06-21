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

### Wave R1 — Install / Run documentation
- [ ] Overhaul `README.md` into a real quick-start (prereqs, install, `pnpm dev`, ports, `.env` from `.env.example`, troubleshooting); cross-link bible §09 as the deep reference, keep consistent
- [ ] Spec-review (every command accurate vs real scripts) + quality-review
- [ ] Verify: an agent follows the README verbatim on a clean checkout; each step works

### Wave R2 — In-app Getting Started + surface core workflows
- [ ] First-run/empty-state Getting Started flow: Register project → Build graph → Run verification
- [ ] Surface hidden backends: Onboard button (`POST /api/projects/:id/onboard`), Verify action, Build-graph hint, sidebar tooltips, enable Fleet Graph (Phase H is done)
- [ ] Spec + quality review (glass/motion tokens, reduced-motion via MotionConfig, `react-force-graph-2d` only)
- [ ] Verify: live Playwright smoke — empty state → register → graph build → verify, screenshots

### Wave R3 — Bible "How to Use K" user guide + in-app Help
- [ ] New bible section `artifacts/bible/sections/10-user-guide.md` + register in `manifest.json` (markdown source only, never compiled HTML)
- [ ] Reachable from in-app Docs (`web/src/pages/DocsPage.tsx`); add a Help affordance
- [ ] Spec (paths/values grepped vs source) + quality review
- [ ] Verify: recompile bible, section renders in-app + in compiled HTML

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
