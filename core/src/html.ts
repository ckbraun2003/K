/**
 * Escape a string for safe interpolation into HTML text or a double-quoted
 * attribute. Escapes & < > and " (NOT ' — callers must use double-quoted
 * attributes). Extracted from 3 byte-identical copies (bible.ts / ui-artifact.ts
 * / artifacts.ts) as part of F2.W2 de-dup.
 */
export function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
