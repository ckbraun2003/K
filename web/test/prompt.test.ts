import { describe, it, expect } from 'vitest'
import { cleanRunPrompt } from '../src/lib/prompt'

// The exact K seed instruction the cold-start reseed appends (k-thread.ts).
const SEED =
  "(You are K, the secretary front door. Handle logistics/Q&A/scheduling/notes/tasks yourself; " +
  "otherwise route engineering to the Chief or a named lead, stating the route first. Keep the " +
  "operator's task list in kstore scope='personal' (org items scope='org') — those persist across sessions.)"

describe('cleanRunPrompt (F-062)', () => {
  it('strips the synthesized "(You are K…)" seed suffix', () => {
    const raw = `You: what's the weather today?\n${SEED}`
    const out = cleanRunPrompt(raw)
    expect(out).toBe("what's the weather today?")
    expect(out).not.toContain('You are K')
    expect(out).not.toContain('secretary')
  })

  it('collapses a replayed transcript to the operator\'s last message', () => {
    const raw = ['You: hi', 'K: Hello! How can I help?', 'You: add milk to my list', SEED].join('\n')
    expect(cleanRunPrompt(raw)).toBe('add milk to my list')
  })

  it('keeps a multi-line current message intact (only the first line is `You:`-prefixed)', () => {
    const raw = ['You: fix the header', 'and also the footer', SEED].join('\n')
    expect(cleanRunPrompt(raw)).toBe('fix the header\nand also the footer')
  })

  it('handles a single-turn seed with no prior history', () => {
    expect(cleanRunPrompt(`You: hello there\n${SEED}`)).toBe('hello there')
  })

  it('passes a plain (non-synthesized) prompt through unchanged, trimmed', () => {
    expect(cleanRunPrompt('  Refactor the auth module.  ')).toBe('Refactor the auth module.')
  })

  it('does NOT collapse a non-K prompt that merely contains a literal "You:" line', () => {
    // No seed marker → not synthesized. An operator pasting a transcript to
    // summarize legitimately contains `You:` lines; the leading instruction must
    // be retained in full, not truncated to everything-after-the-last-`You:`.
    const raw =
      'Please review this support chat and summarize:\n' +
      'You: hi my invoice is wrong\n' +
      'Agent: let me check\n' +
      'Produce a 2-sentence summary.'
    expect(cleanRunPrompt(raw)).toBe(raw)
  })

  it('keys off the stable marker even if the surrounding wording changes', () => {
    // A reworded seed still opens with "(You are K" — cleaning must still strip it.
    const raw = 'You: ship it\n(You are K — do the routing thing differently now.)'
    expect(cleanRunPrompt(raw)).toBe('ship it')
  })

  it('never throws on a non-string prompt', () => {
    expect(cleanRunPrompt(undefined)).toBe('')
    expect(cleanRunPrompt(null)).toBe('')
    expect(cleanRunPrompt(42)).toBe('')
  })
})
