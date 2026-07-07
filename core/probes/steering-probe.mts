/**
 * P0 Lane A — STEERING PROBE (E-21 → decision D-073). LIVE: costs real money
 * (haiku; expect ~$0.05–$0.50 measured). NEVER runs in CI.
 *
 * Spawns the REAL claude CLI with the SAME interactive flags supervisor.ts uses
 * (buildClaudeArgs: -p --input-format stream-json --output-format stream-json
 * --verbose --replay-user-messages), but with the HOST config — host hooks may
 * add extra stream lines; classification ignores unknown line types.
 *
 * Scenario A — interrupt: with a turn in flight, write a control_request
 *   interrupt on stdin. Classify: control_response seen? result line after the
 *   interrupt? does a NEW user turn still get answered afterwards?
 * Scenario B — queued mid-turn user turn: with a turn in flight, write a SECOND
 *   user envelope. Classify: is it buffered + answered after the current turn
 *   (result count, replayed user line, marker text) without breaking the stream?
 *
 * Hard bounds: 120s per wait, 5min SIGKILL per scenario.
 * Transcripts: core/probes/out/steering-{a,b}.jsonl
 * Run from core/:  pnpm exec tsx probes/steering-probe.mts
 */
import { execa } from 'execa'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.join(__dirname, 'out')
fs.mkdirSync(OUT_DIR, { recursive: true })

const MODEL = 'claude-haiku-4-5-20251001' // cheapest KNOWN_MODELS id (shared/src/types.ts)
const WAIT_MS = 120_000
const LONG_TASK =
  'Write a numbered list from 1 to 40. One line per number, each with a 5-8 word sentence. ' +
  'Do not stop early. Do not summarize.'

type Json = Record<string, unknown>

/** EXACTLY supervisor.ts::userTurnEnvelope. */
function userTurn(text: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n'
}

/** Agent-SDK wire-protocol interrupt shape. Whether the -p stream-json CLI
 *  accepts it is exactly what this probe measures (D-073). */
function interruptRequest(id: string): string {
  return JSON.stringify({ type: 'control_request', request_id: id, request: { subtype: 'interrupt' } }) + '\n'
}

interface Harness {
  write(s: string): void
  waitFor(pred: (o: Json) => boolean, label: string): Promise<Json | null>
  endInput(): void
  kill(): void
  lines: Json[]
  exited: Promise<number | null>
}

function spawnClaude(transcript: string): Harness {
  const proc = execa(
    'claude',
    ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--replay-user-messages', '--model', MODEL],
    { reject: false },
  )
  const lines: Json[] = []
  type Waiter = { pred: (o: Json) => boolean; resolve: (o: Json | null) => void; timer: NodeJS.Timeout }
  const waiters = new Set<Waiter>()
  let buf = ''
  proc.stdout!.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8')
    const parts = buf.split('\n')
    buf = parts.pop() ?? ''
    for (const raw of parts) {
      if (!raw.trim()) continue
      fs.appendFileSync(transcript, raw + '\n')
      let obj: Json
      try { obj = JSON.parse(raw) as Json } catch { obj = { type: '__unparsed__', raw } }
      lines.push(obj)
      for (const w of [...waiters]) {
        if (w.pred(obj)) { waiters.delete(w); clearTimeout(w.timer); w.resolve(obj) }
      }
    }
  })
  proc.stderr!.on('data', (c: Buffer) => fs.appendFileSync(transcript, `STDERR: ${c.toString('utf8')}`))
  const exited = proc.then(r => r.exitCode ?? null)
  return {
    write: s => { try { proc.stdin!.write(s) } catch { /* dead pipe — classified via exit */ } },
    waitFor: (pred, label) =>
      new Promise(resolve => {
        for (const seen of lines) { if (pred(seen)) return resolve(seen) }
        const w: Waiter = {
          pred, resolve,
          timer: setTimeout(() => { waiters.delete(w); console.log(`  … timeout waiting for: ${label}`); resolve(null) }, WAIT_MS),
        }
        waiters.add(w)
      }),
    endInput: () => { try { proc.stdin!.end() } catch { /* already closed */ } },
    kill: () => { try { proc.kill('SIGKILL') } catch { /* already gone */ } },
    lines, exited,
  }
}

const isAssistant = (o: Json) => o.type === 'assistant'
const isResult = (o: Json) => o.type === 'result'
const isControlResponse = (o: Json) => o.type === 'control_response'

function assistantTextIncludes(lines: Json[], needle: string): boolean {
  return lines.some(o => {
    if (o.type !== 'assistant') return false
    const content = (o.message as Json | undefined)?.content
    if (!Array.isArray(content)) return false
    return content.some(b => (b as Json).type === 'text' && String((b as Json).text ?? '').includes(needle))
  })
}

function lastResultCost(lines: Json[]): number {
  const results = lines.filter(isResult)
  const last = results[results.length - 1] as Json | undefined
  return typeof last?.total_cost_usd === 'number' ? (last.total_cost_usd as number) : 0
}

async function scenarioA(): Promise<{ verdict: string; costUsd: number }> {
  console.log('\n── Scenario A: control_request interrupt mid-turn ──')
  const transcript = path.join(OUT_DIR, 'steering-a.jsonl')
  fs.writeFileSync(transcript, '')
  const h = spawnClaude(transcript)
  const hardStop = setTimeout(() => h.kill(), 5 * 60_000)
  try {
    h.write(userTurn(LONG_TASK))
    const first = await h.waitFor(isAssistant, 'first assistant line (turn in flight)')
    if (!first) return { verdict: 'INCONCLUSIVE: no assistant output before timeout', costUsd: lastResultCost(h.lines) }
    h.write(interruptRequest('p0-probe-1'))
    // Review-caught race fix: wait for the control_response AND the aborted
    // turn's own result SEQUENTIALLY (each 120s-bounded) before sampling —
    // racing them resolved on the fast control_response ack, sampling
    // resultAfterInterrupt before the aborted turn's error_during_execution
    // result landed, and let that leftover result satisfy the post-interrupt
    // wait below (false-negative steerAck). Mirrors scenario B's pattern.
    const ctrlResp = await h.waitFor(isControlResponse, 'control_response after interrupt')
    const controlResponseSeen = ctrlResp !== null
    const resultLine = await h.waitFor(isResult, 'result after interrupt (aborted turn, if any)')
    const resultAfterInterrupt = resultLine !== null
    const ctrl = ctrlResp ?? resultLine
    // Post-interrupt steering: a NEW turn on the same stdin. resultsBefore is
    // sampled AFTER the aborted turn's result, so the wait below can only be
    // satisfied by a genuinely new (post-interrupt) result line.
    const resultsBefore = h.lines.filter(isResult).length
    h.write(userTurn('Reply with exactly: STEER-ACK'))
    await h.waitFor(o => isResult(o) && h.lines.filter(isResult).length > resultsBefore, 'result for the post-interrupt turn')
    const steerAck = assistantTextIncludes(h.lines, 'STEER-ACK')
    h.endInput()
    await Promise.race([h.exited, new Promise(r => setTimeout(r, 30_000))])
    const verdict =
      `control_response=${controlResponseSeen ? 'yes' : 'no'} ` +
      `result_after_interrupt=${resultAfterInterrupt ? 'yes' : 'no'} ` +
      `post_interrupt_turn_answered=${steerAck ? 'yes' : 'no'} ` +
      `(first ctrl/result line: ${ctrl ? JSON.stringify(ctrl).slice(0, 200) : 'none'})`
    console.log('  A verdict:', verdict)
    return { verdict, costUsd: lastResultCost(h.lines) }
  } finally {
    clearTimeout(hardStop)
    h.kill()
  }
}

async function scenarioB(): Promise<{ verdict: string; costUsd: number }> {
  console.log('\n── Scenario B: queued user turn written MID-turn ──')
  const transcript = path.join(OUT_DIR, 'steering-b.jsonl')
  fs.writeFileSync(transcript, '')
  const h = spawnClaude(transcript)
  const hardStop = setTimeout(() => h.kill(), 5 * 60_000)
  try {
    h.write(userTurn(LONG_TASK))
    const first = await h.waitFor(isAssistant, 'first assistant line (turn in flight)')
    if (!first) return { verdict: 'INCONCLUSIVE: no assistant output before timeout', costUsd: 0 }
    // Inject the SECOND user turn while turn 1 is still streaming.
    h.write(userTurn('After you finish the list, reply on its own line with exactly: QUEUED-OK'))
    const r1 = await h.waitFor(isResult, 'result #1 (end of the long turn)')
    await h.waitFor(o => isResult(o) && h.lines.filter(isResult).length >= 2, 'result #2 (the queued turn)')
    const queuedAnswered = assistantTextIncludes(h.lines, 'QUEUED-OK')
    h.endInput()
    const exitCode = await Promise.race([h.exited, new Promise<null>(r => setTimeout(() => r(null), 30_000))])
    const verdict =
      `results=${h.lines.filter(isResult).length} ` +
      `queued_turn_answered=${queuedAnswered ? 'yes' : 'no'} ` +
      `stream_survived=${r1 !== null ? 'yes' : 'no'} exit=${exitCode}`
    console.log('  B verdict:', verdict)
    return { verdict, costUsd: lastResultCost(h.lines) }
  } finally {
    clearTimeout(hardStop)
    h.kill()
  }
}

const a = await scenarioA()
const b = await scenarioB()
const total = a.costUsd + b.costUsd
console.log('\n══ STEERING PROBE SUMMARY (D-073 evidence) ══')
console.log('A (interrupt):  ', a.verdict)
console.log('B (queued turn):', b.verdict)
console.log(`MEASURED COST: $${total.toFixed(4)} (sum of last CLI-reported total_cost_usd per scenario — never an estimate)`)
console.log('Transcripts: core/probes/out/steering-a.jsonl, core/probes/out/steering-b.jsonl')
