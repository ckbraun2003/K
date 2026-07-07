/**
 * P0 Lane A — RESUME PROBE (E-22 → decision D-074). LIVE: costs real money
 * (haiku; expect ~$0.03–$0.20 measured). NEVER runs in CI.
 *
 * 1. One-shot headless run in a scratch dir: plant a secret word; capture the
 *    session_id from the stream-json init line; let it finish.
 * 2. `claude -p --resume <session-id>` in the SAME cwd: ask for the word —
 *    does the resumed session retain context?
 * 3. The same --resume from a DIFFERENT cwd — informs whether E-22 follow-up
 *    runs must retain the original run cwd (CLI session storage is keyed under
 *    the config dir by project path).
 *
 * D-074 NOTE (record in the draft): this probe uses the HOST config. Managed K
 * runs synthesize a per-run CLAUDE_CONFIG_DIR that is CLEANED at terminal
 * (agent-config.ts synth.cleanup()), so E-22 will additionally need config-dir
 * retention (the k-secretary persistentSession `persist: true` pattern).
 *
 * Run from core/:  pnpm exec tsx probes/resume-probe.mts
 */
import { execa } from 'execa'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.join(__dirname, 'out')
fs.mkdirSync(OUT_DIR, { recursive: true })

const MODEL = 'claude-haiku-4-5-20251001'
const SECRET = 'PLUM-42'
const TIMEOUT_MS = 180_000

type Json = Record<string, unknown>

interface OneShot { sessionId: string | null; resultText: string; costUsd: number; exitCode: number | null }

async function oneShot(cwd: string, args: string[], transcript: string): Promise<OneShot> {
  const proc = execa('claude', args, { cwd, reject: false, timeout: TIMEOUT_MS, killSignal: 'SIGKILL' })
  const lines: Json[] = []
  let buf = ''
  proc.stdout!.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8')
    const parts = buf.split('\n')
    buf = parts.pop() ?? ''
    for (const raw of parts) {
      if (!raw.trim()) continue
      fs.appendFileSync(transcript, raw + '\n')
      try { lines.push(JSON.parse(raw) as Json) } catch { /* host-hook noise — ignore */ }
    }
  })
  proc.stderr!.on('data', (c: Buffer) => fs.appendFileSync(transcript, `STDERR: ${c.toString('utf8')}`))
  const res = await proc
  const init = lines.find(l => l.type === 'system' && l.subtype === 'init')
  const result = lines.find(l => l.type === 'result')
  return {
    sessionId: typeof init?.session_id === 'string' ? (init.session_id as string) : null,
    resultText: typeof result?.result === 'string' ? (result.result as string) : '',
    costUsd: typeof result?.total_cost_usd === 'number' ? (result.total_cost_usd as number) : 0,
    exitCode: res.exitCode ?? null,
  }
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'k-resume-probe-'))
const cwdA = path.join(base, 'a')
const cwdB = path.join(base, 'b')
fs.mkdirSync(cwdA)
fs.mkdirSync(cwdB)

console.log('── Step 1: seed run (plant the secret) ──')
const seed = await oneShot(
  cwdA,
  ['-p', `Remember this secret word: ${SECRET}. Reply with exactly OK.`, '--output-format', 'stream-json', '--verbose', '--model', MODEL],
  path.join(OUT_DIR, 'resume-seed.jsonl'),
)
console.log(`  session_id=${seed.sessionId} exit=${seed.exitCode} cost=$${seed.costUsd.toFixed(4)}`)
if (!seed.sessionId) {
  console.log('VERDICT: INCONCLUSIVE — no init session_id captured; inspect core/probes/out/resume-seed.jsonl')
  process.exit(1)
}

console.log('── Step 2: --resume in the SAME cwd ──')
const same = await oneShot(
  cwdA,
  ['-p', 'What was the secret word I told you earlier? Reply with just the word.', '--output-format', 'stream-json', '--verbose', '--resume', seed.sessionId, '--model', MODEL],
  path.join(OUT_DIR, 'resume-same-cwd.jsonl'),
)
const sameOk = same.resultText.toUpperCase().includes(SECRET)
console.log(`  answered="${same.resultText.slice(0, 80)}" retained=${sameOk} exit=${same.exitCode} cost=$${same.costUsd.toFixed(4)}`)

console.log('── Step 3: --resume from a DIFFERENT cwd ──')
const diff = await oneShot(
  cwdB,
  ['-p', 'What was the secret word I told you earlier? Reply with just the word.', '--output-format', 'stream-json', '--verbose', '--resume', seed.sessionId, '--model', MODEL],
  path.join(OUT_DIR, 'resume-diff-cwd.jsonl'),
)
const diffOk = diff.resultText.toUpperCase().includes(SECRET)
console.log(`  answered="${diff.resultText.slice(0, 80)}" retained=${diffOk} exit=${diff.exitCode} cost=$${diff.costUsd.toFixed(4)}`)

const total = seed.costUsd + same.costUsd + diff.costUsd
console.log('\n══ RESUME PROBE SUMMARY (D-074 evidence) ══')
console.log(`same-cwd resume retains context:      ${sameOk ? 'YES' : 'NO'}`)
console.log(`different-cwd resume retains context: ${diffOk ? 'YES' : 'NO'} (exit ${diff.exitCode})`)
console.log(`MEASURED COST: $${total.toFixed(4)} (CLI-reported total_cost_usd — never an estimate)`)
console.log('Transcripts: core/probes/out/resume-*.jsonl')
try { fs.rmSync(base, { recursive: true, force: true }) } catch { /* best-effort */ }
