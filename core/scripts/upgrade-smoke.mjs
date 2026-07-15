/**
 * Upgrade-path smoke gate (F2).
 *
 * Fresh-DB smokes (e.g. `pnpm dev` against an empty data dir) can never see
 * upgrade breakage — the DB never had a chance to be stamped by an OLDER or
 * poisoned schema version. This gate boots the CURRENT merged core against a
 * COPY of a REAL dev DB (whatever version/state it's actually in) and proves
 * the server comes up and serves traffic. This is the gate that would have
 * caught the 2026-07-13 outage (a poisoned schema stamp) pre-merge.
 *
 * Usage: node core/scripts/upgrade-smoke.mjs [path-to-db]   (default: repo data/k.db)
 *
 * The source DB is only ever COPIED — never opened directly, never modified.
 */
import { execa } from 'execa'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url)) // core/scripts
const coreDir = path.resolve(here, '..') // core/
const repoRoot = path.resolve(coreDir, '..')

const sourcePath = path.resolve(process.argv[2] ?? path.join(repoRoot, 'data', 'k.db'))
// DEH-FU-2: overridable so a busy 3299 (parallel smoke, stray dev core) isn't a
// mystery boot failure — see the EADDRINUSE hint below.
const PORT = Number(process.env.K_SMOKE_PORT ?? 3299)
const BASE_URL = `http://127.0.0.1:${PORT}`
const AUTH_HEADER = { Authorization: 'Bearer dev-token-change-me' }
const POISON_WARN = 'poisoned stamp; re-running the full migration scan'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function fail(message) {
  console.error(message)
  console.error('UPGRADE SMOKE FAIL')
  process.exitCode = 1
}

async function main() {
  if (!fs.existsSync(sourcePath)) {
    fail(`[upgrade-smoke] source DB not found: ${sourcePath}`)
    return
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `k-upgrade-smoke-${process.pid}-`))
  const destPath = path.join(tmpDir, 'k.db')

  try {
    // 1. Copy the DB + sidecars (if present) into the fresh temp dir, renamed to k.db*
    fs.copyFileSync(sourcePath, destPath)
    for (const ext of ['-wal', '-shm']) {
      const sidecar = sourcePath + ext
      if (fs.existsSync(sidecar)) fs.copyFileSync(sidecar, destPath + ext)
    }

    // 2. Spawn the merged core against the temp copy on an unused port, with no
    // host-credential fallback (this is a smoke, not a real dev session).
    const proc = execa(
      process.execPath,
      ['--import', 'tsx', '--import', './dev-env.mjs', 'src/index.ts'],
      {
        cwd: coreDir,
        reject: false,
        env: {
          ...process.env,
          K_DATA_DIR: tmpDir,
          PORT: String(PORT),
          K_DISABLE_HOST_CREDENTIAL_FALLBACK: 'true',
          // Force dev-env.mjs's own default so the hardcoded Authorization
          // header above is correct regardless of the invoking shell's env.
          HARNESS_TOKEN: '',
        },
      },
    )

    let stdoutBuf = ''
    let stderrBuf = ''
    proc.stdout?.on('data', (chunk) => { stdoutBuf += chunk.toString('utf8') })
    proc.stderr?.on('data', (chunk) => { stderrBuf += chunk.toString('utf8') })

    let childDone = false
    proc.then(() => { childDone = true }).catch(() => { childDone = true })

    // 3. Poll /api/runs (30 x 1s)
    let up = false
    for (let attempt = 0; attempt < 30 && !childDone; attempt++) {
      try {
        const res = await fetch(`${BASE_URL}/api/runs`, { headers: AUTH_HEADER })
        if (res.status === 200) { up = true; break }
      } catch {
        // ECONNREFUSED while the server is still booting — expected, keep polling.
      }
      await sleep(1000)
    }

    let passed = false
    if (up) {
      // 4. Also GET /api/profiles; assert 200.
      try {
        const res = await fetch(`${BASE_URL}/api/profiles`, { headers: AUTH_HEADER })
        passed = res.status === 200
        if (!passed) stderrBuf += `\n[upgrade-smoke] GET /api/profiles returned ${res.status} (expected 200)\n`
      } catch (e) {
        stderrBuf += `\n[upgrade-smoke] GET /api/profiles failed: ${e}\n`
      }
    }

    // 6. Always kill the child (kill-tree — the process may have spawned
    // children of its own) before inspecting/removing the temp copy.
    if (proc.pid && !childDone) {
      if (process.platform === 'win32') {
        await execa('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { reject: false })
      } else {
        proc.kill('SIGKILL')
      }
    }
    await proc.catch(() => {}) // drain the promise; reject:false means it never throws
    await sleep(300) // let the OS release the DB file handles before we reopen it

    const sawSelfHealWarn = stdoutBuf.includes(POISON_WARN) || stderrBuf.includes(POISON_WARN)

    if (passed) {
      let version = 'unknown'
      try {
        const d = new Database(destPath)
        version = String(d.pragma('user_version', { simple: true }))
        d.close()
      } catch (e) {
        console.error(`[upgrade-smoke] warning: could not read user_version from the temp copy: ${e}`)
      }
      console.log(`UPGRADE SMOKE PASS (user_version=${version})`)
      if (sawSelfHealWarn) console.log('note: self-heal warn observed')
    } else {
      if (/EADDRINUSE/.test(stderrBuf)) {
        console.error(`[upgrade-smoke] port ${PORT} is already in use — a dev core is probably running. Stop it or set K_SMOKE_PORT to a free port.`)
      }
      console.error('[upgrade-smoke] server did not come up (or /api/profiles failed) — captured child stderr:')
      console.error(stderrBuf || '(empty stderr)')
      if (sawSelfHealWarn) console.log('note: self-heal warn observed')
      fail('[upgrade-smoke] the crash above is the finding')
    }
  } finally {
    // maxRetries: Windows can hold the copied DB open briefly after the kill (EBUSY).
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  }
}

// DEH-FU-2: every unexpected escape (e.g. a copyFileSync throw) must still end in
// the tidy FAIL line + exit 1 — never an unhandled rejection.
await main().catch((e) => {
  console.error(`[upgrade-smoke] unexpected failure: ${e?.stack ?? e}`)
  console.error('UPGRADE SMOKE FAIL')
  process.exitCode = 1
})
