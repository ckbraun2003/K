---
title: Desktop App
icon: "▣"
status: stable
updated: 2026-07-10
---

The K web app — `@k/core` (Fastify + better-sqlite3 + node-pty) and the `@k/web` React SPA — is packaged as a **Windows Electron desktop app** in a `desktop/` workspace. The shell owns nothing product-facing: it launches the *existing* core, opens the *existing* SPA on one origin, and adds the three things a desktop app buys that a browser tab cannot — a persistent tray process, native notifications, and one-click install + auto-update. The build ships Windows-first and **unsigned**; the `claude` CLI (the agent engine) is a detect-and-guide prerequisite, never bundled. Decisions D-089 → D-094.

## Architecture

The shell is a thin supervisor. It picks a free loopback port, spawns core as an ordinary **Node child process** (not Electron's runtime — see the ABI note), waits for `/health`, reads the token core wrote to disk, opens a `BrowserWindow` on the same-origin app, and hands the token to a sandboxed preload over IPC. On quit it kills the core process tree so no `node.exe` orphans.

```
                         Electron main process (desktop/src/main.ts)
                         ── picks free loopback port, owns lifecycle ──
                                          │
        ┌─────────────────────────────────┼──────────────────────────────────┐
        │                                 │                                   │
   spawn() a NODE child             BrowserWindow                        ws subscriber
   (bundled Node-20, NOT       loads http://127.0.0.1:<port>/       (another /ws client)
    Electron's runtime)          ├─ preload.ts (sandbox,                     │
        │                        │   contextIsolation)                consumes E-19
        ▼                        │   ── IPC k:config:sync ──►         notification
  ┌───────────────┐              │   seeds sessionStorage             envelopes
  │  @k/core       │◄────────────┘   ['k.harnessToken']                   │
  │  Fastify on    │  same origin:                                        ▼
  │  127.0.0.1     │  relative /api (bearer) + /ws (query-token)   native OS toast
  │  serves        │  no CORS, no cross-port wiring                (window hidden only)
  │  web/dist via  │
  │  @fastify/     │           System tray ── Show/Hide/Quit, close-to-tray
  │  static (W1)   │
  └───────┬───────┘           electron-updater ──► GitHub Releases (latest.yml + sha512)
          │
   spawns claude / git / gh / npx gitnexus  (host prerequisites — doctor-checked, not bundled)
```

**Why core is a Node child, not Electron's runtime (the make-or-break decision).** Electron 38's bundled Node reports **ABI 130**; core's `better-sqlite3` prebuild is compiled for Node 20's **ABI 115**. Running core inside Electron's runtime would demand `electron-rebuild` of every native module — which also mis-walks the shared pnpm store — and would fork core's natives (and its whole test suite) onto a second ABI. Instead the shell `spawn()`s core under a **Node-20 runtime** (the system `node` in dev; a **bundled Node-20** at `<resources>/node/node.exe` in the packaged app), so core keeps exactly the ABI-115 binaries and tests it already has. The runtime is one seam: `K_NODE_BIN` overrides it in either mode. Electron is pinned to **38.8.6** — a CVE-current line that installs cleanly under pnpm (43 broke on `@electron/get@5`'s ESM postinstall).

## Same-origin serving (W1)

Core serves the built SPA itself when `K_WEB_DIST` points at a `web/dist` that actually contains `index.html` (`core/src/web-static.ts::resolveWebDist`, via `@fastify/static` with an SPA fallback). The packaged app is therefore **one origin**: the browser loads the bundle from core, the client's relative `/api` and `window.location`-based `/ws` just work, and there is no CORS or build-frozen port. There is no filesystem auto-detection — serving is triggered *only* by the explicit env var, so core's tests never flip into static-serving mode because a stray `web/dist` sits on disk.

The security line is unchanged from Vite serving the bundle: the **SPA bundle is public** (a prod `vite build` bakes no token), and the **data plane stays gated** — every `/api/*` route is bearer-checked and `/ws*` is query-token-checked. The auth hook exempts only public read (`GET`/`HEAD`) asset paths that are *not* under `/api` or `/ws` (`isPublicAssetPath`). A latent build bug was fixed on the way: core now emits a flat `dist/index.js` (a `core/tsconfig.build.json` resolves `@k/shared` to its built `.d.ts`), guarded by `scripts/check-dist-layout.mjs`.

## Token handoff + auto-auth

Core generates a strong bearer token on first run and persists it to `<dataDir>/auth-token`. The shell forces `HARNESS_TOKEN=''` in the child env (core owns the token; the shell never injects one) and sets `K_SUPPRESS_TOKEN_PRINT=1` so core skips its first-run token banner. After `/health` passes, the shell reads the token from disk and holds it in the main process.

When the window loads, the **sandboxed preload** (`desktop/src/preload.ts`, `contextIsolation` + `sandbox`, no Node in the page) asks main for the token over a **synchronous** IPC (`k:config:sync`) — synchronous so it lands before the SPA's first API call — and seeds it into `sessionStorage['k.harnessToken']`, the exact key `web/src/lib/auth.ts` reads. The same-origin SPA then **auto-authenticates with no login screen**. The token rides IPC only — never argv, never the URL — and the whole path is best-effort: if anything throws, the SPA falls back to its normal login screen. The preload also exposes a read-only `window.__K_DESKTOP__` flag so the web knows it is inside the shell (see Notifications). No core auth change was needed.

## First-run robustness

Three details keep the first launch from failing confusingly:

- **Clean app identity.** The shell calls `app.setName('K')` before any `app.getPath('userData')` (and before the single-instance lock), so per-user data lives at `%APPDATA%\K`. Without it, Electron derives the name from the scoped package name `@k/desktop` and data lands under the ugly `%APPDATA%\@k\desktop` (the `productName: K` in `electron-builder.yml` is a build-time field the runtime never reads).
- **Cold-start grace.** A cold first launch is slow — core seeds skills/profiles/workflows and compiles the bible while Windows Defender scans the freshly-installed files — so the `/health` wait is **90s** (`CORE_HEALTH_TIMEOUT_MS`), not 30s. The spawn-error / early-exit race still rejects **immediately** on a genuinely broken core, so the longer timeout only covers the alive-but-slow case, never a real crash.
- **Honest failure diagnostics.** Core's stdout/stderr are captured to a per-launch `<userData>/logs/core.log` (via a WriteStream with an `error` listener, so a locked/full log file can never crash the app) and the last lines are kept in a ring buffer. If core never becomes healthy, the error dialog shows the **real** thrown reason + that output tail + the log path — it no longer blames the user's PATH (a red herring, since the packaged app spawns its own bundled Node, not PATH Node). `K_SUPPRESS_TOKEN_PRINT=1` means only the token's masked suffix is ever written, so the log and dialog never carry the secret.

## System doctor (W2)

`GET /api/system/doctor` (`core/src/system-doctor.ts`) probes the host tools K depends on and a Settings **"System requirements"** card renders the result. Required: `claude`, `git`, `node`. Optional: `gh`, `ollama` (K degrades gracefully without them). Each tool is checked with a short-timeout `--version` call; ENOENT / non-zero exit / timeout all collapse to "absent" — a missing tool is *data*, never an error — and the report is `ok` iff every required tool is present. A pure `buildDoctorReport` builder keeps the shape unit-testable without depending on what CI has installed; results are TTL-cached so polling doesn't respawn processes.

**Why `claude` is not bundled.** The `claude` CLI *is* the agent engine, and it is **not redistributable**. So the app detects it and guides installation + authentication (with the official install URL) rather than shipping it. `node` stays a listed prerequisite even though core is bundled — the `claude` CLI and `npx gitnexus` both need a host Node, and it is the doctor-checked runtime.

## Tray + notifications

The window **closes to the system tray** rather than quitting (agent runs keep going in the background); the tray menu offers Show/Hide/Quit, and real quit sets an `isQuitting` flag first so `before-quit` can kill core. Because the main process stays alive with the window hidden, the shell is the right place to raise notifications a browser tab could not.

Notifications are **coordinated with E-19**, not reinvented. The shell subscribes to core's `/ws` as just another client and reads core's existing `type:'notification'` envelopes — which have **already** applied the operator's per-event rules and deduped on status transition (`core/src/notify.ts`). It raises a native OS toast only when the envelope's resolved `browser` channel is on **and** the window is hidden/unfocused (mirroring E-19's foreground rule — the in-app center owns the foreground). To avoid double toasts, the **desktop shell is the single native-notification authority**: the renderer's browser-notification leg stands down when it sees `window.__K_DESKTOP__` (`web/src/lib/notifications`). Windows toasts render under a stable AppUserModelID `com.k.desktop` (set before any notification, and backed by the installer's Start-Menu shortcut).

## Relocatability (W5)

A packaged install is **read-only**, but core writes to several repo-relative paths (`.worktrees`, artifacts, workspace). So `REPO_ROOT` / `ARTIFACTS_DIR` / `WORKSPACE_DIR` honor a **`K_REPO_ROOT`** env override, and the desktop shell points it at a **writable `<userData>/runtime`**. On first run (and after a version change) the shell **seeds** that runtime with the bundled bible source so core can compile and serve it; the seed is idempotent and versioned (an upgrade refreshes the sections without clobbering the user's runtime on every launch). Read-only **agent-config** is the deliberate exception: it stays read `__dirname`-relative to the bundled `<resources>/agent-config` (including `skills.ts` / `skill-creator.ts`, repointed off `REPO_ROOT`), so it is never seeded into the writable runtime. In dev `K_REPO_ROOT` is unset and core keeps its in-repo default.

## Packaging, build, release, and update

`desktop/scripts/prepackage.mjs` stages a portable core into `desktop/staging/` via **`pnpm deploy --config.node-linker=hoisted --config.inject-workspace-packages=true`** — pnpm's *injected* deploy, **not** `--legacy` (legacy re-resolves from scratch, ignores the lockfile, and drifts `htmlparser2`/`sanitize-html` to an ESM build core then can't `require()`, crashing it at boot). Alongside the deployed core it stages the built SPA (`web/dist`), read-only `agent-config`, the bible source, and a **bundled Node-20** runtime (`K_BUNDLE_NODE` wins, else the current runtime iff it is Node 20, else a hard error — the ABI must be right).

`electron-builder.yml` then builds a **per-user NSIS installer** (desktop + Start-Menu shortcuts — the shortcut is what lets Windows toasts render under `com.k.desktop`) with `npmRebuild: false` (the Electron main process uses no native modules; the natives live in the staged core under Node-20). Resources land at `<resources>/{core, web/dist, agent-config, artifacts/bible, node/node.exe}`, which `main.ts::resourcesRoot()` resolves via `process.resourcesPath`.

Scripts (note: a bare `pnpm pack` hits pnpm's builtin tarball command — always use `run`):

- `pnpm --filter @k/desktop run pack` — prepackage + `electron-builder --dir` (unpacked app dir; the CI smoke).
- `pnpm --filter @k/desktop run dist` — prepackage + full NSIS build → `K Setup <version>.exe` + `latest.yml`.

**VERIFIED:** the packaged `K.exe` boots core, serves loopback (`/health` + `/` → 200), and leaves **0 orphans**; `dist` produces `K Setup 0.0.1.exe` + `latest.yml`.

**CI / release (W6).** `ci.yml` gained a `desktop-build` job (windows-latest, on main + PRs) running `run pack`. A new `release.yml` triggers on `v*` tags, builds the NSIS installer, and publishes it **plus `latest.yml`** to a GitHub Release. `latest.yml` is the electron-updater feed: on launch the packaged app calls `checkForUpdatesAndNotify`, which compares versions, downloads a newer installer, verifies its **sha512** against `latest.yml`, and installs on next quit (best-effort — offline / no-release / unsigned quirks are logged, never fatal).

## Trust model + caveats

Be honest about what this build is and isn't:

- **Windows-only, unsigned.** No code-signing certificate, so the first install shows a **SmartScreen / Defender** warning (accepted; "More info → Run anyway").
- **The auto-update trust anchor is HTTPS-to-GitHub plus the sha512 in `latest.yml` — there is NO signature backstop.** The feed's owner/repo is hardcoded at build time (not attacker-influenceable at runtime), and the sha512 pins the exact bytes, but an unsigned build cannot prove *who* built them. Therefore **whoever can publish a Release on `ckbraun2003/K` controls the update channel**. Locking that pipeline down — 2FA, branch protection, no direct-push releases — **is** the update channel's security perimeter.
- **Node 20 is a prerequisite even though core is bundled.** The bundled Node runs core, but the `claude` CLI and `npx gitnexus` still need a host Node, and it is the doctor-checked runtime.
- **Accepted limitation — unscoped K-self runs.** In the packaged app, an unscoped **K-self** run (no project selected) executes in the non-git writable runtime dir, so it runs **without worktree isolation or the plan gate**. Scoped runs on registered projects are unaffected (they run in their own repo worktrees). This is a known, accepted edge, not a regression of the project-run path.

## Key files

| File | Role |
|------|------|
| `desktop/src/main.ts` | Electron main: lifecycle, spawn core, window hardening, tray, updater, kill-tree |
| `desktop/src/preload.ts` | Sandboxed preload: sync-IPC token → `sessionStorage`, `__K_DESKTOP__` flag |
| `desktop/src/core-launcher.ts` | Pure helpers: free port, child env (`K_WEB_DIST`/`K_REPO_ROOT`/`K_NODE_BIN`/token), nav allowlist |
| `desktop/src/notifications.ts` | Pure E-19-envelope → native-toast decision + tray menu + `/ws` URL |
| `desktop/scripts/prepackage.mjs` | Stage portable core (pnpm injected deploy) + Node-20 + web/dist + agent-config + bible |
| `desktop/electron-builder.yml` | NSIS build config, extraResources layout, GitHub publish |
| `core/src/web-static.ts` | Same-origin serving: `resolveWebDist`, `isPublicAssetPath` |
| `core/src/system-doctor.ts` | Host prerequisite detection (`GET /api/system/doctor`) |
