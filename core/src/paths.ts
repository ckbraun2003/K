import path from 'path'

/**
 * True iff `abs` is contained under `root` — the shared path-traversal guard
 * (defends a base dir against `..` escape). The `sep` handling treats a `root`
 * that already ends in a separator (e.g. a Windows drive root "C:\\") correctly.
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
  if (abs === root) return opts.inclusive ?? false
  const sep = root.endsWith(path.sep) ? '' : path.sep
  return abs.startsWith(root + sep)
}
