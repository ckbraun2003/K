/**
 * Display-side cleaning for a run's synthesized prompt (F-062).
 *
 * A K (secretary) run is dispatched with a SYNTHESIZED prompt: the last few
 * durable thread turns replayed as `You:` / `K:` lines, the operator's current
 * `You: <message>` line, then a trailing parenthesized identity/routing
 * instruction (core `k-thread.ts::renderSeed` → `K_SEED_INSTRUCTION`). Rendering
 * that raw makes every run row unbounded and near-identical.
 *
 * `cleanRunPrompt` reduces such a prompt to the operator's actual message for
 * DISPLAY only (the stored prompt is untouched). It keys off a STABLE marker —
 * the seed instruction always opens with `(You are K` — rather than the exact
 * instruction text, so a later change to the surrounding wording (W7 reworks the
 * prompt construction) can't silently defeat the cleaning. A non-synthesized
 * prompt (a plain agent run) has neither the marker nor the transcript
 * scaffolding, so it passes through unchanged (trimmed).
 */

/** Stable opening of the K secretary seed instruction (see k-thread.ts). */
const K_SEED_MARKER = '(You are K'

/** The current-message line prefix in a replayed K transcript. */
const YOU_PREFIX = 'You: '

/**
 * Strip the synthesized scaffolding from a run prompt for display, returning the
 * operator's actual (last) message. Falls back to the trimmed input for prompts
 * that carry no recognizable scaffolding. Never throws.
 */
export function cleanRunPrompt(prompt: unknown): string {
  if (typeof prompt !== 'string') return ''

  // The `You:`/`K:` transcript scaffolding only exists ALONGSIDE the seed marker.
  // If the marker is absent this is NOT a synthesized K prompt (e.g. an operator
  // pasting a chat transcript to summarize, which legitimately contains `You:`
  // lines), so pass it through unchanged (trimmed) — collapsing it would silently
  // drop the real leading instruction.
  const markerIdx = prompt.indexOf(K_SEED_MARKER)
  if (markerIdx === -1) return prompt.trim()

  // Synthesized K prompt: 1. drop the trailing seed instruction, then 2. collapse
  // the replayed transcript to the operator's actual message — everything from the
  // FINAL `You: ` line to the end (a multi-line current message keeps its later
  // lines, which don't start with `You: `).
  let text = prompt.slice(0, markerIdx).trimEnd()
  const lastYou = text.lastIndexOf(`\n${YOU_PREFIX}`)
  if (lastYou !== -1) {
    text = text.slice(lastYou + 1 + YOU_PREFIX.length)
  } else if (text.startsWith(YOU_PREFIX)) {
    text = text.slice(YOU_PREFIX.length)
  }

  return text.trim()
}
