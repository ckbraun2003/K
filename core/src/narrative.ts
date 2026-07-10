/**
 * E-08 Run Narrative - deterministic derivation from a run's persisted facts, plus
 * OPTIONAL local-model Decisions/Risks bullets. The deterministic half is pure and
 * always renders; the bullet half is best-effort and degrades (the route decides the
 * bulletsState). No tools are ever advertised to the model - this is a pure
 * text-generation call (agent-visible seam rider: the prompt names no tool/server/skill).
 */
import type { RunNarrative, NarrativeBullets, RunStatus, VerifyStatus } from '@k/shared'
import { NarrativeBulletsSchema } from '@k/shared'
import type { OllamaChatTransport } from './ollama-agent/transport.js'

export interface NarrativeInputs {
  runId: string
  prompt: string
  status: RunStatus
  createdAt: number
  endedAt: number | null
  costUsd: number
  tokensIn: number
  tokensOut: number
  verify: { status: VerifyStatus; reason: string | null; commandCount: number } | null
  files: string[]
}

const GOAL_MAX = 280

/** First meaningful line(s) of the prompt, blank-trimmed and length-capped. */
export function cleanGoal(prompt: string): string {
  const firstLine = String(prompt).split('\n').map(l => l.trim()).find(l => l.length > 0) ?? ''
  return firstLine.length > GOAL_MAX ? firstLine.slice(0, GOAL_MAX - 1) + '…' : firstLine
}

export function deriveNarrative(input: NarrativeInputs): RunNarrative {
  return {
    runId: input.runId,
    goal: cleanGoal(input.prompt),
    outcome: {
      status: input.status,
      endedAt: input.endedAt,
      durationMs: input.endedAt != null ? input.endedAt - input.createdAt : null,
    },
    files: input.files,
    verification: input.verify
      ? { status: input.verify.status, reason: input.verify.reason, commandCount: input.verify.commandCount }
      : null,
    cost: { costUsd: input.costUsd, tokensIn: input.tokensIn, tokensOut: input.tokensOut },
    bullets: null,
    bulletsState: 'unavailable',
  }
}

const SYSTEM_PROMPT =
  'You summarize a COMPLETED AI coding run for a human reviewer. Reply with STRICT JSON ONLY, ' +
  'no prose and no markdown fences: {"decisions": string[], "risks": string[]}. At most 3 items ' +
  'each, one short sentence per item (<=120 chars). "decisions" = notable engineering choices the ' +
  'run appears to have made. "risks" = concerns or gaps a reviewer should double-check. If unsure, ' +
  'return empty arrays. Do not invent file names or facts beyond what you are given.'

function buildUserPrompt(d: RunNarrative): string {
  const v = d.verification ? `${d.verification.status}${d.verification.reason ? ` (${d.verification.reason})` : ''}` : 'not run'
  return [
    `Goal: ${d.goal}`,
    `Outcome: ${d.outcome.status}`,
    `Changed files: ${d.files.length ? d.files.join(', ') : '(none recorded)'}`,
    `Verification: ${v}`,
  ].join('\n')
}

/** Extract the first {...} object, parse it, clamp arrays to 3, stamp generated:true. */
export function parseBullets(text: string, model: string): NarrativeBullets | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let raw: unknown
  try { raw = JSON.parse(text.slice(start, end + 1)) } catch { return null }
  if (raw == null || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const clamp = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map(x => x.trim().slice(0, 500)).slice(0, 3) : []
  if (!Array.isArray(obj.decisions) || !Array.isArray(obj.risks)) return null
  const candidate = { decisions: clamp(obj.decisions), risks: clamp(obj.risks), generated: true as const, model }
  const parsed = NarrativeBulletsSchema.safeParse(candidate)
  return parsed.success ? parsed.data : null
}

export async function narrativeBullets(
  transport: OllamaChatTransport,
  model: string,
  deterministic: RunNarrative,
  signal?: AbortSignal,
): Promise<NarrativeBullets | null> {
  let text = ''
  for await (const chunk of transport.chat(
    {
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(deterministic) },
      ],
      options: { temperature: 0.2 },
    },
    signal,
  )) {
    text += chunk.message?.content ?? ''
  }
  return parseBullets(text, model)
}
