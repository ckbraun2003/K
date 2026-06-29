// LLM-judge grader. A second dispatch (FIXED model = Opus, tools OFF, single-turn) scores the SUT's
// response against the system's rubric and outputs strict JSON. The same judge grades real AND
// degraded variants, so any judge bias cancels in the discrimination delta (real - degraded).
import { dispatch } from './dispatch.mjs'
import { makeSandbox } from './sandbox.mjs'

const JUDGE_MODEL = process.env.K_EVAL_JUDGE_MODEL || 'opus'

function buildJudgePrompt({ systemTitle, systemJob, rubric, scenario, response, behavior }) {
  return [
    `You are a STRICT evaluation judge. You score how well an AI agent's response satisfies a rubric.`,
    `You are impartial: judge ONLY the response against the rubric. Do not be lenient. Do not reward`,
    `confident tone. Missing or wrong behavior scores low even if the prose is polished.`,
    ``,
    `## System under evaluation`,
    `${systemTitle} — ${systemJob}`,
    ``,
    `## Scenario the agent was given`,
    scenario,
    ``,
    `## Rubric (score each criterion 0.0–1.0)`,
    rubric,
    ``,
    `## What the agent actually did (tool/worktree telemetry — use this, do not trust prose alone)`,
    behavior,
    ``,
    `## The agent's response text`,
    '"""',
    response || '(empty response)',
    '"""',
    ``,
    `## Output contract`,
    `Reply with STRICT JSON and nothing else (no markdown, no prose around it):`,
    `{"scores": {"<criterionId>": 0.0}, "overall": 0.0, "verdict": "pass" | "fail", "rationale": "<=40 words"}`,
    `- "scores" must contain one entry per rubric criterion id.`,
    `- "overall" is your holistic 0.0–1.0 judgement (not necessarily the mean).`,
    `- "verdict" is "pass" only if the response would be acceptable from this system in production.`,
  ].join('\n')
}

function parseJudgeJson(text) {
  if (!text) return null
  let s = text.trim()
  // strip code fences if present
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) s = fence[1].trim()
  const a = s.indexOf('{'), b = s.lastIndexOf('}')
  if (a === -1 || b === -1 || b < a) return null
  try { return JSON.parse(s.slice(a, b + 1)) } catch { return null }
}

function behaviorSummary(result, post) {
  const lines = [
    `- dispatch outcome: ${result.outcome} (isError=${result.isError}, stop=${result.stopReason}, turns=${result.numTurns})`,
    `- tools used (succeeded): ${JSON.stringify((result.toolNames ?? []).filter(t => !(result.deniedTools ?? []).includes(t)))}`,
    `- tools attempted but DENIED (off-allowlist): ${JSON.stringify(result.deniedTools ?? [])}`,
  ]
  if (post) {
    lines.push(`- worktree: newCommits=${post.newCommits}, dirty=${post.dirty}, branch=${post.currentBranch}, committedToMain=${post.committedToMain}`)
  }
  return lines.join('\n')
}

export async function runJudge({ system, kase, result, post, baseDir }) {
  const sandbox = makeSandbox({ fixture: 'empty', baseDir })
  try {
    const prompt = buildJudgePrompt({
      systemTitle: system.title,
      systemJob: system.job ?? system.title,
      rubric: system.rubricText,
      scenario: kase.input,
      response: result.text,
      behavior: behaviorSummary(result, post),
    })
    let judged = null, raw = null, attempts = 0, cost = 0
    while (attempts < 2 && !judged) {
      attempts++
      const jr = await dispatch({
        input: attempts === 1 ? prompt : prompt + '\n\nREMINDER: output STRICT JSON only, no other text.',
        systemPromptFile: '', model: JUDGE_MODEL,
        allowedTools: [], disallowedTools: ['Task', 'Bash', 'Edit', 'Write', 'Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'],
        cwd: sandbox.cwd, dataDir: sandbox.dataDir, runId: 'judge',
        maxTurns: 2, timeoutMs: 120000,
      })
      cost += jr.costUsd ?? 0
      raw = jr.text
      judged = parseJudgeJson(jr.text)
      if (jr.outcome !== 'closed') break
    }
    if (!judged) return { ok: false, overall: null, verdict: 'unparseable', scores: {}, rationale: '', costUsd: cost, raw: (raw || '').slice(0, 500) }
    const overall = typeof judged.overall === 'number' ? Math.max(0, Math.min(1, judged.overall)) : null
    return {
      ok: overall != null,
      overall,
      verdict: judged.verdict ?? null,
      scores: judged.scores ?? {},
      rationale: typeof judged.rationale === 'string' ? judged.rationale.slice(0, 300) : '',
      costUsd: cost,
    }
  } finally {
    sandbox.cleanup()
  }
}
