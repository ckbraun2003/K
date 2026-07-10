/**
 * K desktop — Electron main process.
 *
 * Lifecycle: pick a free loopback port → spawn the bundled core (a NODE child, not
 * Electron's runtime — see core-launcher ABI note) with a per-user data dir + the
 * bundled web SPA → health-poll /health → read core's generated token → open a
 * window on the same-origin app and hand the token to the preload over IPC. On quit
 * the core process tree is killed so no orphan survives.
 *
 * Security posture: core binds loopback only; the window loads ONLY the local core
 * origin (navigation + window.open to anything else is denied); the renderer runs
 * with contextIsolation + sandbox + no nodeIntegration; a strict CSP is applied to
 * the core's responses. The token rides IPC, never argv or the URL.
 *
 * The window closes to a system tray, and a `ws` subscriber to core's /ws gateway
 * raises native notifications for run-lifecycle events while the window is hidden.
 */
import { app, BrowserWindow, ipcMain, dialog, shell, session, Tray, Menu, Notification, nativeImage } from 'electron'
import { autoUpdater } from 'electron-updater'
import { spawn, type ChildProcess } from 'node:child_process'
import WebSocket from 'ws'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import {
  pickFreePort,
  buildCoreEnv,
  coreEntryPath,
  webDistPath,
  readToken,
  buildDesktopConfig,
  isAllowedNavigation,
  sanitizeExternalTarget,
} from './core-launcher'
import { notificationFromEnvelope, buildTrayMenu, coreWsUrl } from './notifications'

const isDev = !app.isPackaged

let coreProc: ChildProcess | null = null
let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let wsClient: WebSocket | null = null
let wsReconnectTimer: NodeJS.Timeout | null = null
let isQuitting = false
let harnessToken = ''
let corePort = 0

/** Absolute path to the bundled app icon (window + tray + notifications). */
function iconPath(): string {
  return path.join(__dirname, '..', 'assets', 'icon.png')
}

/** Resources root holding core/dist + web/dist. Dev: repo root (two up from
 *  desktop/dist/main.js). Packaged: process.resourcesPath (Wave 5 stages them there). */
function resourcesRoot(): string {
  return isDev ? path.resolve(__dirname, '..', '..') : process.resourcesPath
}

function coreDataDir(): string {
  return path.join(app.getPath('userData'), 'data')
}

/** Writable repo-root for the packaged app (K_REPO_ROOT). The install is read-only,
 *  so core's writable repo-relative paths (.worktrees / artifacts / workspace) are
 *  redirected here, under the per-user data dir. Dev: undefined → core keeps its
 *  in-repo default (see core/src/supervisor.ts REPO_ROOT). */
function runtimeRepoRoot(): string | undefined {
  return isDev ? undefined : path.join(app.getPath('userData'), 'runtime')
}

/**
 * Seed the writable runtime with the read-only assets core reads from K_REPO_ROOT.
 * Only the bible SOURCE is repo-root-relative on the read path (core compiles it from
 * `<K_REPO_ROOT>/artifacts/bible`); agent-config stays read `__dirname`-relative from
 * `<resources>/agent-config`, so it is NOT seeded. Idempotent + versioned: re-seed
 * only when the marker is missing or the app version changed (so an upgrade refreshes
 * the bundled sections), never clobbering a user's runtime on every launch.
 */
function seedRuntime(resourcesDir: string, runtimeDir: string): void {
  const bibleSrc = path.join(resourcesDir, 'artifacts', 'bible')
  const bibleDest = path.join(runtimeDir, 'artifacts', 'bible')
  const markerPath = path.join(runtimeDir, '.seed-version')
  const version = app.getVersion()
  let seeded = ''
  try {
    seeded = fs.readFileSync(markerPath, 'utf8').trim()
  } catch {
    /* first run — marker absent */
  }
  if (seeded === version && fs.existsSync(bibleDest)) return
  fs.mkdirSync(path.dirname(bibleDest), { recursive: true })
  // Refresh the seeded copy wholesale so a removed/renamed section can't linger.
  fs.rmSync(bibleDest, { recursive: true, force: true })
  fs.cpSync(bibleSrc, bibleDest, { recursive: true })
  fs.writeFileSync(markerPath, version)
  console.log(`[seed] bible seeded into runtime (${version}) → ${bibleDest}`)
}

/** Poll GET /health (auth-exempt) until the core is ready or the deadline passes. */
async function waitForHealth(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 1500 }, (res) => {
        res.resume()
        resolve(res.statusCode === 200)
      })
      req.on('error', () => resolve(false))
      req.on('timeout', () => {
        req.destroy()
        resolve(false)
      })
    })
    if (ok) return true
    await new Promise((r) => setTimeout(r, 400))
  }
  return false
}

async function startCore(): Promise<void> {
  corePort = await pickFreePort()
  const dataDir = coreDataDir()
  fs.mkdirSync(dataDir, { recursive: true })
  const root = resourcesRoot()
  const repoRoot = runtimeRepoRoot()
  // Packaged install is read-only: seed the writable runtime with the bible source so
  // core (pointed there via K_REPO_ROOT) can compile + serve it. Dev: no repoRoot, no seed.
  if (repoRoot) {
    fs.mkdirSync(repoRoot, { recursive: true })
    seedRuntime(root, repoRoot)
  }
  const env = buildCoreEnv({ port: corePort, dataDir, webDist: webDistPath(root), repoRoot })
  const entry = coreEntryPath(root)

  // Node-20/ABI-115 runtime, NOT Electron's (ABI 130). Dev: system `node`. Packaged:
  // the bundled Node-20 runtime at <resources>/node/node.exe. An explicit K_NODE_BIN
  // env override wins in either case (CI / debugging). The seam is one env var.
  const bundledNode = isDev ? undefined : path.join(process.resourcesPath, 'node', 'node.exe')
  const nodeBin = process.env.K_NODE_BIN || bundledNode || 'node'
  const proc = spawn(nodeBin, [entry], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  coreProc = proc
  proc.stdout?.on('data', (d: Buffer) => process.stdout.write(`[core] ${d}`))
  proc.stderr?.on('data', (d: Buffer) => process.stderr.write(`[core] ${d}`))
  proc.on('exit', (code) => {
    console.log(`[core] exited with ${code}`)
    // Only clear the ref if THIS instance is still the current one (forward-safe if
    // a future wave adds a restart: a late exit from an old proc won't null a new one).
    if (coreProc === proc) coreProc = null
  })

  // A spawn that can't launch the binary ('node' not on PATH / bad K_NODE_BIN) emits
  // 'error' on a LATER tick — with no listener Node would re-throw it as an uncaught
  // exception OUTSIDE this promise, and 'exit' never fires, so the health poll would
  // hang the full timeout. Race the health-wait against spawn failure / early exit so
  // the real reason surfaces immediately and the caller's catch shows the error dialog.
  const failure = new Promise<never>((_resolve, reject) => {
    proc.once('error', (err) => reject(new Error(`failed to launch core (${nodeBin}): ${err.message}`)))
    proc.once('exit', (code) => reject(new Error(`core exited (code ${code}) before becoming healthy`)))
  })
  const healthy = await Promise.race([waitForHealth(corePort, 30_000), failure])
  if (!healthy) {
    throw new Error('core did not become healthy within 30s')
  }
  harnessToken = readToken(dataDir)
}

/** Open an external URL in the OS browser ONLY if it survives sanitization
 *  (allowlisted host, no query/fragment/credentials) — so a script-crafted URL
 *  can't smuggle the bearer token out. A refused URL is dropped silently. */
function openExternalSafely(url: string): void {
  const safe = sanitizeExternalTarget(url)
  if (safe) void shell.openExternal(safe)
}

/** Restrict the renderer to the core's own loopback origin; allowlisted external
 *  links open in the OS browser, everything else is denied. Covers new windows,
 *  in-app navigation, AND server-side redirects. */
function hardenWindow(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!isAllowedNavigation(url, corePort)) {
      e.preventDefault()
      openExternalSafely(url)
    }
  })
  // A server-side HTTP redirect is a distinct event from will-navigate — guard it too.
  win.webContents.on('will-redirect', (e, url) => {
    if (!isAllowedNavigation(url, corePort)) e.preventDefault()
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    backgroundColor: '#0b0e14',
    autoHideMenuBar: true,
    icon: iconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  hardenWindow(mainWindow)
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  void mainWindow.loadURL(`http://127.0.0.1:${corePort}/`)
  // Close-to-tray: the window hides instead of quitting the app (agent runs keep
  // going in the background). Real quit goes through the tray or before-quit, which
  // set isQuitting first.
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      mainWindow?.hide()
    }
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

/** Show + focus the window (from the tray or a notification click). */
function showWindow(): void {
  if (!mainWindow) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/** System tray: click toggles the window; the menu offers Show/Hide + Quit. */
function createTray(): void {
  const img = nativeImage.createFromPath(iconPath()).resize({ width: 16, height: 16 })
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img)
  tray.setToolTip('K — Agentic Harness')
  const refreshMenu = () => {
    const visible = !!mainWindow?.isVisible()
    const template = buildTrayMenu(visible).map((item) => ({
      label: item.label,
      click: () => {
        if (item.action === 'quit') {
          isQuitting = true
          app.quit()
        } else {
          visible ? mainWindow?.hide() : showWindow()
        }
      },
    }))
    tray?.setContextMenu(Menu.buildFromTemplate(template))
  }
  refreshMenu()
  tray.on('click', () => (mainWindow?.isVisible() ? mainWindow.focus() : showWindow()))
  // Keep the menu's Show/Hide label in sync with the window state.
  const sync = () => refreshMenu()
  app.on('browser-window-focus', sync)
  app.on('browser-window-blur', sync)
}

/** Subscribe to core's /ws as another client and raise native notifications for the
 *  run-lifecycle transitions worth interrupting for. No core change — the gateway
 *  already broadcasts every update. Reconnects if the socket drops. */
function startNotifications(): void {
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer)
    wsReconnectTimer = null
  }
  const ws = new WebSocket(coreWsUrl(corePort, harnessToken))
  wsClient = ws
  ws.on('open', () => console.log('[notify] connected to core event stream'))
  ws.on('message', (data) => {
    let msg: unknown
    try {
      msg = JSON.parse(data.toString())
    } catch {
      return
    }
    const n = notificationFromEnvelope(msg)
    if (!n || !Notification.isSupported()) return
    // Mirror E-19's foreground rule: only raise a native toast when the app isn't in
    // the foreground (the in-app notification center owns the foreground).
    if (mainWindow?.isVisible() && mainWindow.isFocused()) return
    const notice = new Notification({ title: n.title, body: n.body, icon: iconPath() })
    notice.on('click', showWindow)
    notice.show()
  })
  ws.on('close', () => {
    if (wsClient === ws) wsClient = null
    // Reconnect while the app is alive (core outlives the socket). Fixed 3s is fine on
    // loopback — core is local and comes back fast; no exponential backoff needed.
    if (!isQuitting && !wsReconnectTimer) {
      wsReconnectTimer = setTimeout(startNotifications, 3000)
    }
  })
  ws.on('error', () => {
    try {
      ws.close()
    } catch {
      /* already closing */
    }
  })
}

/** CSP for the core's own responses — the SPA needs inline styles (Tailwind/Framer)
 *  + data: fonts/images, and connects same-origin over http/ws. connect-src is
 *  pinned to core's ACTUAL port (not any loopback port) to minimize the
 *  localhost-pivot surface if the renderer is ever compromised. No remote origins. */
function applyCsp(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    const origin = `http://127.0.0.1:${corePort}`
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; " +
            `connect-src 'self' ${origin} ws://127.0.0.1:${corePort}; ` +
            "style-src 'self' 'unsafe-inline'; " +
            "img-src 'self' data: blob:; " +
            "font-src 'self' data:; " +
            "script-src 'self'; " +
            "worker-src 'self' blob:",
        ],
      },
    })
  })
}

/** Check GitHub Releases for a newer build and, if found, download it + notify the
 *  user (electron-updater shows a native toast and installs on next quit — no custom
 *  UI). Packaged-only (dev has no update feed) and best-effort: any failure (offline,
 *  no release, unsigned-build quirk) is logged, never fatal.
 *
 *  TRUST MODEL (unsigned build, by design): the feed (owner/repo) is hardcoded at
 *  build time in electron-builder.yml — not runtime/attacker-influenceable — and
 *  electron-updater verifies the installer's sha512 against latest.yml. But because
 *  the build is unsigned, latest.yml itself is trusted only via HTTPS-to-GitHub;
 *  anyone able to publish a Release on the source repo could ship a matching-hash
 *  malicious build. Protecting that GitHub account/Actions pipeline (2FA, branch
 *  protection, no direct-push releases) IS the update channel's security perimeter.
 *  Documented in the bible + README. */
function checkForUpdates(): void {
  if (!app.isPackaged) return
  try {
    autoUpdater.autoDownload = true
    autoUpdater.on('error', (err) => console.warn('[updater] check failed:', err?.message ?? err))
    // checkForUpdatesAndNotify returns a promise that can reject INDEPENDENTLY of the
    // 'error' listener (missing app-update.yml, network/GitHub errors) — catch it so a
    // routine offline launch can never surface as an unhandled rejection / crash.
    autoUpdater
      .checkForUpdatesAndNotify()
      .catch((err) => console.warn('[updater] check failed:', err?.message ?? err))
  } catch (err) {
    console.warn('[updater] could not start update check:', err)
  }
}

/** Kill the core process tree so quitting never leaves an orphan node.exe. */
function killCore(): void {
  const proc = coreProc
  if (!proc || proc.killed) return
  coreProc = null
  try {
    if (process.platform === 'win32' && proc.pid) {
      // Kill the whole tree (/T) so no orphan node.exe survives. Fire-and-forget,
      // but attach an error listener so a missing taskkill can't throw as an
      // unhandled EventEmitter 'error'.
      const tk = spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true })
      tk.on('error', () => proc.kill())
    } else {
      proc.kill('SIGTERM')
    }
  } catch {
    /* best-effort */
  }
}

/** Tear down the shell's own resources (WS subscriber, reconnect timer, tray) on quit. */
function teardownShell(): void {
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer)
    wsReconnectTimer = null
  }
  try {
    wsClient?.close()
  } catch {
    /* already closing */
  }
  wsClient = null
  tray?.destroy()
  tray = null
}

// Synchronous config handoff for the preload (before page scripts). Token only —
// the port is already in the same-origin window URL; the token stays off argv/URL.
ipcMain.on('k:config:sync', (e) => {
  e.returnValue = buildDesktopConfig(harnessToken)
})

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  // A second launch focuses the running app (restoring it from the tray if hidden).
  app.on('second-instance', () => showWindow())

  // Windows toast notifications need a stable AppUserModelID or they show as
  // "electron.app.…" / may not display. Set it before any Notification.
  app.setAppUserModelId('com.k.desktop')

  app.whenReady().then(async () => {
    applyCsp()
    try {
      await startCore()
      createWindow()
      createTray()
      startNotifications()
      // Auto-update runs only for a packaged build, after the window is up so a
      // download never blocks first paint. Best-effort — see checkForUpdates.
      checkForUpdates()
    } catch (err) {
      console.error('[main] core failed to start:', err)
      dialog.showErrorBox(
        'K failed to start',
        'The K core service did not become ready.\n\n' +
          'Make sure Node.js is installed and on your PATH (see the app’s System requirements), ' +
          'then relaunch K.',
      )
      app.quit()
    }
  })

  // The window closes to the tray (see createWindow), so the app stays alive with no
  // window — do NOT quit on window-all-closed. Quitting goes through the tray's Quit
  // or before-quit, which set isQuitting first.
  app.on('before-quit', () => {
    isQuitting = true
    killCore()
    teardownShell()
  })
  app.on('will-quit', killCore)
  process.on('exit', killCore)
}
