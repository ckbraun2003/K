// Source classification for the "register project" flow. A source string is
// either a VCS URL (cloned via gh) or a local filesystem path (registered in
// place). We classify it client-side so the modal can hint malformed input
// BEFORE the server 4xx (finding #25), and gate the Register button.
//
// IMPORTANT (finding that shipped in Wave C5): this app runs on Windows, so a
// valid local path like `C:\Users\ckbra\myrepo` or relative `repo\sub` must be
// recognised. The backslash branch must use a regex LITERAL character class
// `[/\\]` — in a `new RegExp("...")` string the `"\\"` collapses to a single
// backslash and the match breaks. Keep these as literals.

/** A VCS URL: https?:// , git@host:…, or anything ending in `.git`. */
export function isGithubUrl(s: string): boolean {
  const t = s.trim()
  return /^(https?:\/\/|git@)/.test(t) || /\.git$/.test(t)
}

/**
 * A local filesystem path: Windows drive (`C:\…` / `C:/…`), UNC (`\\host\share`),
 * POSIX/absolute (`/home/x`), home (`~/repo`), relative (`./`, `../`), or a bare
 * relative path containing a separator (`repo\sub`, `repo/sub`). Both separators
 * are matched via the regex-literal class `[/\\]`.
 */
export function isPathLike(s: string): boolean {
  const t = s.trim()
  if (t === '') return false
  return (
    /^[a-zA-Z]:[/\\]/.test(t) ||   // C:\repo or C:/repo
    /^\\\\/.test(t) ||             // \\server\share (UNC)
    /^[~./]/.test(t) ||            // ~/repo, ./repo, ../repo, /abs/path
    /^[\w.\- ]+[/\\]/.test(t)      // relative like repo\sub or repo/sub
  )
}

export type SourceKind = 'url' | 'path' | 'invalid'

/**
 * Classify a source string. URLs win over paths (a `.git` URL is never a path);
 * anything neither URL nor path-like (bare word, `!!!`, empty) is invalid.
 */
export function classifySource(s: string): SourceKind {
  const t = s.trim()
  if (t === '') return 'invalid'
  if (isGithubUrl(t)) return 'url'
  if (isPathLike(t)) return 'path'
  return 'invalid'
}
