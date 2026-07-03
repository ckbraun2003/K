import path from 'path'

/**
 * True iff `abs` is contained under `root` — the shared path-traversal guard
 * (defends a base dir against `..` escape). BOTH sides are `path.resolve`d before
 * comparing, so a mixed-separator input (live-repro: a K_DATA_DIR like
 * `C:\\Users\\x\\repo/e2e/.data/ws-smoke` on Windows) normalizes to the same
 * canonical form as its resolved children instead of failing every raw
 * string-prefix check and bricking dispatch ("path escapes configDir"). The `sep`
 * handling treats a resolved `root` that still ends in a separator (a drive root —
 * path.resolve keeps "C:\\" as "C:\\") correctly.
 *
 * `inclusive` controls whether `abs === root` itself counts as "within":
 *   - default false — callers resolving a file UNDER root (artifacts/scaffold/
 *     onboard/ui-artifact) reject the root path itself;
 *   - true — agent-config allows the resolved dir to equal root.
 *
 * Extracted from 5 copies as part of F2.W2 de-dup; preserves each site's exact
 * semantics.
 */
export function isPathWithin(root: string, abs: string, opts: { inclusive?: boolean } = {}): boolean {
  const rootResolved = path.resolve(root)
  const absResolved = path.resolve(abs)
  if (absResolved === rootResolved) return opts.inclusive ?? false
  const sep = rootResolved.endsWith(path.sep) ? '' : path.sep
  return absResolved.startsWith(rootResolved + sep)
}
