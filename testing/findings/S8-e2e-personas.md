# S8 (E2E half) — Phase-5 persona-swarm extension findings

**Scope (S8 charter, E2E half).** Extend the Playwright persona swarm
(`e2e/specs/P*.spec.ts`, `e2e/RUNBOOK.md`) to critically user-test the **Phase-5 surfaces** shipped
since the existing P01–P10 swarm — the **workflow status checklist**, the **settings surface**, and
the **voice affordance** — on the isolated-port harness. The pure-logic/jsdom half (`web/test/**`)
is owned by a separate orchestrator and is untouched here.

**New personas.** Two resilient personas were authored, modeled exactly on `P01.spec.ts`:

| Persona | Ports (core/web) | Spec | Surface |
|---------|------------------|------|---------|
| **P11** | 3111 / 4111 | `e2e/specs/P11.spec.ts` | Workflow status checklist |
| **P12** | 3112 / 4112 | `e2e/specs/P12.spec.ts` | Settings surface + voice affordance |

**Method.** Each persona drives a **real Chromium** against a freshly-booted isolated stack (own
`CORE_PORT`/`WEB_PORT`/`K_DATA_DIR`), attaches `captureConsole` (fail-loud: any `console.error` /
uncaught page error is ≥ High), wraps every exploratory interaction in try/catch → findings, hard-
asserts **only** WS reachability, screenshots evidence, and ends with `writeFindings`. **prober** =
the persona spec authored on first pass; **validator** = an independent green-resilient re-run that
reproduced the same finding set (P11 re-run after two false-positive fixes; P12 first run clean).
Both run green-resilient: **P11 5/5 passed**, **P12 6/6 passed**, with no uncaught failures.
Per-persona reports + screenshots: `e2e/reports/P11.md`, `e2e/reports/P12.md`,
`e2e/reports/screens/P1{1,2}-*.png`.

> Budget honored: **no real `claude` dispatch**, **no real Whisper key**, **no real microphone**.
> Voice gating/degradation is asserted only at the API gate; the CLAUDE.md confirm dialog is always
> **cancelled**, never confirmed.

## Summary

| id | persona | severity | category | classification | one-liner |
|----|---------|----------|----------|----------------|-----------|
| S8-E01 | P11 | Low | Missing | observation | Populated workflow checklist has **no token-free way to preview/verify** (only a real delegation dispatch creates a `workflow_run`). |
| S8-E02 | P12 | Med | Missing | observation | **No voice/mic affordance exists in the UI** — `POST /api/transcribe` ships but the browser never calls it. |
| S8-E03 | P12 | Low | Docs-mismatch | LOCK | RUNBOOK selector cheatsheet is **stale**: `Settings` is now enabled; `Tasks` is no longer a destination. |
| S8-E04 | P12 | Low | Missing | observation | **Voice/Whisper status is not surfaced in Settings** despite `/api/status.voice` reporting it. |
| S8-E05 | P12 | Nit | Robustness | LOCK (verified) | Voice gate works: `POST /api/transcribe` → **503 "voice disabled"** when `ENABLE_VOICE` is off (graceful degradation). |

**Verified-good (LOCK, no finding) — characterized and passing in the specs:**
- `GET /api/runs/:id/workflow-steps` **degrades gracefully** — `200 {workflowRun:null, steps:[]}` for
  unknown / encoded-traversal / special-char / 2 KB-oversized run ids; **never 5xx** (P11 test 3).
- Bogus deep-link `#/workflows/<id>` renders the run tree, **omits the checklist**, keeps the shell
  interactive, no page error (P11 test 4).
- Run-tree tab on an empty DB shows the **"No runs yet." empty state** + run picker; the checklist is
  correctly absent (P11 test 2).
- Settings is **reachable** (sidebar + `#/settings`), the four **status cards render**
  (Claude/Ollama/GitHub/Harness Auth), **no raw token** leaks into the DOM, and the **CLAUDE.md
  confirm-guard** appears on Save and cancels cleanly (P12 tests 1–3).

---

### S8-E01 — populated workflow checklist is unverifiable within the no-dispatch budget · observation
- **system:** `web/src/components/WorkflowChecklist.tsx`, `web/src/pages/WorkflowsPage.tsx`
  (`wf?.workflowRun` gate), `core` `GET /api/runs/:id/workflow-steps`.
- **severity:** Low · **category:** Missing (observability/testability) · **classification:** observation
- **surface:** Workflows → "Run tree" → `data-testid="wf-checklist"`.
- **repro:** Try to render the populated checklist (status glyphs `○ ◐ ● ◼ ✕`, kind badges
  ticket/phase/review/CI, `wf-overall-status`, done line-through) without a real multi-agent dispatch.
- **expected:** a token-free way to preview it — a seeded sample workflow run, a demo fixture, or an
  HTTP create endpoint — so its populated rendering is verifiable in CI/persona runs.
- **actual:** `wf-checklist` only mounts when `GET /api/runs/:id/workflow-steps` returns a **non-null**
  `workflowRun`, which is created **only** by `dispatchTaskWorkflow` (a real delegation dispatch) or
  the kstore **stdio** MCP tools. There is no HTTP seed route, and `better-sqlite3` is not resolvable
  from the e2e context, so direct DB seeding from a spec is unavailable. The empty/degraded paths are
  covered; the **populated** rendering is not.
- **evidence:** `e2e/reports/P11.md` #1; `e2e/reports/screens/P11-checklist-gap.png`.
- **test-path:** `e2e/specs/P11.spec.ts` (resilient persona; not a gating vitest test).

### S8-E02 — no voice/microphone affordance exists in the UI · observation
- **system:** web shell / `CommandBar` / `SettingsPage`; core `routes/voice.ts` (`POST /api/transcribe`).
- **severity:** Med · **category:** Missing · **classification:** observation
- **surface:** Home, ⌘K command bar, Settings (swept for any voice/mic/dictation control).
- **repro:** Sweep Home + ⌘K + Settings for a button/role/aria/title matching
  voice/mic/record/transcribe; also confirm no `getUserMedia`/`MediaRecorder` usage in `web/src`.
- **expected:** a voice affordance (mic button / dictation) wired to `POST /api/transcribe`, gated by
  `ENABLE_VOICE`, so an operator can use the shipped transcription endpoint.
- **actual:** **none found.** The core ships a complete `POST /api/transcribe` (25 MB cap, MIME-gated
  Whisper proxy, `ENABLE_VOICE`-gated) but **no web client ever calls it** — the feature is
  backend-only with no user-facing entry point.
- **evidence:** `e2e/reports/P12.md` #1; screens `P12-voice-home.png`, `P12-voice-cmdk.png`,
  `P12-voice-settings.png`; `web/src` has zero `MediaRecorder`/`getUserMedia`/`transcribe` references.
- **test-path:** `e2e/specs/P12.spec.ts` test 4.

### S8-E03 — RUNBOOK selector cheatsheet is stale (Settings enabled; Tasks gone) · LOCK
- **system:** `e2e/RUNBOOK.md` selector cheatsheet vs `web/src/shell/Sidebar.tsx` `DESTINATIONS`.
- **severity:** Low · **category:** Docs-mismatch · **classification:** LOCK
- **surface:** Sidebar footer nav / `#/settings`.
- **repro:** Compare the RUNBOOK note "`Tasks` and `Settings` are **disabled** by design" against
  `DESTINATIONS`.
- **expected:** the cheatsheet reflects the current nav.
- **actual:** `Sidebar.tsx` has `settings { enabled: true }` (a live footer entry routing to
  `#/settings`) and **no `tasks` entry at all**. The stale note would mislead future personas into
  skipping a now-live surface. (A registration-time note was added to the RUNBOOK pointing this out;
  the cheatsheet line itself is left for the Director to correct, since the charter scopes my RUNBOOK
  edits to persona registration only.)
- **evidence:** `e2e/reports/P12.md` #2; `web/src/shell/Sidebar.tsx:33`; `P12-settings-nav.png`.
- **test-path:** `e2e/specs/P12.spec.ts` test 1.

### S8-E04 — voice/Whisper status is reported by /api/status but not surfaced in Settings · observation
- **system:** `core/src/routes/settings.ts` (`/api/status.voice`), `web/src/pages/SettingsPage.tsx`.
- **severity:** Low · **category:** Missing · **classification:** observation
- **surface:** Settings → `StatusSection` (status card grid).
- **repro:** `GET /api/status` returns `voice: { enabled, reachable, baseUrl, model }`; open
  `#/settings` and look for a Voice/Whisper card.
- **expected:** a Voice (Whisper) status card alongside Claude/Ollama/GitHub/Harness Auth, since the
  API already provides the data.
- **actual:** `status.voice.enabled=false` is available from the API, but Settings renders **only four
  cards** (no Voice) — the operator has no in-app visibility into whether voice is enabled/reachable.
- **evidence:** `e2e/reports/P12.md` #3; `P12-voice-status-gap.png`; `SettingsPage.tsx` (4 cards).
- **test-path:** `e2e/specs/P12.spec.ts` test 6.

### S8-E05 — voice gate degrades gracefully: /api/transcribe → 503 "voice disabled" · LOCK (verified)
- **system:** `core/src/routes/voice.ts` + `config-store.ts` (`voiceEnabled()`).
- **severity:** Nit · **category:** Robustness · **classification:** LOCK (verified)
- **surface:** `POST /api/transcribe` with `ENABLE_VOICE` unset (the e2e default).
- **repro:** `POST /api/transcribe` with `content-type: audio/webm` and a 4-byte buffer (no key, no
  real audio) → read status/body.
- **expected:** a clean **503** with a clear "voice disabled" reason when the feature is off.
- **actual:** exactly that — `HTTP 503`, `body.error === "voice disabled"`. The gate fires **before**
  any provider/key/body work, so voice degrades gracefully with no crash and no key requirement.
- **evidence:** `e2e/reports/P12.md` #4 (`page.request` capture).
- **test-path:** `e2e/specs/P12.spec.ts` test 5.

---

## Artifacts written by the Playwright run (expected, non-durable)

- `e2e/reports/P11.md`, `e2e/reports/P12.md` — per-persona findings (RUNBOOK schema).
- `e2e/reports/screens/P11-*.png`, `e2e/reports/screens/P12-*.png` — screenshot evidence.
- `e2e/reports/_html/P1{1,2}/`, `e2e/reports/_json/P1{1,2}.json`, `e2e/reports/_artifacts/` — trace/HTML.
- `e2e/.data/core-3111`, `e2e/.data/core-3112` — isolated per-persona SQLite DBs.

The **durable** record is this file; `e2e/RUNBOOK.md` is updated with the P11/P12 registration.
