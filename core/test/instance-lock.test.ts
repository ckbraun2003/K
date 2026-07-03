import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { acquireInstanceLock, lockFilePath, isProcessAlive, type LockInfo } from '../src/instance-lock.js'

// ── temp dir helpers ───────────────────────────────────────────────────────────

const tmps: string[] = []
function makeTmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'k-lock-'))
  tmps.push(d)
  return d
}
afterEach(() => {
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function writeLock(dir: string, info: LockInfo): void {
  fs.writeFileSync(lockFilePath(dir), JSON.stringify(info) + '\n', 'utf8')
}

describe('isProcessAlive', () => {
  it('true for our own pid, false for a non-positive / almost-certainly-dead pid', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
    expect(isProcessAlive(0)).toBe(false)
    expect(isProcessAlive(-1)).toBe(false)
    // A very high pid is overwhelmingly unlikely to exist.
    expect(isProcessAlive(2_000_000_000)).toBe(false)
  })
})

describe('acquireInstanceLock', () => {
  it('fresh dir: acquires, writes { pid, port } to core.lock', () => {
    const dir = makeTmp()
    const res = acquireInstanceLock(dir, 3011)
    expect(res.ok).toBe(true)
    const raw = JSON.parse(fs.readFileSync(lockFilePath(dir), 'utf8')) as LockInfo
    expect(raw.pid).toBe(process.pid)
    expect(raw.port).toBe(3011)
  })

  it('refuses when a LIVE FOREIGN process holds it (parent pid stand-in)', () => {
    const dir = makeTmp()
    // The parent process is alive and its pid != ours → a genuine foreign live holder.
    const foreignPid = process.ppid
    expect(isProcessAlive(foreignPid)).toBe(true)
    expect(foreignPid).not.toBe(process.pid)
    writeLock(dir, { pid: foreignPid, port: 9999, startedAt: Date.now() })

    const res = acquireInstanceLock(dir, 3011)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.holder?.pid).toBe(foreignPid)
    expect(res.holder?.port).toBe(9999)
    // The foreign holder's lock file is left intact (we did not steal it).
    const raw = JSON.parse(fs.readFileSync(lockFilePath(dir), 'utf8')) as LockInfo
    expect(raw.pid).toBe(foreignPid)
  })

  it('our OWN pid in the lock is reclaimable (a node --watch restart)', () => {
    const dir = makeTmp()
    writeLock(dir, { pid: process.pid, port: 9999, startedAt: 1 })
    const res = acquireInstanceLock(dir, 3011)
    expect(res.ok).toBe(true)
  })

  it('reclaims a STALE lock held by a dead pid', () => {
    const dir = makeTmp()
    writeLock(dir, { pid: 2_000_000_000, port: 3001, startedAt: 1 })
    const res = acquireInstanceLock(dir, 3011)
    expect(res.ok).toBe(true)
    const raw = JSON.parse(fs.readFileSync(lockFilePath(dir), 'utf8')) as LockInfo
    expect(raw.pid).toBe(process.pid)
    expect(raw.port).toBe(3011)
  })

  it('reclaims a garbled lock file', () => {
    const dir = makeTmp()
    fs.writeFileSync(lockFilePath(dir), 'not json{{{', 'utf8')
    const res = acquireInstanceLock(dir, 3011)
    expect(res.ok).toBe(true)
  })

  it('release removes the lock file only while we still own it', () => {
    const dir = makeTmp()
    const res = acquireInstanceLock(dir, 3011)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(fs.existsSync(lockFilePath(dir))).toBe(true)
    res.release()
    expect(fs.existsSync(lockFilePath(dir))).toBe(false)

    // A successor took over after us → our (idempotent) release must NOT delete theirs.
    writeLock(dir, { pid: 2_000_000_001, port: 4000, startedAt: Date.now() })
    res.release() // second call is a no-op (already released)
    expect(fs.existsSync(lockFilePath(dir))).toBe(true)
  })
})
