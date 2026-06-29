// T-EVAL dispatch wrapper (Wave 9). Spawns a real headless `claude -p` and parses the stream-json
// event log into a structured result. No shell (claude is a native .exe) → zero quoting risk.
//
// Confinement: caller passes a disposable `cwd` (worktree) + own `dataDir` (K_DATA_DIR). Auth/config
// is inherited from the parent env untouched (never override CLAUDE_CONFIG_DIR). `Task` is disallowed
// by default (no unbounded nested-subagent recursion). `acceptEdits` mode → no permission prompt can
// hang a headless run; off-allowlist tools are auto-denied and surface in `permission_denials`.
import { spawn } from 'node:child_process'

const CLAUDE_EXE = process.env.K_EVAL_CLAUDE_EXE || 'claude.exe'

/**
 * @param {object} o
 * @param {string} o.input               scenario prompt (passed as a positional arg; no shell)
 * @param {string} [o.systemPromptFile]  path to --append-system-prompt-file ('' = omit = degraded-empty)
 * @param {string} [o.model]             'opus' | 'sonnet' | exact id
 * @param {string[]} [o.allowedTools]    tools granted (constant across real/degraded for a case)
 * @param {string[]} [o.disallowedTools] default ['Task']
 * @param {string} o.cwd                 disposable worktree dir
 * @param {string} o.dataDir             K_DATA_DIR for this dispatch
 * @param {string} [o.runId]
 * @param {number} [o.maxTurns]
 * @param {string} [o.permissionMode]    default 'acceptEdits'
 * @param {number} [o.timeoutMs]
 */
export function dispatch(o) {
  const {
    input, systemPromptFile = '', model = 'sonnet',
    allowedTools = [], disallowedTools = ['Task'],
    cwd, dataDir, runId = 'eval', maxTurns = 16,
    permissionMode = 'acceptEdits', timeoutMs = 180000,
  } = o

  const args = [
    '-p', input,
    '--output-format', 'stream-json', '--verbose',
    '--model', model,
    '--permission-mode', permissionMode,
    '--max-turns', String(maxTurns),
  ]
  if (allowedTools.length) args.push('--allowedTools', allowedTools.join(' '))
  if (disallowedTools.length) args.push('--disallowedTools', disallowedTools.join(' '))
  if (systemPromptFile) args.push('--append-system-prompt-file', systemPromptFile)

  const env = { ...process.env, K_DATA_DIR: dataDir, K_RUN_ID: runId }

  return new Promise((resolve) => {
    let stdout = '', stderr = '', settled = false
    const t0 = Date.now()
    let child
    try {
      child = spawn(CLAUDE_EXE, args, { cwd, env, shell: false, windowsHide: true })
    } catch (err) {
      return resolve(finalize({ outcome: 'spawn_error', error: String(err), stdout: '', stderr: '', ms: 0 }))
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill('SIGKILL') } catch {}
      resolve(finalize({ outcome: 'timeout', stdout, stderr, ms: Date.now() - t0 }))
    }, timeoutMs)
    child.stdout.on('data', d => { stdout += d.toString() })
    child.stderr.on('data', d => { stderr += d.toString() })
    child.on('error', err => {
      if (settled) return; settled = true; clearTimeout(timer)
      resolve(finalize({ outcome: 'spawn_error', error: String(err), stdout, stderr, ms: Date.now() - t0 }))
    })
    child.on('close', code => {
      if (settled) return; settled = true; clearTimeout(timer)
      resolve(finalize({ outcome: 'closed', code, stdout, stderr, ms: Date.now() - t0 }))
    })
    try { child.stdin.end() } catch { /* ignore */ }
  })
}

function finalize(raw) {
  const events = []
  for (const ln of raw.stdout.split('\n')) {
    const s = ln.trim()
    if (!s) continue
    try { events.push(JSON.parse(s)) } catch { /* skip partial/non-json line */ }
  }
  const result = events.find(e => e.type === 'result')
  const toolUses = []
  let assistantText = ''
  for (const e of events) {
    const content = e?.message?.content
    if (e.type === 'assistant' && Array.isArray(content)) {
      for (const b of content) {
        if (b.type === 'tool_use') toolUses.push({ name: b.name, input: b.input })
        else if (b.type === 'text') assistantText += b.text + '\n'
      }
    }
  }
  const text = (result && typeof result.result === 'string' && result.result.length)
    ? result.result
    : assistantText.trim()
  return {
    outcome: raw.outcome,
    code: raw.code ?? null,
    error: raw.error ?? null,
    ms: raw.ms,
    text,
    isError: result?.is_error ?? null,
    apiErrorStatus: result?.api_error_status ?? null,
    stopReason: result?.stop_reason ?? null,
    numTurns: result?.num_turns ?? null,
    costUsd: result?.total_cost_usd ?? null,
    usage: result?.usage ?? null,
    modelUsed: result?.modelUsage ? Object.keys(result.modelUsage)[0] : null,
    denials: result?.permission_denials ?? [],
    deniedTools: [...new Set((result?.permission_denials ?? []).map(d => d.tool_name).filter(Boolean))],
    toolUses,
    toolNames: [...new Set(toolUses.map(t => t.name))],
    eventCount: events.length,
    stderrTail: (raw.stderr || '').slice(-2000),
  }
}
