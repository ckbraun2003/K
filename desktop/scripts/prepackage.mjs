/**
 * Prepackage (Wave 5) — stage everything electron-builder ships as `extraResources`
 * into desktop/staging/, so the packaged app carries a portable, ABI-115 core it runs
 * under a bundled Node-20 runtime (NOT Electron's ABI 130). Idempotent: staging/ is
 * wiped + rebuilt on every run.
 *
 * Layout produced (mirrors the packaged <resources>/ tree — see electron-builder.yml):
 *   staging/core/            ← pnpm-deploy output (dist + real node_modules + package.json)
 *   staging/web/dist/        ← built SPA (K_WEB_DIST points here)
 *   staging/agent-config/    ← read-only assets (core reads them __dirname-relative)
 *   staging/artifacts/bible/ ← bible SOURCE (the shell seeds it into the writable runtime)
 *   staging/node/node.exe    ← bundled Node-20 runtime (ABI 115); K_NODE_BIN points here
 *
 * Runs before electron-builder (see the desktop package.json `pack`/`dist` scripts).
 * By default it first runs `pnpm -w build` so the staged bits match source; pass
 * K_SKIP_BUILD=1 to reuse an existing build (outputs are then asserted, not rebuilt).
 * Node source is deterministic: K_BUNDLE_NODE (a Node-20 node.exe) wins, else the
 * current runtime iff it is Node 20, else a hard error.
 *
 * Deploy note: we use pnpm's INJECTED deploy (inject-workspace-packages) rather than
 * `--legacy`. Legacy deploy re-resolves from scratch and IGNORES the lockfile, which
 * drifts transitive deps to newer majors (e.g. htmlparser2 → ESM-only v12, which the
 * CJS sanitize-html then can't `require()` — core crashes at boot). Injected deploy
 * copies the exact lockfile-pinned graph, so the staged core matches the repo.
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pngToIco from 'png-to-ico'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = path.resolve(__dirname, '..')
const REPO_ROOT = path.resolve(DESKTOP_DIR, '..')
const STAGING = path.join(DESKTOP_DIR, 'staging')

const log = (msg) => console.log(`[prepackage] ${msg}`)
const fail = (msg) => {
  console.error(`[prepackage] ERROR: ${msg}`)
  process.exit(1)
}
const run = (cmd, cwd = REPO_ROOT) => {
  log(`$ ${cmd}`)
  execSync(cmd, { cwd, stdio: 'inherit' })
}
const assertExists = (p, label) => {
  if (!fs.existsSync(p)) fail(`${label} not found at ${p}`)
}
const copyDir = (src, dest, label) => {
  assertExists(src, label)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.cpSync(src, dest, { recursive: true })
  log(`copied ${label} → ${dest}`)
}

// ── 1. Workspace build (shared/core/web/desktop dist) ────────────────────────
// The staged core is deployed from core/dist, the SPA from web/dist, and the
// desktop main/preload from desktop/dist — all must be current.
const buildOutputs = [
  { p: path.join(REPO_ROOT, 'shared', 'dist', 'types.js'), label: 'shared build' },
  { p: path.join(REPO_ROOT, 'core', 'dist', 'index.js'), label: 'core build' },
  { p: path.join(REPO_ROOT, 'web', 'dist', 'index.html'), label: 'web build' },
  { p: path.join(DESKTOP_DIR, 'dist', 'main.js'), label: 'desktop build' },
]
if (process.env.K_SKIP_BUILD === '1') {
  log('K_SKIP_BUILD=1 → reusing existing workspace build')
} else {
  run('pnpm -w build')
}
for (const { p, label } of buildOutputs) assertExists(p, label)

// ── 2. Clean staging ─────────────────────────────────────────────────────────
log(`cleaning ${STAGING}`)
fs.rmSync(STAGING, { recursive: true, force: true })
fs.mkdirSync(STAGING, { recursive: true })

// ── 3. Deploy core → staging/core ────────────────────────────────────────────
// A PORTABLE, symlink-free core: real node_modules with the real better-sqlite3
// .node (ABI 115). Absolute target (pnpm deploy requires it). Injected deploy
// (inject-workspace-packages) copies the lockfile-pinned graph (see header note);
// hoisted keeps node_modules flat + symlink-free so extraResources copies cleanly.
const coreTarget = path.join(STAGING, 'core')
run(
  `pnpm --filter @k/core deploy --prod ` +
    `--config.node-linker=hoisted --config.inject-workspace-packages=true "${coreTarget}"`,
)
assertExists(path.join(coreTarget, 'dist', 'index.js'), 'deployed core entry')
assertExists(path.join(coreTarget, 'node_modules'), 'deployed core node_modules')
assertExists(path.join(coreTarget, 'node_modules', 'better-sqlite3'), 'deployed better-sqlite3')
const sqliteNode = path.join(coreTarget, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node')
if (fs.existsSync(sqliteNode)) log(`better-sqlite3 native present (ABI-bound .node) ✓`)
else log(`WARN: better-sqlite3 .node not at ${sqliteNode} — boot verification will confirm natives load`)

// ── 4. Copy read-only assets + SPA ───────────────────────────────────────────
copyDir(path.join(REPO_ROOT, 'web', 'dist'), path.join(STAGING, 'web', 'dist'), 'web/dist')
copyDir(path.join(REPO_ROOT, 'agent-config'), path.join(STAGING, 'agent-config'), 'agent-config')
copyDir(path.join(REPO_ROOT, 'artifacts', 'bible'), path.join(STAGING, 'artifacts', 'bible'), 'artifacts/bible')

// ── 5. Bundle a Node-20 runtime → staging/node/node.exe ──────────────────────
const nodeDest = path.join(STAGING, 'node', 'node.exe')
fs.mkdirSync(path.dirname(nodeDest), { recursive: true })
let nodeSrc
if (process.env.K_BUNDLE_NODE) {
  nodeSrc = path.resolve(process.env.K_BUNDLE_NODE)
  assertExists(nodeSrc, 'K_BUNDLE_NODE node.exe')
} else if (process.version.startsWith('v20')) {
  nodeSrc = process.execPath
} else {
  fail(
    `current runtime is ${process.version}, not Node 20 — set K_BUNDLE_NODE to a ` +
      `Node-20 node.exe (ABI 115) so the bundled runtime matches core's natives`,
  )
}
fs.copyFileSync(nodeSrc, nodeDest)
log(`bundled node runtime from ${nodeSrc} → ${nodeDest}`)

// ── 6. Generate assets/icon.ico from icon.png (electron-builder win.icon) ─────
const iconPng = path.join(DESKTOP_DIR, 'assets', 'icon.png')
const iconIco = path.join(DESKTOP_DIR, 'assets', 'icon.ico')
assertExists(iconPng, 'assets/icon.png')
const icoBuf = await pngToIco(iconPng)
fs.writeFileSync(iconIco, icoBuf)
log(`generated ${iconIco} (${icoBuf.length} bytes)`)

log('done — staging ready for electron-builder')
