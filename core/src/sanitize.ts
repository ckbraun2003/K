/**
 * HTML sanitizer for marked()-rendered markdown.
 *
 * The page chrome/template in artifacts.ts and bible.ts is trusted (author-
 * controlled), but the BODY is derived from user/agent-editable .md content and
 * must be neutralised before it is embedded or persisted. This allowlist keeps
 * the formatting the bible/artifacts actually use (headings, lists, tables,
 * code/pre, links, blockquote, span/div with class, task-list checkboxes) while
 * stripping <script>, event handlers (onerror=, onclick=, …), javascript: URLs,
 * and any other injection vector.
 */
import sanitizeHtml from 'sanitize-html'

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'p', 'br', 'hr',
    'ul', 'ol', 'li',
    'strong', 'em', 'b', 'i', 'del', 's', 'sup', 'sub',
    'blockquote',
    'code', 'pre',
    'a',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'span', 'div',
    'img',
    'input', // GFM task-list checkboxes
  ],
  allowedAttributes: {
    a: ['href', 'name', 'title'],
    img: ['src', 'alt', 'title'],
    span: ['class'],
    div: ['class'],
    code: ['class'],
    pre: ['class'],
    td: ['align'],
    th: ['align'],
    input: ['type', 'checked', 'disabled'],
  },
  // Only safe URL schemes — drops javascript:, data: (except images), vbscript:.
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { img: ['http', 'https'] },
  // Drop disallowed tags entirely (incl. their text) for <script>/<style>.
  nonTextTags: ['script', 'style', 'textarea', 'noscript'],
}

/** Sanitize marked()-rendered HTML against the bible/artifacts allowlist. */
export function sanitizeRenderedHtml(html: string): string {
  return sanitizeHtml(html, OPTIONS)
}
