---
name: create-mobile-ui-artifact
description: "Use to author or refresh the K mobile companion app mockup — a single self-contained, full-bleed HTML artifact (inline CSS+JS, offline, sandbox-safe) that demonstrates the phone-based companion to the desktop Command Deck (pairing, K chat, live activity, approvals/HITL, run console, settings). The mobile counterpart to create-web-ui-artifact: that skill mocks the web deck per project; this skill mocks the harness's mobile companion. Examples: \"create the mobile UI artifact\", \"refresh the mobile companion demo\", \"update the phone app mockup\"."
---

# Create Mobile-UI Artifact

## What It Does

Produces a single self-contained, interactive HTML demo of the **K mobile companion
app** — the phone client that monitors the harness running on your computer. It is
authored to render untouched in the DocViewer's sandboxed iframe, exactly like the
harness's own `ui-demo` and the per-project demos from `create-web-ui-artifact`.

It is the **mobile counterpart** to `create-web-ui-artifact`:

- `create-web-ui-artifact` → a project's web Command-Deck demo (`project-<id>-ui-demo`).
- `create-mobile-ui-artifact` → the harness's mobile companion demo (`mobile-ui-demo`).

The companion is a **monitor + approve** app, not a port of the desktop deck. It
covers what a phone is good for and deliberately omits heavy desktop surfaces. The
canonical output lives at `artifacts/mobile-ui-demo.html`.

## When to Use

- To (re)generate the mobile companion mockup after the companion design changes.
- To demonstrate the mobile UX of the connection/auth, push, and approval flows.
- To keep the phone mockup in step with the design recorded below and the design
  language in bible §08.

Skip this for per-project web demos — use `create-web-ui-artifact` for those.

## Design contract (what the mockup must depict)

The companion is **transport-agnostic** and rides K's existing authenticated REST +
WS API (bible §11). v1 scope:

- **Onboarding / Pair** — QR pairing (`{ baseUrl, deviceToken }`) with a manual
  URL+token fallback; a connection test; optional biometric app-lock setup.
- **Four bottom tabs** — **K** (greeting + one Ask-K composer with inline route
  preview, Send, 5 s undo; work-items; recent feed), **Activity** (live runs across
  tiers, pull-to-refresh, tap → run console), **Approvals** (HITL answers, PR
  approvals, escalations, blocked runs, pending memory lessons; swipe approve/reject;
  full confirm-card + biometric **only on escalation**), **Settings** (connection +
  trust indicator + re-pair, paired-devices + revoke, per-event notification toggles,
  biometric toggle).
- **Run console** — drill-in: structured commands / file diffs / delegated sub-agents,
  the `ctx X/Y·Z%` pressure meter, the HITL answer box, End session / Compact.
- **Notifications** — depict the in-app push banner with deep-link quick actions
  (Approve / Reject / Answer); the delivery model is native FCM + APNs via a thin
  relay (design intent — the native wiring is out of scope for the mockup).

**Out of scope (stay on the desktop deck):** 3D knowledge graph, web terminal,
charter/skills/MCP editors, deep Metrics/Routing analytics. Chief/Org and Projects
companion surfaces are deferred to a later companion version.

## Workflow

### 1. Confirm the surface

Re-read this design contract and the source of truth for the look:

- **Design language** — bible §08 (warmed vivid-midnight-glass tokens) and the live
  token values in `web/src/index.css` `:root`.
- **Structural reference** — `artifacts/ui-demo.html` (the web demo) for shared
  utilities (`.glass`, `.pill`, `.btn`, `.toggle`, SVG symbol sprite) and
  `artifacts/mobile-ui-demo.html` (this artifact) for the mobile shell.

### 2. Author the self-contained, full-bleed HTML

Write one HTML document where **the page is the phone viewport**:

- A centered **~430px column** (`max-width`) on the midnight backdrop; full-bleed on a
  real phone, a framed column inside the desktop iframe (`@media (min-width:460px)`
  rounds the corners and caps height).
- A faux **status bar** at top and the app's **bottom tab bar** at bottom; respect
  **safe-area insets** (`env(safe-area-inset-*)`).
- Mobile-native patterns: bottom **sheets** for confirm-cards, **swipe actions** on
  approval rows (pointer events), **pull-to-refresh**, large tap targets.
- A small **meta "DEMO" strip** above the device to reach the pairing flow, simulate a
  push, and cycle connection state — clearly distinct from the product chrome.
- Reuse the **exact** token palette from `ui-demo.html`; keep accent **FILLS using
  dark `--ink` text** (the §08 WCAG rule); reserve glass for hero surfaces.
- Gate **all** animation behind `@media (prefers-reduced-motion: reduce)`.
- All interactivity in one small inline IIFE — no frameworks, no external scripts.

### 3. Store / compile it as an artifact

The minimal, always-valid path is the file itself: `artifacts/mobile-ui-demo.html`
(self-contained, committed as a generated demo).

To make it a **first-class compiled artifact** like the web `ui-demo`, add a
`mobileDemoHtml()` generator + a `mobile-ui-demo` slug to `core/src/ui-artifact.ts`
and a trusted server compile path (mirroring `compileUiArtifact` / `uiDemoHtml()`).
**Never** widen the `/api/ui-artifact/compile` route to accept caller-supplied HTML —
that path writes to disk unsanitized; the route stays input-restricted, and bespoke
HTML lands through the trusted server seam only.

### 4. Verify it rendered

- Open `artifacts/mobile-ui-demo.html` directly from `file://` with the **network
  off** — it must render and respond to taps.
- In the **K dashboard → Artifacts**, open it in a sandboxed iframe (`allow-scripts`,
  no `allow-same-origin`): pairing flow, tab switching, swipe-to-approve, the
  escalation confirm sheet, the push banner, and the connection cycle must all work.

## Self-check before "done"

- Exactly **one** inline `<style>` and **one** inline `<script>`.
- No `http(s)://…(.css|.js)` references, no `<link href>` to remote resources, no web
  fonts, no `fetch`/`XMLHttpRequest`, no `localStorage`/cookies/same-origin reliance.
- Works from `file://` offline; sandbox-safe under `allow-scripts` only.
- `prefers-reduced-motion` honored; WCAG-AA contrast (dark text on blush fills).
- Renders correctly both as a **narrow phone column** and inside a **wide desktop
  iframe**; every screen (pair → tabs → run console) is reachable.

## Notes

- Slug: `mobile-ui-demo` (namespaced apart from the global web `ui-demo` and the
  per-project `project-<id>-ui-demo`).
- The compiled `.html` is the artifact — edit the generator/source, never the on-disk
  compiled output by hand.
- Companion design model: `artifacts/mobile-ui-demo.html` is the living mockup;
  connection/auth/push details follow bible §11 (remote access) and §08 (dashboard UX).
