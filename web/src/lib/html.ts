/**
 * Strip <script> elements (and their contents) from a compiled HTML document.
 *
 * The Project Bible iframe is sandboxed WITHOUT `allow-scripts` (the compiled
 * artifact HTML is written verbatim, so granting scripts would be a stored-XSS
 * vector — see tasks/lessons.md). The browser therefore blocks the bible's inline
 * progressive-enhancement script (scroll-spy + j/k nav) and logs
 * "Blocked script execution in about:srcdoc" on EVERY render (finding #16).
 *
 * For the read-only viewer that script is pure enhancement, not required to read
 * the document. Removing it before injection eliminates the per-render console
 * error without weakening the sandbox.
 */
export function stripScripts(html: string): string {
  if (!html) return html
  // Remove paired <script>…</script> (any attributes, any casing, across lines)
  // plus any stray self-closed/unclosed <script …> opening tag for safety.
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*\/?>/gi, '')
}
