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
 */
import { app, BrowserWindow, ipcMain, dialog, shell, session } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
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

const isDev = !app.isPackaged

let coreProc: ChildProcess | null = null
let mainWindow: BrowserWindow | null = null
let harnessToken = ''
let corePort = 0

/** Resources root holding core/dist + web/dist. Dev: repo root (two up from
 *  desktop/dist/main.js). Packaged: process.resourcesPath (Wave 5 stages them there). */
function resourcesRoot(): string {
  return isDev ? path.resolve(__dirname, '..', '..') : process.resourcesPath
}

function coreDataDir(): string {
  return path.join(app.getPath('userData'), 'data')
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
  const env = buildCoreEnv({ port: corePort, dataDir, webDist: webDistPath(root) })
  const entry = coreEntryPath(root)

  // Node-20/ABI-115 runtime, NOT Electron's (ABI 130). Dev: system `node`. Packaged:
  // K_NODE_BIN points at the bundled Node-20 runtime (Wave 5). The seam is one env var.
  const nodeBin = process.env.K_NODE_BIN || 'node'
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
  mainWindow.on('closed', () => {
    mainWindow = null
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

// Synchronous config handoff for the preload (before page scripts). Token only —
// the port is already in the same-origin window URL; the token stays off argv/URL.
ipcMain.on('k:config:sync', (e) => {
  e.returnValue = buildDesktopConfig(harnessToken)
})

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    applyCsp()
    try {
      await startCore()
      createWindow()
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

  // Wave 4 replaces this with close-to-tray; for now, closing the window quits.
  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', killCore)
  app.on('will-quit', killCore)
  process.on('exit', killCore)
}
