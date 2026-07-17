/**
 * SkillCreatorPage (wave C4) — the D-071 build→refine→evaluate→save flow,
 * fully mocked. Locks: brief → create → workspace navigation; the DRAFTING
 * state is labeled honestly (spinner + run link + "not saved" badge);
 * SkillDraftEditor recomposes frontmatter+body into ONE skillMd PATCH;
 * refine sends feedback and the revision counter reflects the draft; the
 * eval history renders with the shared EVAL_BADGE palette + run links; save
 * lands 201 → catalog navigation + highlight handoff, 409 stays inline; a
 * failed draft offers retry.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SkillDraft, DraftEval } from '@k/shared'

beforeAll(() => {
  if (!window.matchMedia) {
    // @ts-expect-error minimal stub for framer-motion
    window.matchMedia = (q: string) => ({ matches: false, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })
  }
})

const { mockList, mockGet, mockCreate, mockUpdate, mockRefine, mockEvaluate, mockEvals, mockSave, mockNavigate } =
  vi.hoisted(() => ({
    mockList: vi.fn(),
    mockGet: vi.fn(),
    mockCreate: vi.fn(),
    mockUpdate: vi.fn(),
    mockRefine: vi.fn(),
    mockEvaluate: vi.fn(),
    mockEvals: vi.fn(),
    mockSave: vi.fn(),
    mockNavigate: vi.fn(),
  }))

vi.mock('../src/lib/api', () => ({
  api: {
    skillCreator: {
      list: mockList,
      get: mockGet,
      create: mockCreate,
      update: mockUpdate,
      refine: mockRefine,
      evaluate: mockEvaluate,
      evals: mockEvals,
      save: mockSave,
      delete: vi.fn(),
    },
  },
}))
vi.mock('../src/lib/route', () => ({ navigate: mockNavigate }))

import SkillCreatorPage from '../src/pages/SkillCreatorPage'
import { CATALOG_HIGHLIGHT_KEY } from '../src/lib/catalog-highlight'
import { parseSkillMd, composeSkillMd } from '../src/components/SkillDraftEditor'

const READY_MD = '---\nname: pr-check\ndescription: Use when reviewing PRs\nlicense: MIT\n---\nDo the thing.'

function draft(over: Partial<SkillDraft> & Pick<SkillDraft, 'id'>): SkillDraft {
  return {
    nameHint: null,
    brief: 'review PRs for rollout notes',
    skillMd: null,
    revision: 0,
    status: 'drafting',
    runId: null,
    savedSkillId: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }
}

function renderPage(draftId?: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <SkillCreatorPage draftId={draftId} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  sessionStorage.clear()
  mockList.mockResolvedValue([])
  mockEvals.mockResolvedValue([])
})
afterEach(() => cleanup())

describe('SkillDraftEditor md helpers', () => {
  it('parse → compose round-trips, preserving frontmatter lines it does not own', () => {
    const parsed = parseSkillMd(READY_MD)
    expect(parsed.name).toBe('pr-check')
    expect(parsed.description).toBe('Use when reviewing PRs')
    expect(parsed.otherFrontmatter).toEqual(['license: MIT'])
    expect(parsed.body).toBe('Do the thing.')
    expect(composeSkillMd(parsed)).toBe(READY_MD)
  })

  it('a body-only document (no frontmatter) parses and recomposes unchanged', () => {
    const parsed = parseSkillMd('just a body')
    expect(parsed).toEqual({ name: '', description: '', otherFrontmatter: [], body: 'just a body' })
    expect(composeSkillMd(parsed)).toBe('just a body')
  })

  it('a block-scalar description stays ATOMIC in otherFrontmatter (never orphaned, never corrupted)', () => {
    const md = '---\nname: x\ndescription: |\n  line one\n  line two\nlicense: MIT\n---\nbody'
    const parsed = parseSkillMd(md)
    // the block scalar is NOT editable as a field — kept verbatim as one chunk
    expect(parsed.description).toBe('')
    expect(parsed.otherFrontmatter).toEqual(['description: |\n  line one\n  line two', 'license: MIT'])
    // untouched round-trip preserves it exactly
    expect(composeSkillMd(parsed)).toBe(md)
    // typing a simple description REPLACES the block scalar — no duplicate keys
    const edited = composeSkillMd({ ...parsed, description: 'Use when x' })
    expect(edited).toBe('---\nname: x\ndescription: Use when x\nlicense: MIT\n---\nbody')
  })

  it('duplicate simple keys cannot survive an edit (compose dedupes on the typed value)', () => {
    const md = '---\nname: first\nname: second\n---\nbody'
    const parsed = parseSkillMd(md)
    expect(parsed.name).toBe('first')
    expect(parsed.otherFrontmatter).toEqual(['name: second'])
    expect(composeSkillMd({ ...parsed, name: 'renamed' })).toBe('---\nname: renamed\n---\nbody')
  })

  it('an unterminated frontmatter fence is treated as body — nothing is dropped', () => {
    const md = '---\nname: broken\nno closing fence'
    const parsed = parseSkillMd(md)
    expect(parsed.body).toBe(md)
    expect(composeSkillMd(parsed)).toBe(md)
  })
})

describe('BriefForm (no draft selected)', () => {
  it('creates a draft from the brief + optional name hint and opens its workspace', async () => {
    mockCreate.mockResolvedValue(draft({ id: 'd-new' }))
    renderPage(undefined)
    fireEvent.change(screen.getByTestId('brief-input'), { target: { value: 'summarize PR risk' } })
    fireEvent.change(screen.getByTestId('brief-name-hint'), { target: { value: 'pr-risk' } })
    fireEvent.click(screen.getByTestId('brief-submit'))
    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith({ brief: 'summarize PR risk', nameHint: 'pr-risk' }),
    )
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('skill-creator', 'd-new'))
  })

  it('surfaces a create failure inline', async () => {
    mockCreate.mockRejectedValue(new Error('authoring dispatch unavailable'))
    renderPage(undefined)
    fireEvent.change(screen.getByTestId('brief-input'), { target: { value: 'x' } })
    fireEvent.click(screen.getByTestId('brief-submit'))
    expect((await screen.findByTestId('brief-error')).textContent).toBe('authoring dispatch unavailable')
  })
})

describe('DraftWorkspace — drafting state (honest labeling)', () => {
  it('shows the spinner, the run link, and the "not saved" badge', async () => {
    mockGet.mockResolvedValue(draft({ id: 'd1', status: 'drafting', runId: 'r1' }))
    renderPage('d1')
    await screen.findByTestId('draft-spinner')
    expect(screen.getByTestId('draft-badge-unsaved').textContent).toBe(
      'agent-generated draft — not saved',
    )
    expect(screen.queryByTestId('draft-badge-saved')).toBeNull()
    fireEvent.click(screen.getByTestId('draft-view-run'))
    expect(mockNavigate).toHaveBeenCalledWith('runs', 'r1')
    // no editor yet — the authoring run writes the first SKILL.md
    expect(screen.queryByTestId('draft-editor')).toBeNull()
  })
})

describe('DraftWorkspace — ready draft editing', () => {
  const ready = draft({ id: 'd1', status: 'ready', runId: 'r1', skillMd: READY_MD, revision: 1 })

  it('seeds the editor from the draft and PATCHes ONE recomposed skillMd on save', async () => {
    mockGet.mockResolvedValue(ready)
    mockUpdate.mockResolvedValue(ready)
    renderPage('d1')
    const nameInput = await screen.findByTestId('draft-editor-name')
    expect((nameInput as HTMLInputElement).value).toBe('pr-check')
    expect((screen.getByTestId('draft-editor-description') as HTMLInputElement).value).toBe(
      'Use when reviewing PRs',
    )
    fireEvent.change(screen.getByTestId('draft-editor-body'), { target: { value: 'Do it better.' } })
    fireEvent.click(screen.getByTestId('draft-editor-save'))
    await waitFor(() =>
      expect(mockUpdate).toHaveBeenCalledWith('d1', {
        skillMd: '---\nname: pr-check\ndescription: Use when reviewing PRs\nlicense: MIT\n---\nDo it better.',
      }),
    )
  })

  it('refine sends the feedback and shows the revision counter', async () => {
    mockGet.mockResolvedValue(ready)
    mockRefine.mockResolvedValue({ ...ready, revision: 2, status: 'drafting', runId: 'r2' })
    renderPage('d1')
    const panel = await screen.findByTestId('refine-panel')
    expect(panel.textContent).toContain('revision 1')
    fireEvent.change(screen.getByTestId('refine-feedback'), {
      target: { value: 'tighten the trigger description' },
    })
    fireEvent.click(screen.getByTestId('refine-submit'))
    await waitFor(() =>
      expect(mockRefine).toHaveBeenCalledWith('d1', 'tighten the trigger description'),
    )
    // the current revision's run is linked
    fireEvent.click(screen.getByTestId('revision-run-1'))
    expect(mockNavigate).toHaveBeenCalledWith('runs', 'r1')
  })

  it('evaluate fires the 202 endpoint and the history renders with badges + run links', async () => {
    mockGet.mockResolvedValue(ready)
    mockEvaluate.mockResolvedValue({ evalId: 'e2', runId: 'r-eval-2' })
    const history: DraftEval[] = [
      {
        id: 'e1',
        draftId: 'd1',
        runId: 'r-eval-1',
        status: 'pass',
        regression: false,
        baselineEvalId: null,
        createdAt: 1700000000000,
        completedAt: 1700000001000,
      },
    ]
    mockEvals.mockResolvedValue(history)
    renderPage('d1')
    const row = await screen.findByTestId('eval-row-e1')
    expect(row.textContent).toContain('pass')
    // the shared EVAL_BADGE palette (AutomationsTab export) styles the status —
    // now the canonical --green token (C3 token-drift fix), not raw text-green-300.
    expect(within(row).getByText('pass').className).toContain('text-[var(--green)]')
    fireEvent.click(screen.getByTestId('eval-run-link-e1'))
    expect(mockNavigate).toHaveBeenCalledWith('runs', 'r-eval-1')
    fireEvent.click(screen.getByTestId('eval-run'))
    await waitFor(() => expect(mockEvaluate).toHaveBeenCalledWith('d1'))
  })

  it('save 201 → highlight handoff + navigate to the catalog', async () => {
    mockGet.mockResolvedValue(ready)
    mockSave.mockResolvedValue({ skill: { id: 'pr-check' } })
    renderPage('d1')
    const nameInput = await screen.findByTestId('save-name')
    // prefilled from the draft's frontmatter name (no nameHint on this draft)
    expect((nameInput as HTMLInputElement).value).toBe('pr-check')
    fireEvent.click(screen.getByTestId('save-submit'))
    await waitFor(() => expect(mockSave).toHaveBeenCalledWith('d1', 'pr-check'))
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('agents', 'catalog'))
    expect(sessionStorage.getItem(CATALOG_HIGHLIGHT_KEY)).toBe('pr-check')
  })

  it('save 409 (name collision) stays inline — no navigation', async () => {
    mockGet.mockResolvedValue(ready)
    mockSave.mockRejectedValue(new Error('a skill named "pr-check" already exists'))
    renderPage('d1')
    await screen.findByTestId('save-name')
    fireEvent.click(screen.getByTestId('save-submit'))
    expect((await screen.findByTestId('save-error')).textContent).toBe(
      'a skill named "pr-check" already exists',
    )
    expect(mockNavigate).not.toHaveBeenCalledWith('agents', 'catalog')
    expect(sessionStorage.getItem(CATALOG_HIGHLIGHT_KEY)).toBeNull()
  })

  it('a saved draft shows the saved badge and a saved SaveBar (no resave form)', async () => {
    mockGet.mockResolvedValue({ ...ready, savedSkillId: 'pr-check' })
    renderPage('d1')
    await screen.findByTestId('draft-badge-saved')
    expect(screen.getByTestId('draft-badge-saved').textContent).toBe('saved to K library')
    expect(screen.queryByTestId('save-submit')).toBeNull()
    fireEvent.click(screen.getByTestId('save-view-catalog'))
    expect(mockNavigate).toHaveBeenCalledWith('agents', 'catalog')
  })
})

describe('DraftWorkspace — failed draft', () => {
  it('shows the failure + retry re-dispatches authoring via refine', async () => {
    mockGet.mockResolvedValue(draft({ id: 'd1', status: 'failed', runId: 'r-dead', skillMd: null }))
    mockRefine.mockResolvedValue(draft({ id: 'd1', status: 'drafting', runId: 'r-retry' }))
    renderPage('d1')
    await screen.findByTestId('draft-failed')
    fireEvent.click(screen.getByTestId('draft-retry'))
    await waitFor(() => expect(mockRefine).toHaveBeenCalledTimes(1))
    expect(mockRefine.mock.calls[0][0]).toBe('d1')
  })
})

describe('DraftList rail', () => {
  it('lists drafts (resumable), marks the open one, and "+ new draft" returns to the brief', async () => {
    mockList.mockResolvedValue([
      draft({ id: 'd1', nameHint: 'pr-risk', status: 'ready', skillMd: READY_MD }),
      draft({ id: 'd2', status: 'drafting' }),
    ])
    mockGet.mockResolvedValue(draft({ id: 'd1', status: 'ready', skillMd: READY_MD }))
    renderPage('d1')
    const item1 = await screen.findByTestId('draft-item-d1')
    expect(item1.getAttribute('aria-current')).toBe('page')
    expect(item1.textContent).toContain('pr-risk')
    fireEvent.click(screen.getByTestId('draft-item-d2'))
    expect(mockNavigate).toHaveBeenCalledWith('skill-creator', 'd2')
    fireEvent.click(screen.getByTestId('draft-new'))
    expect(mockNavigate).toHaveBeenCalledWith('skill-creator')
  })
})

describe('DraftWorkspace — cross-draft isolation (review C4-1)', () => {
  it('switching drafts REMOUNTS the workspace: SaveBar name re-seeds, no state leaks', async () => {
    const otherMd = '---\nname: other-skill\ndescription: something else\n---\nOther body.'
    mockGet.mockImplementation(async (id: string) =>
      id === 'd1'
        ? draft({ id: 'd1', status: 'ready', skillMd: READY_MD, runId: 'r1', revision: 1 })
        : draft({ id: 'd2', status: 'ready', skillMd: otherMd, runId: 'r9', revision: 1 }),
    )
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = render(
      <QueryClientProvider client={qc}>
        <SkillCreatorPage draftId="d1" />
      </QueryClientProvider>,
    )
    const name1 = await screen.findByTestId('save-name')
    expect((name1 as HTMLInputElement).value).toBe('pr-check')
    // simulate the hash route changing to another draft
    view.rerender(
      <QueryClientProvider client={qc}>
        <SkillCreatorPage draftId="d2" />
      </QueryClientProvider>,
    )
    await waitFor(() =>
      expect((screen.getByTestId('save-name') as HTMLInputElement).value).toBe('other-skill'),
    )
    // the previous draft's revision→run link must not survive into d2's panel:
    // d2's own rev-1 run is r9, and clicking it proves the map was re-seeded
    await screen.findByTestId('revision-run-1')
    fireEvent.click(screen.getByTestId('revision-run-1'))
    expect(mockNavigate).toHaveBeenCalledWith('runs', 'r9')
    expect(mockNavigate).not.toHaveBeenCalledWith('runs', 'r1')
  })
})
