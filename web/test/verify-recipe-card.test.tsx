/**
 * VerifyRecipeCard (E-04, P1 Task 9/B2) — the per-project verify recipe
 * editor on the Verification tab. Locks: rows seed from project.verifyRecipe
 * (labels, commands + the ONE recipe-level timeoutMs); Save PATCHes the
 * edited recipe via api.projects.setVerifyRecipe; Clear is compose-is-confirm
 * (ConfirmDialog asks BEFORE the null PATCH fires); an empty timeout field
 * omits timeoutMs from the saved recipe.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Project } from '@k/shared'

beforeAll(() => {
  if (!window.matchMedia) {
    // @ts-expect-error minimal stub for framer-motion
    window.matchMedia = (q: string) => ({ matches: false, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })
  }
})

const { mockSetVerifyRecipe } = vi.hoisted(() => ({ mockSetVerifyRecipe: vi.fn() }))

vi.mock('../src/lib/api', () => ({
  api: {
    projects: {
      setVerifyRecipe: mockSetVerifyRecipe,
      list: vi.fn().mockResolvedValue([]),
      verifications: vi.fn().mockResolvedValue([]),
      verify: vi.fn(),
    },
  },
}))

import { VerifyRecipeCard } from '../src/pages/ProjectVerification'

function project(over: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'K',
    localPath: 'C:/repos/k',
    workspaceManaged: false,
    bibleDir: 'docs/bible',
    createdAt: 0,
    verifyRecipe: {
      commands: [
        { label: 'typecheck', run: 'pnpm typecheck' },
        { label: 'unit', run: 'pnpm vitest run' },
      ],
      timeoutMs: 60000,
    },
    ...over,
  }
}

function renderCard(p: Project = project()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <VerifyRecipeCard project={p} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockSetVerifyRecipe.mockResolvedValue(project())
})
afterEach(() => cleanup())

describe('VerifyRecipeCard', () => {
  it('renders rows seeded from project.verifyRecipe + the recipe-level timeout', () => {
    renderCard()
    expect((screen.getByTestId('recipe-label-0') as HTMLInputElement).value).toBe('typecheck')
    expect((screen.getByTestId('recipe-run-0') as HTMLInputElement).value).toBe('pnpm typecheck')
    expect((screen.getByTestId('recipe-label-1') as HTMLInputElement).value).toBe('unit')
    expect((screen.getByTestId('recipe-run-1') as HTMLInputElement).value).toBe('pnpm vitest run')
    // ONE recipe-level timeout field (per-recipe, NOT per-command)
    expect(screen.getAllByTestId('recipe-timeout')).toHaveLength(1)
    expect((screen.getByTestId('recipe-timeout') as HTMLInputElement).value).toBe('60000')
  })

  it('Save fires the mutation with the edited recipe (edit + added row + timeout)', async () => {
    renderCard()
    fireEvent.change(screen.getByTestId('recipe-label-0'), { target: { value: 'types' } })
    fireEvent.click(screen.getByTestId('recipe-add-row'))
    fireEvent.change(screen.getByTestId('recipe-label-2'), { target: { value: 'lint' } })
    fireEvent.change(screen.getByTestId('recipe-run-2'), { target: { value: 'pnpm lint' } })
    fireEvent.change(screen.getByTestId('recipe-timeout'), { target: { value: '90000' } })
    fireEvent.click(screen.getByTestId('recipe-save'))
    await waitFor(() =>
      expect(mockSetVerifyRecipe).toHaveBeenCalledWith('p1', {
        commands: [
          { label: 'types', run: 'pnpm typecheck' },
          { label: 'unit', run: 'pnpm vitest run' },
          { label: 'lint', run: 'pnpm lint' },
        ],
        timeoutMs: 90000,
      }),
    )
  })

  it('an emptied timeout field omits timeoutMs from the saved recipe', async () => {
    renderCard()
    fireEvent.change(screen.getByTestId('recipe-timeout'), { target: { value: '' } })
    fireEvent.click(screen.getByTestId('recipe-save'))
    await waitFor(() => expect(mockSetVerifyRecipe).toHaveBeenCalledTimes(1))
    expect(mockSetVerifyRecipe).toHaveBeenCalledWith('p1', {
      commands: [
        { label: 'typecheck', run: 'pnpm typecheck' },
        { label: 'unit', run: 'pnpm vitest run' },
      ],
    })
  })

  it('Clear asks first (compose-is-confirm) — the null PATCH fires only on confirm', async () => {
    renderCard()
    fireEvent.click(screen.getByTestId('recipe-clear'))
    // the dialog is up, nothing has fired
    expect(screen.getByTestId('recipe-clear-confirm')).toBeTruthy()
    expect(mockSetVerifyRecipe).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('recipe-clear-confirm-confirm'))
    await waitFor(() => expect(mockSetVerifyRecipe).toHaveBeenCalledWith('p1', null))
  })

  it('removing an earlier row keeps focus + values with the row being edited (stable keys)', () => {
    renderCard()
    const unitLabel = screen.getByTestId('recipe-label-1') as HTMLInputElement
    unitLabel.focus()
    fireEvent.click(screen.getByTestId('recipe-remove-0'))
    // the surviving row renders at index 0 with its OWN values…
    const survivor = screen.getByTestId('recipe-label-0') as HTMLInputElement
    expect(survivor.value).toBe('unit')
    // …and is the SAME DOM node the user was editing (index keys would remount).
    expect(survivor).toBe(unitLabel)
    expect(document.activeElement).toBe(survivor)
    expect(screen.queryByTestId('recipe-label-1')).toBeNull()
  })

  it('a project with NO recipe renders no rows and a disabled Clear', () => {
    renderCard(project({ verifyRecipe: undefined }))
    expect(screen.queryByTestId('recipe-label-0')).toBeNull()
    expect((screen.getByTestId('recipe-clear') as HTMLButtonElement).disabled).toBe(true)
    // Save stays disabled until a valid row is composed
    expect((screen.getByTestId('recipe-save') as HTMLButtonElement).disabled).toBe(true)
  })
})
