import type React from 'react'

/**
 * Turn http(s) URLs in a plain string into anchors (F-079). Run-console text and
 * workflow-step details often carry PR / GitHub / CI run URLs ("PR #3 opened:
 * https://github.com/…") that were rendered as dead text — this makes them
 * clickable, opening in a new tab with `rel="noreferrer"` (no referrer/opener
 * leak). Non-URL text passes through untouched. Returns an array of React nodes
 * suitable to drop straight into JSX.
 */

// A URL run: `https://` or `http://` followed by non-space, non-bracket chars.
// Trailing sentence punctuation is trimmed off the match below so "…(url)." and
// "…url," don't swallow the closing paren / comma into the link.
const URL_RE = /(https?:\/\/[^\s<>]+)/g
const TRAILING_PUNCT_RE = /[.,;:!?)\]}'"]+$/

export function linkify(text: string): React.ReactNode[] {
  if (typeof text !== 'string' || text.length === 0) return [text]

  const parts: React.ReactNode[] = []
  let last = 0
  let key = 0
  let m: RegExpExecArray | null
  URL_RE.lastIndex = 0
  while ((m = URL_RE.exec(text)) !== null) {
    const raw = m[0]
    // Trim trailing punctuation that is almost certainly not part of the URL.
    const url = raw.replace(TRAILING_PUNCT_RE, '')
    const start = m.index
    if (url.length === 0) continue // pathological — keep scanning
    if (start > last) parts.push(text.slice(last, start))
    parts.push(
      <a
        key={`lk-${key++}`}
        href={url}
        target="_blank"
        rel="noreferrer"
        className="text-[var(--accent-hover)] underline underline-offset-2 hover:text-[var(--accent)]"
      >
        {url}
      </a>,
    )
    const consumed = start + url.length
    last = consumed
    // Re-scan from the end of the trimmed URL so trailing punctuation is emitted
    // as text rather than skipped.
    URL_RE.lastIndex = consumed
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}
