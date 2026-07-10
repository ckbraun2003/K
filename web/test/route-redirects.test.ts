/** P4 W0a — the legacy-hash redirect contract: every removed rail entry resolves to its
 *  new canonical home; params preserved where the destination consumes them. */
import { describe, it, expect } from 'vitest'
import { parseHash, resolveRoute, isKnownView, KNOWN_VIEWS, VIEW_REDIRECTS } from '../src/lib/route'

const resolve = (hash: string) => resolveRoute(parseHash(hash))

describe('P4 route redirects (E-29/E-10/E-30)', () => {
  it('KNOWN_VIEWS is the final 15-member IA set (merged/folded strings removed)', () => {
    expect([...KNOWN_VIEWS].sort()).toEqual([
      'docs', 'home', 'inbox', 'insights', 'lessons', 'orchestrator', 'org', 'project',
      'projects', 'runs', 'settings', 'skill-creator', 'skills', 'timeline', 'verify',
    ])
    for (const gone of ['chief', 'orchestrators', 'graph', 'metrics', 'routing', 'evals', 'workflows', 'workflow-detail', 'memory', 'terminal'])
      expect(KNOWN_VIEWS.has(gone)).toBe(false)
  })
  it('Org merge redirects (chief/orchestrators/graph → org, correct segment)', () => {
    expect(resolve('#/chief')).toEqual({ view: 'org', param: 'tree' })          // Chief content = Tree segment
    expect(resolve('#/orchestrators')).toEqual({ view: 'org', param: 'roster' })
    expect(resolve('#/graph')).toEqual({ view: 'org', param: 'graph' })
  })
  it('Insights merge redirects (metrics/routing/evals → insights, correct tab)', () => {
    expect(resolve('#/metrics')).toEqual({ view: 'insights', param: 'charts' })
    expect(resolve('#/routing')).toEqual({ view: 'insights', param: 'routing' })
    expect(resolve('#/evals')).toEqual({ view: 'insights', param: 'evals' })
  })
  it('Runs fold: workflows list → runs/workflows; a workflow-run deep link → that run; a definition → the template editor', () => {
    expect(resolve('#/workflows')).toEqual({ view: 'runs', param: 'workflows', subParam: undefined })
    expect(resolve('#/workflows/run-uuid')).toEqual({ view: 'runs', param: 'run-uuid', subParam: undefined })
    expect(resolve('#/workflow-detail/def123')).toEqual({ view: 'runs', param: 'workflows', subParam: 'def123' })
  })
  it('Inbox fold + terminal relocation', () => {
    expect(resolve('#/memory')).toEqual({ view: 'inbox' })
    expect(resolve('#/terminal')).toEqual({ view: 'settings' })
  })
  it('every resolved view is a KNOWN_VIEW (no redirect lands on a NotFound)', () => {
    for (const src of Object.keys(VIEW_REDIRECTS))
      expect(isKnownView(resolveRoute(parseHash(`#/${src}`)).view)).toBe(true)
  })
  it('resolveRoute is idempotent (canonical routes pass through unchanged)', () => {
    const canon = { view: 'org', param: 'graph' as string | undefined, subParam: undefined }
    expect(resolveRoute(canon)).toEqual(canon)
    expect(resolveRoute({ view: 'home' })).toEqual({ view: 'home' })
  })
  it('non-redirected known + unknown views pass through', () => {
    expect(resolve('#/projects')).toEqual({ view: 'projects', param: undefined, subParam: undefined })
    expect(resolve('#/nonsense')).toEqual({ view: 'nonsense', param: undefined, subParam: undefined })
  })
})
