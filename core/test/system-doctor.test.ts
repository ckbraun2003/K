/**
 * Wave 2 — System Doctor: pure report builder + never-throw tool probe.
 *
 * `buildDoctorReport` is asserted with FAKE probe results so ok-logic + shape are
 * deterministic regardless of which tools exist in CI. `probeTool` is exercised
 * against `node` (guaranteed present — it's running this test) and a bogus binary
 * (guaranteed absent), so the never-throw contract is proven without depending on
 * claude/gh/ollama being installed. Mirrors settings-route.test's pure-builder style.
 */
import { describe, it, expect } from 'vitest'
import {
  buildDoctorReport,
  probeTool,
  DOCTOR_CATALOG,
  CLAUDE_PROBE,
  type ProbeResult,
} from '../src/system-doctor.js'

// A full "all present" fake — one result entry per catalog id.
function allPresent(): Record<string, ProbeResult> {
  return Object.fromEntries(
    DOCTOR_CATALOG.map(s => [s.id, { present: true, version: `${s.id}-1.0` }]),
  )
}

// ── buildDoctorReport (pure) ─────────────────────────────────────────────────────

describe('buildDoctorReport (pure)', () => {
  it('every tool present → ok:true, one row per catalog entry, ids intact', () => {
    const report = buildDoctorReport(allPresent())
    expect(report.tools).toHaveLength(DOCTOR_CATALOG.length)
    expect(report.ok).toBe(true)
    expect(report.tools.map(t => t.id).sort()).toEqual(DOCTOR_CATALOG.map(s => s.id).sort())
    // metadata (name/purpose/installUrl/required) is sourced from the catalog verbatim
    const claude = report.tools.find(t => t.id === 'claude')!
    expect(claude.required).toBe(true)
    expect(claude.name).toBe('Claude Code CLI')
    expect(claude.installUrl).toMatch(/^https:\/\//)
  })

  it('a REQUIRED tool absent → ok:false', () => {
    const report = buildDoctorReport({ ...allPresent(), claude: { present: false, version: null } })
    expect(report.ok).toBe(false)
    expect(report.tools.find(t => t.id === 'claude')!.present).toBe(false)
  })

  it('an OPTIONAL tool absent → ok stays true', () => {
    const report = buildDoctorReport({ ...allPresent(), ollama: { present: false, version: null } })
    expect(report.ok).toBe(true)
    expect(report.tools.find(t => t.id === 'ollama')!.present).toBe(false)
  })

  it('passes the probed version through verbatim', () => {
    const report = buildDoctorReport({ ...allPresent(), git: { present: true, version: 'git version 2.44.0' } })
    expect(report.tools.find(t => t.id === 'git')!.version).toBe('git version 2.44.0')
  })

  it('a catalog id missing from the results is treated as absent', () => {
    const report = buildDoctorReport({}) // no results at all
    expect(report.ok).toBe(false) // required tools are absent
    expect(report.tools.every(t => t.present === false && t.version === null)).toBe(true)
  })
})

// ── probeTool (never-throws, real binaries) ──────────────────────────────────────

describe('probeTool (never-throws)', () => {
  it('a real cross-platform binary (node) → present:true with a version string', async () => {
    const r = await probeTool('node', ['--version'], 3_000)
    expect(r.present).toBe(true)
    expect(typeof r.version).toBe('string')
    expect(r.version!.length).toBeGreaterThan(0)
  })

  it('a non-existent binary → present:false, version:null (no throw)', async () => {
    const r = await probeTool('definitely-not-a-real-binary-xyz', ['--version'], 2_000)
    expect(r).toEqual({ present: false, version: null })
  })
})

// ── CLAUDE_PROBE — the ONE claude detection definition (BE-3b) ──────────────────

describe('CLAUDE_PROBE coupling', () => {
  it('the doctor catalog claude entry probes with exactly the shared definition', () => {
    expect(DOCTOR_CATALOG.find(t => t.id === 'claude')).toMatchObject({
      bin: CLAUDE_PROBE.bin,
      args: [...CLAUDE_PROBE.args],
    })
    expect(CLAUDE_PROBE.timeoutMs).toBe(3_000)
  })
})
