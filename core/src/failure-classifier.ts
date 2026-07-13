/**
 * E-18 deterministic failure classifier — maps a terminal run's status/stderr/exit code
 * to a FailureClass via an ordered pattern table (NO LLM). Drives self-heal retry vs. park.
 * An operator kill ('killed') and clean assertion/test failures are 'permanent' (never
 * auto-retried — retrying a real test failure just burns budget).
 */
import type { FailureClass } from '@k/shared'

const PATTERNS: Array<[RegExp, FailureClass]> = [
  [/overloaded_error|529|rate.?limit|429|capacity/i, 'model_capacity'],
  [/timed? ?out|deadline exceeded|etimedout/i, 'timeout'],
  [/enotfound|econnreset|econnrefused|socket hang up|connection reset|network|getaddrinfo|502|503|504/i, 'transient'],
  [/command not found|not recognized|no such file|permission denied|missing dependency|module not found/i, 'tooling'],
  [/assertion|expected .* to (?:equal|be)|test(?:s)? failed|compilation error|type error|syntaxerror/i, 'permanent'],
]

export function classifyFailure(input: { status: string; stderr?: string | null; exitCode?: number | null }): FailureClass {
  if (input.status === 'killed' || input.status === 'interrupted') return 'permanent'
  const text = input.stderr ?? ''
  if (!text) return 'unknown'
  for (const [re, cls] of PATTERNS) if (re.test(text)) return cls
  return 'unknown'
}

export function isRetryable(cls: FailureClass): boolean {
  return cls === 'transient' || cls === 'timeout' || cls === 'model_capacity'
}

/** Fallback model for a retry. Capacity → downgrade a tier; transient/timeout → same model.
 *  Non-retryable classes → null. Downgrade map is conservative + explicit (no price math). */
const DOWNGRADE: Record<string, string> = {
  'claude-opus-4-8': 'claude-sonnet-4-6',
  'claude-opus-4-6': 'claude-sonnet-4-6',
}
export function fallbackModel(current: string, cls: FailureClass): string | null {
  if (!isRetryable(cls)) return null
  if (cls === 'model_capacity') return DOWNGRADE[current] ?? current
  return current
}
