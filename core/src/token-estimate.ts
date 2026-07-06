/**
 * Token estimation — the ONE deliberate heuristic seam (host-integration Wave 0).
 *
 * `estimateTokens` approximates the token cost of a text as chars/4 (rounded up).
 * That is the widely-used English-prose rule of thumb for BPE-family tokenizers;
 * accuracy is roughly ±25% (code and non-Latin scripts skew denser — MORE tokens
 * per char — while long common words skew lighter). Every consumer labels the
 * result `est*` / "estimate", never a billed figure.
 *
 * WHY NO TOKENIZER DEPENDENCY (decision, not an oversight):
 *   - Claude 3+ tokenizer vocabularies are unpublished — there is nothing exact
 *     to depend on.
 *   - tiktoken (and friends) ship the WRONG vocab for Claude plus a wasm payload,
 *     buying false precision at real cost.
 *   - The estimate feeds RELATIVE UX signals (catalog token chips, enabled-set
 *     context-overhead totals), where ±25% on a consistent basis is fine.
 *
 * This module is the SWAP SEAM: if a real tokenizer ever becomes worth it, only
 * this one function changes — callers keep the same contract.
 */

/** Estimated token count for `text`: ceil(length/4); 0 for the empty string.
 *  `length` counts UTF-16 code units (JS string semantics) — astral characters
 *  (emoji, rare CJK) count as 2, which conveniently tracks their heavier real
 *  token cost. Pure, total, never throws. */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0
  return Math.ceil(text.length / 4)
}
