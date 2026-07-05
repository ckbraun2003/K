/**
 * agent-config.ts::copyDirConfined — the D-069 vendoring primitive (A2).
 *
 * Locks:
 *   - happy path: a nested skill dir copies byte-faithfully;
 *   - src-side guards: `src` must realpath-confine under `srcRoot` (throw);
 *     symlinked entries are SKIPPED (never followed, no throw); per-file
 *     realpath containment;
 *   - dest-side guard: any dest escaping destRoot throws (guardUnder semantics);
 *   - hard caps: >500 files or >10MB THROW (fail-closed — the dispatch refuses).
 */
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  copyDirConfined,
  COPY_CONFINED_MAX_FILES,
  COPY_CONFINED_MAX_BYTES,
} from '../src/agent-config.js'

const tmpDirs: string[] = []
function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

function makeSkillSrc(): { root: string; src: string } {
  const root = tmpDir('k-cdc-src-')
  const src = path.join(root, 'my-skill')
  fs.mkdirSync(path.join(src, 'sub'), { recursive: true })
  fs.writeFileSync(path.join(src, 'SKILL.md'), '---\nname: my-skill\n---\nbody', 'utf8')
  fs.writeFileSync(path.join(src, 'sub', 'helper.md'), 'helper', 'utf8')
  return { root, src }
}

describe('copyDirConfined', () => {
  it('copies a nested skill dir byte-faithfully', () => {
    const { root, src } = makeSkillSrc()
    const destRoot = tmpDir('k-cdc-dest-')
    const dest = path.join(destRoot, 'skills', 'my-skill')
    copyDirConfined(root, src, destRoot, dest)
    expect(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8')).toBe('---\nname: my-skill\n---\nbody')
    expect(fs.readFileSync(path.join(dest, 'sub', 'helper.md'), 'utf8')).toBe('helper')
  })

  it('throws when src realpath-escapes srcRoot (caller bug or attack)', () => {
    const { src } = makeSkillSrc()
    const otherRoot = tmpDir('k-cdc-other-')
    const destRoot = tmpDir('k-cdc-dest-')
    expect(() => copyDirConfined(otherRoot, src, destRoot, path.join(destRoot, 'x'))).toThrow(
      /src escapes its root/,
    )
  })

  it('throws when a dest path escapes destRoot (guardUnder)', () => {
    const { root, src } = makeSkillSrc()
    const destRoot = tmpDir('k-cdc-dest-')
    expect(() =>
      copyDirConfined(root, src, destRoot, path.join(destRoot, '..', 'escape')),
    ).toThrow(/escapes configDir/)
  })

  it('SKIPS a symlinked entry (never followed) without throwing', () => {
    const { root, src } = makeSkillSrc()
    const outside = tmpDir('k-cdc-outside-')
    const secret = path.join(outside, 'secret.txt')
    fs.writeFileSync(secret, 'SECRET', 'utf8')
    try {
      fs.symlinkSync(secret, path.join(src, 'link.md'))
    } catch {
      return // symlinks unavailable (Windows without dev-mode) — skip
    }
    const destRoot = tmpDir('k-cdc-dest-')
    const dest = path.join(destRoot, 'my-skill')
    copyDirConfined(root, src, destRoot, dest)
    expect(fs.existsSync(path.join(dest, 'link.md'))).toBe(false) // never vendored
    expect(fs.existsSync(path.join(dest, 'SKILL.md'))).toBe(true) // the rest copied
  })

  it(`throws past the ${COPY_CONFINED_MAX_FILES}-file cap (fail-closed)`, () => {
    const root = tmpDir('k-cdc-src-')
    const src = path.join(root, 'huge-skill')
    fs.mkdirSync(src, { recursive: true })
    for (let i = 0; i <= COPY_CONFINED_MAX_FILES; i++) {
      fs.writeFileSync(path.join(src, `f${i}.md`), 'x', 'utf8')
    }
    const destRoot = tmpDir('k-cdc-dest-')
    expect(() => copyDirConfined(root, src, destRoot, path.join(destRoot, 'huge-skill'))).toThrow(
      new RegExp(`exceeds ${COPY_CONFINED_MAX_FILES} files`),
    )
  })

  it(`throws past the ${COPY_CONFINED_MAX_BYTES}-byte cap (fail-closed)`, () => {
    const root = tmpDir('k-cdc-src-')
    const src = path.join(root, 'fat-skill')
    fs.mkdirSync(src, { recursive: true })
    fs.writeFileSync(path.join(src, 'blob.bin'), Buffer.alloc(COPY_CONFINED_MAX_BYTES + 1))
    const destRoot = tmpDir('k-cdc-dest-')
    expect(() => copyDirConfined(root, src, destRoot, path.join(destRoot, 'fat-skill'))).toThrow(
      /exceeds \d+ bytes/,
    )
  })
})
