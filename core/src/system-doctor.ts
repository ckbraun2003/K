/**
 * System Doctor — host prerequisite detection for first-run readiness.
 *
 * Mirrors routes/settings.ts's two design rules:
 *
 *  1. Testability via injection. The report is assembled by a PURE builder
 *     (`buildDoctorReport`) that takes already-resolved probe results, so a unit
 *     test asserts the report SHAPE + ok-logic without depending on whether
 *     claude/gh/ollama are installed in CI. `runDoctor()` runs the real subprocess
 *     probes and hands their results to the same builder.
 *
 *  2. Probes never throw. Each tool is checked with a short-timeout `--version`
 *     execa call; ENOENT / non-zero exit / timeout all collapse to
 *     `{ present:false, version:null }` — a missing tool is data, never an error.
 */

import { execa } from 'execa'
import type { DoctorReport, DoctorTool } from '@k/shared'

/** A resolved probe result — the runtime half of a DoctorTool (presence + the
 *  `--version` line), merged with the static catalog metadata by buildDoctorReport. */
export interface ProbeResult {
  present: boolean
  version: string | null
}

/** One tool's static metadata — the id/name/requirement/guidance the report
 *  carries, plus the `--version` probe used to detect it. Presence + version are
 *  resolved at runtime (probeTool) and merged in by buildDoctorReport. */
export interface DoctorToolSpec {
  id: string
  name: string
  required: boolean
  purpose: string
  installUrl: string
  /** The detection probe: `bin args…` — a short-timeout `--version` call. */
  bin: string
  args: string[]
}

/** The host tools the desktop app relies on. `claude` is the agent engine K drives
 *  and is NOT bundled; git/node are hard prerequisites; gh/ollama are optional
 *  (K degrades gracefully without them). */
export const DOCTOR_CATALOG: readonly DoctorToolSpec[] = [
  {
    id: 'claude',
    name: 'Claude Code CLI',
    required: true,
    purpose: 'The agent engine K drives — not bundled; install and authenticate it.',
    installUrl: 'https://docs.claude.com/en/docs/claude-code/overview',
    bin: 'claude',
    args: ['--version'],
  },
  {
    id: 'git',
    name: 'Git',
    required: true,
    purpose: 'Version control for run worktrees, checkpoints, and PRs.',
    installUrl: 'https://git-scm.com/downloads',
    bin: 'git',
    args: ['--version'],
  },
  {
    id: 'node',
    name: 'Node.js',
    required: true,
    purpose: 'Runtime for the Claude CLI and `npx gitnexus` code intelligence.',
    installUrl: 'https://nodejs.org/',
    bin: 'node',
    args: ['--version'],
  },
  {
    id: 'gh',
    name: 'GitHub CLI',
    required: false,
    purpose: 'GitHub PR/CI integration (degrades gracefully if absent).',
    installUrl: 'https://cli.github.com/',
    bin: 'gh',
    args: ['--version'],
  },
  {
    id: 'ollama',
    name: 'Ollama',
    required: false,
    purpose: 'Optional local models (default off).',
    installUrl: 'https://ollama.com/download',
    bin: 'ollama',
    args: ['--version'],
  },
]

/** First non-empty output line, trimmed and length-bounded — a stable one-line
 *  version string. Some tools (e.g. `gh`) print a multi-line banner, so we keep
 *  only the first meaningful line. Returns null when there's nothing usable. */
function normalizeVersion(stdout: string): string | null {
  const line = stdout.split('\n').map(l => l.trim()).find(l => l.length > 0)
  if (!line) return null
  return line.length > 200 ? line.slice(0, 200) : line
}

/** Probe one tool's `--version` (short timeout). NEVER throws: ENOENT / non-zero
 *  exit / timeout all resolve to `{ present:false, version:null }`. The version is
 *  normalized to the first non-empty line (see normalizeVersion). Mirrors
 *  routes/settings.ts's probeClaude/probeGithub. */
export async function probeTool(bin: string, args: string[], timeoutMs: number): Promise<ProbeResult> {
  try {
    const { stdout } = await execa(bin, args, { timeout: timeoutMs })
    return { present: true, version: normalizeVersion(stdout) }
  } catch {
    return { present: false, version: null }
  }
}

/** Pure assembly of the doctor report from the static catalog + already-resolved
 *  probe results. No subprocesses — unit-testable with fakes. `ok` is true iff
 *  every REQUIRED tool is present; a missing OPTIONAL tool never fails the report.
 *  A catalog id with no result entry is treated as absent (present:false). */
export function buildDoctorReport(results: Record<string, ProbeResult>): DoctorReport {
  const tools: DoctorTool[] = DOCTOR_CATALOG.map(spec => {
    const r = results[spec.id] ?? { present: false, version: null }
    return {
      id: spec.id,
      name: spec.name,
      required: spec.required,
      present: r.present,
      version: r.version,
      purpose: spec.purpose,
      installUrl: spec.installUrl,
    }
  })
  const ok = tools.every(t => !t.required || t.present)
  return { tools, ok }
}

// The Settings doctor card polls; spawning five `--version` processes on every
// request (and every open tab) is wasteful, so cache the probe results for a short
// window. The pure builder (buildDoctorReport) is unaffected — tests call it
// directly and never hit this cache. Mirrors routes/settings.ts's cachedProbes.
const DOCTOR_TTL_MS = 15_000
let doctorCache: { report: DoctorReport; ts: number } | null = null

/** Run every catalog probe in parallel and assemble the report. Short-TTL cached so
 *  repeated polls don't respawn processes. Never throws (probeTool never does). */
export async function runDoctor(): Promise<DoctorReport> {
  if (doctorCache && Date.now() - doctorCache.ts < DOCTOR_TTL_MS) return doctorCache.report
  const entries = await Promise.all(
    DOCTOR_CATALOG.map(async spec => [spec.id, await probeTool(spec.bin, spec.args, 3_000)] as const),
  )
  const report = buildDoctorReport(Object.fromEntries(entries))
  doctorCache = { report, ts: Date.now() }
  return report
}
