import type { Project } from '@k/shared'

/** Parse an @-prefixed query against a project list.
 *
 * Returns one of:
 *   { type: 'dispatch'; project; rest }   — unique match + space-separated rest
 *   { type: 'completion'; matches }        — partial prefix, no space yet
 *   { type: 'ambiguous'; prefix }          — multiple projects match the given prefix
 *   { type: 'none' }                       — no '@' prefix at all
 */
export type ProjectQueryResult =
  | { type: 'dispatch'; project: Project; rest: string }
  | { type: 'completion'; matches: Project[] }
  | { type: 'ambiguous'; prefix: string }
  | { type: 'none' }

export function parseProjectQuery(
  query: string,
  projects: Project[],
): ProjectQueryResult {
  if (!query.startsWith('@')) return { type: 'none' }

  const dispatchMatch = /^@(\S+)\s+(.+)$/.exec(query)
  if (dispatchMatch) {
    const prefix = dispatchMatch[1].toLowerCase()
    const rest = dispatchMatch[2]
    const exact = projects.find(p => p.name.toLowerCase() === prefix)
    if (exact) return { type: 'dispatch', project: exact, rest }
    const prefixMatches = projects.filter(p => p.name.toLowerCase().startsWith(prefix))
    if (prefixMatches.length === 1) return { type: 'dispatch', project: prefixMatches[0], rest }
    return { type: 'ambiguous', prefix: dispatchMatch[1] }
  }

  // @prefix with no space yet — completion mode
  const prefix = query.slice(1).toLowerCase()
  const matches = prefix
    ? projects.filter(p => p.name.toLowerCase().startsWith(prefix))
    : projects
  return { type: 'completion', matches }
}
