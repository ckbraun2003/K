/**
 * Single-instance lock (H1/H3) — one core process per DATA_DIR.
 *
 * Two core processes sharing the same DATA_DIR share one k.db, and BOTH run
 * `reconcileOnBoot()` at startup (index.ts). That sweep flips every `running`
 * run/activation to `interrupted`/`failed` and prunes worktrees — so a second
 * boot (a stray `pnpm dev`, a `node --watch` respawn racing the old process, a
 * duplicate stack) cross-kills the LIVE process's in-flight work and steals its
 * port. Observed live: autonomous Chief wakes interrupted at init with 0 tokens,
 * two wakes firing per cron tick.
 *
 * This lock makes the second boot REFUSE fast with a clear message instead. It is
 * scoped per DATA_DIR, so the e2e swarm (each stack gets its own K_DATA_DIR) and
 * an isolated smoke stack are unaffected — only a genuine same-DB collision is
 * blocked.
 *
 * Design: a `core.lock` file in DATA_DIR holds { pid, port, startedAt }. On boot
 * we read it; if a live process owns it we refuse; otherwise (missing, garbled,
 * or a DEAD pid — the common `node --watch` / crash case) we take it over. The
 * lock is best-effort advisory: an unwritable DATA_DIR degrades to "no lock"
 * (logged) rather than blocking boot, mirroring auth.ts's token-persistence
 * posture. Release deletes the file only if we still own it (never clobber a
 * successor that took over after a stale-lock reclaim).
 */

import fs from 'fs'
import path from 'path'

export interface LockInfo {
  pid: number
  port: number
  startedAt: number
}

export type AcquireResult =
  | { ok: true; release: () => void; file: string }
  | { ok: false; holder: LockInfo | null; file: string }

/** Lock file path for a DATA_DIR. */
export function lockFilePath(dataDir: string): string {
  return path.join(dataDir, 'core.lock')
}

/**
 * Is `pid` a live process? `process.kill(pid, 0)` sends no signal — it only
 * probes existence: it throws ESRCH when the pid is gone (→ stale lock, reclaim)
 * and EPERM when the pid exists but we can't signal it (→ alive, treat as held).
 * Node supports signal 0 on Windows too. A non-positive pid is never live.
 *
 * RESIDUAL RISK (accepted): this only proves SOME process holds the pid, not that
 * it is still K. If a K process is SIGKILLed and the OS recycles its pid before the
 * next boot, an unrelated live process wearing that pid makes us refuse a legitimate
 * restart. Low likelihood (large pid space); `holder.port`/`startedAt` are captured
 * for a future corroborating check if this ever bites.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Parse a lock file's JSON into a LockInfo, or null if missing/garbled. */
function readLock(file: string): LockInfo | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<LockInfo>
    if (typeof parsed.pid === 'number' && typeof parsed.port === 'number') {
      return { pid: parsed.pid, port: parsed.port, startedAt: Number(parsed.startedAt) || 0 }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Try to acquire the single-instance lock for `dataDir`. Returns `{ ok:true, release }`
 * when this process now owns it (fresh, or reclaimed from a dead holder), or
 * `{ ok:false, holder }` when a LIVE process already holds it. A best-effort write
 * failure (unwritable dir) resolves to `{ ok:true }` with a no-op release so boot is
 * never blocked by the lock mechanism itself.
 */
export function acquireInstanceLock(dataDir: string, port: number): AcquireResult {
  const file = lockFilePath(dataDir)
  const payload = JSON.stringify({ pid: process.pid, port, startedAt: Date.now() } satisfies LockInfo) + '\n'

  try {
    fs.mkdirSync(dataDir, { recursive: true })
  } catch (e) {
    // Unwritable DATA_DIR: degrade to no-lock rather than crash (auth.ts posture).
    console.warn(`[instance-lock] could not create ${dataDir} — running without a single-instance lock:`, e)
    return { ok: true, release: () => {}, file }
  }

  // Fast path: ATOMIC create-exclusive. When no lock exists this wins the race
  // cleanly — two simultaneous fresh boots can't both succeed (only one `wx`
  // create wins; the loser gets EEXIST and falls through to the inspect path).
  try {
    fs.writeFileSync(file, payload, { flag: 'wx' })
    return { ok: true, release: makeRelease(file), file }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
      console.warn(`[instance-lock] could not write ${file} — running without a single-instance lock:`, e)
      return { ok: true, release: () => {}, file }
    }
    // EEXIST → a lock file already exists; inspect its holder.
  }

  const existing = readLock(file)
  if (existing && existing.pid !== process.pid && isProcessAlive(existing.pid)) {
    return { ok: false, holder: existing, file }
  }

  // Garbled, our own pid, or a DEAD holder → reclaim by overwrite.
  try {
    fs.writeFileSync(file, payload, 'utf8')
  } catch (e) {
    console.warn(`[instance-lock] could not reclaim ${file} — running without a single-instance lock:`, e)
    return { ok: true, release: () => {}, file }
  }
  return { ok: true, release: makeRelease(file), file }
}

/** Build the idempotent release closure for a lock file WE currently own. */
function makeRelease(file: string): () => void {
  let released = false
  return () => {
    if (released) return
    released = true
    // Only remove the file if WE still own it — never clobber a successor that
    // reclaimed the lock after we exited.
    const cur = readLock(file)
    if (cur && cur.pid === process.pid) {
      try {
        fs.unlinkSync(file)
      } catch {
        /* best-effort: a missing/locked file on shutdown is harmless */
      }
    }
  }
}
