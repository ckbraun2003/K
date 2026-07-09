/** P2 A3 — PlanCard renders/edits/approves the parked plan. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { mockPlan, mockUpdate, mockApprove, mockDiscard } = vi.hoisted(() => ({
  mockPlan: vi.fn(), mockUpdate: vi.fn(), mockApprove: vi.fn(), mockDiscard: vi.fn(),
}))
vi.mock('../src/lib/api', () => ({
  api: { runs: { plan: mockPlan, updatePlan: mockUpdate, approvePlan: mockApprove, discardPlan: mockDiscard } },
}))
import PlanCard from '../src/components/PlanCard'

const RUN_ID = '11111111-2222-4333-8444-555555555555'
const WIRE = {
  runId: RUN_ID, edited: false, profileId: null, createdAt: 1, updatedAt: 1, approvedAt: null,
  raw: '```json…```',
  plan: { steps: [{ title: 'Add the route', detail: 'routes/plan.ts' }, { title: 'Test it' }], files: ['a.ts', 'b.ts'], risk: 'medium' },
}

beforeEach(() => {
  mockPlan.mockResolvedValue(WIRE)
  mockUpdate.mockResolvedValue({ ...WIRE, edited: true })
  mockApprove.mockResolvedValue({ run: { id: RUN_ID, status: 'running' } })
  mockDiscard.mockResolvedValue({ run: { id: RUN_ID, status: 'killed' } })
})
afterEach(() => cleanup())

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><PlanCard runId={RUN_ID} /></QueryClientProvider>)
}

describe('PlanCard', () => {
  it('renders steps, files, and the risk badge', async () => {
    renderCard()
    expect(await screen.findByTestId('plan-card')).toBeTruthy()
    expect(screen.getByTestId('plan-step-0').textContent).toContain('Add the route')
    expect(screen.getByTestId('plan-risk').textContent).toMatch(/medium/i)
    expect(screen.getByText('a.ts')).toBeTruthy()
  })

  it('edit → save PATCHes the full PlanDoc', async () => {
    renderCard()
    fireEvent.click(await screen.findByTestId('plan-edit'))
    const firstTitle = screen.getByDisplayValue('Add the route')
    fireEvent.change(firstTitle, { target: { value: 'Add the plan route' } })
    fireEvent.click(screen.getByTestId('plan-save'))
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith(RUN_ID, expect.objectContaining({
      risk: 'medium',
      steps: expect.arrayContaining([expect.objectContaining({ title: 'Add the plan route' })]),
    })))
  })

  it('approve is compose-is-confirm (dialog) and fires the mutation', async () => {
    renderCard()
    fireEvent.click(await screen.findByTestId('plan-approve'))
    // ConfirmDialog is up — confirm it via the dialog's confirm button. NOTE: the plan's
    // verbatim `findByRole('button', { name: /approve/i })` is ambiguous — the trigger
    // ("Approve → run") ALSO matches /approve/i — so target the ConfirmDialog testid
    // convention (`${testid}-confirm`) instead. Same intent: dialog confirm fires the mutation.
    fireEvent.click(await screen.findByTestId('plan-approve-dialog-confirm'))
    await waitFor(() => expect(mockApprove).toHaveBeenCalledWith(RUN_ID))
  })

  it('degraded plan (null) renders raw text, disables edit, keeps approve', async () => {
    mockPlan.mockResolvedValue({ ...WIRE, plan: null, raw: 'freeform plan text' })
    renderCard()
    expect((await screen.findByTestId('plan-raw')).textContent).toContain('freeform plan text')
    expect((screen.getByTestId('plan-edit') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('plan-approve') as HTMLButtonElement).disabled).toBe(false)
  })

  // Quality-review BLOCKER regression: clearing a step title must NOT crash the card
  // (it previously set title:undefined → the Save guard's .trim() threw → white screen).
  it('clearing a step title keeps the card mounted and disables Save', async () => {
    renderCard()
    fireEvent.click(await screen.findByTestId('plan-edit'))
    fireEvent.change(screen.getByDisplayValue('Add the route'), { target: { value: '' } })
    expect(screen.getByTestId('plan-card')).toBeTruthy() // no undefined.trim() crash
    expect((screen.getByTestId('plan-save') as HTMLButtonElement).disabled).toBe(true)
  })

  // Quality-review BLOCKER regression: the files textarea holds RAW text — pressing Enter
  // (a trailing newline) must survive, and a new line becomes a distinct file at save.
  // The old per-keystroke split/filter snapped the value back, swallowing the newline.
  it('files textarea preserves in-progress newlines and adds a distinct file at save', async () => {
    const { container } = renderCard()
    fireEvent.click(await screen.findByTestId('plan-edit'))
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'a.ts\nb.ts\n' } }) // Enter pressed
    expect(textarea.value).toBe('a.ts\nb.ts\n')                        // newline NOT swallowed
    fireEvent.change(textarea, { target: { value: 'a.ts\nb.ts\nc.ts' } })
    fireEvent.click(screen.getByTestId('plan-save'))
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith(RUN_ID, expect.objectContaining({
      files: ['a.ts', 'b.ts', 'c.ts'],
    })))
  })
})
