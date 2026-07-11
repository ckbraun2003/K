/** P4 W0a — the legacy-hash redirect contract: every removed rail entry resolves to its
 *  new canonical home; params preserved where the destination consumes them. */
import { it, expect } from 'vitest'
import { parseHash, resolveRoute, KNOWN_VIEWS, VIEW_REDIRECTS } from '../src/lib/route'

const resolve = (hash: string) => resolveRoute(parseHash(hash))

it('KNOWN_VIEWS is the final 13-member IA set', () => {
  expect([...KNOWN_VIEWS].sort()).toEqual([
    'agents', 'docs', 'home', 'insights', 'orchestrator', 'personal', 'project',
    'projects', 'runs', 'settings', 'skill-creator', 'timeline', 'verify',
  ])
  for (const gone of ['org', 'skills', 'inbox', 'lessons', 'chief', 'orchestrators', 'graph',
    'metrics', 'routing', 'evals', 'workflows', 'workflow-detail', 'memory', 'terminal']) {
    expect(KNOWN_VIEWS.has(gone)).toBe(false)
  }
})

it('hub folds', () => {
  expect(resolve('#/org')).toEqual({ view: 'agents', param: 'org', subParam: 'roster' })
  expect(resolve('#/org/tree')).toEqual({ view: 'agents', param: 'org', subParam: 'tree' })
  expect(resolve('#/skills')).toEqual({ view: 'agents', param: 'skills', subParam: undefined })
  expect(resolve('#/skills/mcp')).toEqual({ view: 'agents', param: 'skills', subParam: 'mcp' })
  expect(resolve('#/inbox')).toEqual({ view: 'personal', param: 'inbox' })
  expect(resolve('#/lessons')).toEqual({ view: 'personal', param: 'inbox' })
  expect(resolve('#/runs/workflows')).toEqual({ view: 'agents', param: 'pipelines', subParam: undefined })
  expect(resolve('#/runs/workflows/def-1')).toEqual({ view: 'agents', param: 'pipelines', subParam: 'def-1' })
  expect(resolve('#/runs/run-123')).toEqual({ view: 'runs', param: 'run-123' })
})

it('pre-P4 legacy hashes land in the new hubs (one hop)', () => {
  expect(resolve('#/chief')).toEqual({ view: 'agents', param: 'org', subParam: 'tree' })
  expect(resolve('#/orchestrators')).toEqual({ view: 'agents', param: 'org', subParam: 'roster' })
  expect(resolve('#/graph')).toEqual({ view: 'agents', param: 'org', subParam: 'graph' })
  expect(resolve('#/metrics')).toEqual({ view: 'insights', param: 'charts' })
  expect(resolve('#/routing')).toEqual({ view: 'insights', param: 'routing' })
  expect(resolve('#/evals')).toEqual({ view: 'insights', param: 'evals' })
  expect(resolve('#/workflows')).toEqual({ view: 'agents', param: 'pipelines', subParam: undefined })
  expect(resolve('#/workflow-detail/def-9')).toEqual({ view: 'agents', param: 'pipelines', subParam: 'def-9' })
  expect(resolve('#/memory')).toEqual({ view: 'personal', param: 'inbox' })
  expect(resolve('#/terminal')).toEqual({ view: 'settings' })
})

it('surviving views resolve unchanged', () => {
  for (const keep of ['#/home', '#/personal/chats', '#/agents/pipelines', '#/projects', '#/insights/charts',
    '#/timeline', '#/docs/project-bible', '#/skill-creator', '#/settings', '#/orchestrator/frontend',
    '#/project/p1/runs', '#/verify/p1']) {
    const r = resolve(keep)
    expect(KNOWN_VIEWS.has(r.view)).toBe(true)
  }
})

it('every VIEW_REDIRECTS target is a KNOWN_VIEW (no dangling redirect targets)', () => {
  // Sweep the whole map generically so a redirect added/edited later (Tasks 10/18) can never
  // land on a NotFound: each key is resolved bare, with a param, and with a param+subParam.
  for (const src of Object.keys(VIEW_REDIRECTS)) {
    for (const hash of [`#/${src}`, `#/${src}/some-param`, `#/${src}/some-param/some-sub`]) {
      expect(KNOWN_VIEWS.has(resolve(hash).view), `dangling redirect target for ${hash}`).toBe(true)
    }
  }
})
