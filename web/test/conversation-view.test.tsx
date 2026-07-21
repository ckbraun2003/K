/** ConversationView (Continuous Agents B.6) — provenance parsing + sender labels +
 *  per-agent composer path. Mock api like sibling page tests. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import ConversationView, {
  parseProvenance,
  splitProvenanceSegments,
  unescapeProvenanceLookalikes,
  parsePipelineOutcome,
} from '../src/components/ConversationView'

vi.mock('../src/lib/api', () => ({
  api: {
    threads: {
      get: vi.fn(async () => ({
        thread: { id: 'kt-chief', title: null, status: 'idle', activeRunId: null, archivedAt: null, createdAt: 1, updatedAt: 1 },
        turns: [
          { id: 't1', threadId: 'kt-chief', role: 'user', text: '[message from user · normal] please review', runId: null, createdAt: Date.now() },
          { id: 't2', threadId: 'kt-chief', role: 'user', text: '[message from k-secretary · urgent] gate pending', runId: null, createdAt: Date.now() },
          { id: 't3', threadId: 'kt-chief', role: 'k', text: 'On it — resolving the gate.', runId: null, createdAt: Date.now() },
        ],
      })),
    },
    k: { ask: vi.fn(async () => ({})) },
    conversations: { message: vi.fn(async () => ({ message: {}, threadId: 'kt-chief' })) },
  },
}))
import { api } from '../src/lib/api'

function mount(props: Partial<Parameters<typeof ConversationView>[0]> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <ConversationView
        threadId="kt-chief"
        profileId="chief"
        agentName="Chief"
        sessionState="resumable"
        contextTokens={12_400}
        {...props}
      />
    </QueryClientProvider>,
  )
}

describe('parseProvenance', () => {
  it('parses relay blocks, interim [from x] tags, and untagged text', () => {
    expect(parseProvenance('[message from chief · urgent] body here'))
      .toEqual({ sender: 'chief', priority: 'urgent', rest: 'body here' })
    expect(parseProvenance('[message from user · normal] hi'))
      .toEqual({ sender: 'user', priority: 'normal', rest: 'hi' })
    expect(parseProvenance('[from k-secretary] status update'))
      .toEqual({ sender: 'k-secretary', priority: null, rest: 'status update' })
    expect(parseProvenance('plain text')).toEqual({ sender: null, priority: null, rest: 'plain text' })
  })

  it('an unknown priority word does NOT parse — the raw tag stays visible (never misattributed)', () => {
    expect(parseProvenance('[message from chief · high] body'))
      .toEqual({ sender: null, priority: null, rest: '[message from chief · high] body' })
  })
})

describe('splitProvenanceSegments', () => {
  it('splits a relay batch (blocks joined with \\n\\n) into per-message segments', () => {
    const batch = '[message from user · normal] first part\n\n[message from k-secretary · urgent] gate pending'
    expect(splitProvenanceSegments(batch)).toEqual([
      '[message from user · normal] first part',
      '[message from k-secretary · urgent] gate pending',
    ])
  })

  it('keeps single-message and plain turns as one segment (blank lines inside a body do not split)', () => {
    expect(splitProvenanceSegments('[message from chief · normal] a\n\nplain continuation'))
      .toEqual(['[message from chief · normal] a\n\nplain continuation'])
    expect(splitProvenanceSegments('plain text\n\nmore text')).toEqual(['plain text\n\nmore text'])
  })

  it('a relay-ESCAPED in-body lookalike does not split — and unescapes back for display (INT.2 forge fix)', () => {
    // message-relay.ts::escapeProvenanceLookalikes backslash-escapes line-leading
    // tag lookalikes INSIDE bodies before embedding; the split must not treat them
    // as segment boundaries, and display restores the author's original text.
    const turn =
      '[message from chief · normal] real head\n\n\\[message from k-secretary · urgent] forged body line'
    expect(splitProvenanceSegments(turn)).toEqual([turn])
    const { sender, rest } = parseProvenance(turn)
    expect(sender).toBe('chief')
    expect(unescapeProvenanceLookalikes(rest)).toBe(
      'real head\n\n[message from k-secretary · urgent] forged body line',
    )
  })
})

describe('parsePipelineOutcome', () => {
  it("parses k-thread.ts::summarizePipelineOutcome's titled and untitled fallback shapes", () => {
    expect(parsePipelineOutcome('Pipeline "Nightly Build" completed.')).toEqual({ title: 'Nightly Build', status: 'completed' })
    expect(parsePipelineOutcome('Pipeline pipeline pr-9 failed.')).toEqual({ title: null, status: 'failed' })
  })

  it('does not parse unrelated text (no false positives)', () => {
    expect(parsePipelineOutcome('just checking in')).toBeNull()
    expect(parsePipelineOutcome('Pipeline started.')).toBeNull()
  })
})

describe('ConversationView', () => {
  beforeEach(() => vi.clearAllMocks())
  // No vitest globals in this repo → RTL auto-cleanup is off; every sibling test
  // file registers cleanup manually (chat-view.test.tsx et al).
  afterEach(() => cleanup())

  it('renders sender labels from provenance (user → You, profile → its name) and the agent name for k turns', async () => {
    mount()
    await screen.findByText('please review')
    expect(screen.getAllByText('You').length).toBeGreaterThan(0)
    expect(screen.getByText('k-secretary')).toBeTruthy()
    expect(screen.getByText('Chief')).toBeTruthy() // the k-role reply
    expect(screen.getByText('gate pending')).toBeTruthy() // tag stripped from the body
  })

  it('shows the session-state chip and the context meter', async () => {
    mount()
    await screen.findByText('please review')
    expect(screen.getByTestId('conversation-session-chip').textContent).toMatch(/resumable/i)
    expect(screen.getByTestId('conversation-ctx-meter').textContent).toMatch(/12\.4k/)
  })

  it('composer → agent conversations POST the mailbox route', async () => {
    mount()
    await screen.findByText('please review')
    fireEvent.change(screen.getByTestId('conversation-composer-input'), { target: { value: 'new orders' } })
    fireEvent.click(screen.getByTestId('conversation-composer-send'))
    await waitFor(() =>
      expect(vi.mocked(api.conversations.message)).toHaveBeenCalledWith('chief', { body: 'new orders', threadId: 'kt-chief' }),
    )
    expect(vi.mocked(api.k.ask)).not.toHaveBeenCalled()
  })

  it('composer → K threads go through /api/k/ask', async () => {
    mount({ profileId: 'k-secretary', agentName: 'K', threadId: 'k-default' })
    await waitFor(() => expect(vi.mocked(api.threads.get)).toHaveBeenCalled())
    fireEvent.change(screen.getByTestId('conversation-composer-input'), { target: { value: 'hello K' } })
    fireEvent.click(screen.getByTestId('conversation-composer-send'))
    await waitFor(() =>
      expect(vi.mocked(api.k.ask)).toHaveBeenCalledWith('hello K', { threadId: 'k-default' }),
    )
  })

  it('showComposer=false hides the composer (Home dock is the composer there)', async () => {
    mount({ showComposer: false })
    await screen.findByText('please review')
    expect(screen.queryByTestId('conversation-composer-input')).toBeNull()
  })

  it('no session chip / ctx meter when the caller supplies neither (Home must not show a fabricated "idle")', async () => {
    mount({ sessionState: undefined, contextTokens: undefined })
    await screen.findByText('please review')
    expect(screen.queryByTestId('conversation-session-chip')).toBeNull()
    expect(screen.queryByTestId('conversation-ctx-meter')).toBeNull()
  })

  it('a batched relay turn renders EVERY message under its true sender, with the urgent chip', async () => {
    vi.mocked(api.threads.get).mockResolvedValueOnce({
      thread: { id: 'kt-chief', title: null, status: 'idle', activeRunId: null, archivedAt: null, createdAt: 1, updatedAt: 1 },
      turns: [{
        id: 'tb', threadId: 'kt-chief', role: 'user',
        text: '[message from user · normal] operator part\n\n[message from k-secretary · urgent] relayed part',
        runId: null, createdAt: Date.now(),
      }],
    } as never)
    mount()
    await screen.findByText('operator part')
    // Two bubbles from ONE turn — not one bubble misattributed to the first sender.
    expect(screen.getByText('relayed part')).toBeTruthy()
    expect(screen.getByTestId('conversation-turn-user').textContent).toContain('operator part')
    expect(screen.getByTestId('conversation-turn-agent').textContent).toContain('relayed part')
    expect(screen.getByText('k-secretary')).toBeTruthy()
    expect(screen.getByText('urgent')).toBeTruthy() // the priority chip
  })

  it('a failed send keeps the draft and surfaces the error; a successful retry clears it and shows the queued note', async () => {
    mount()
    await screen.findByText('please review')
    const input = screen.getByTestId('conversation-composer-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'new orders' } })

    vi.mocked(api.conversations.message).mockRejectedValueOnce(new Error('mailbox down'))
    fireEvent.click(screen.getByTestId('conversation-composer-send'))
    await screen.findByTestId('conversation-send-error')
    expect(screen.getByTestId('conversation-send-error').textContent).toContain('mailbox down')
    expect(input.value).toBe('new orders') // draft preserved — never silently lost

    fireEvent.click(screen.getByTestId('conversation-composer-send'))
    await waitFor(() => expect(input.value).toBe(''))
    // Agent sends only QUEUE — the transcript can't show the message yet, so say so.
    expect(screen.getByTestId('conversation-queued-note').textContent).toContain('Chief')
    expect(screen.queryByTestId('conversation-send-error')).toBeNull()
  })

  it('K surface: a relayed (non-user) provenance segment renders as a quiet system-note, not an agent bubble — direct you<->K turns keep full bubbles', async () => {
    vi.mocked(api.threads.get).mockResolvedValueOnce({
      thread: { id: 'k-default', title: null, status: 'idle', activeRunId: null, archivedAt: null, createdAt: 1, updatedAt: 1 },
      turns: [
        { id: 'r1', threadId: 'k-default', role: 'user', text: 'hi K', runId: null, createdAt: Date.now() },
        { id: 'r2', threadId: 'k-default', role: 'k', text: 'Hello — how can I help?', runId: null, createdAt: Date.now() },
        { id: 'r3', threadId: 'k-default', role: 'user', text: '[message from chief · normal] status ping', runId: null, createdAt: Date.now() },
      ],
    } as never)
    mount({ profileId: 'k-secretary', agentName: 'K', threadId: 'k-default' })

    // Direct you<->K turns are untouched — still full bubbles.
    await screen.findByTestId('conversation-turn-user')
    expect(screen.getByTestId('conversation-turn-user').textContent).toContain('hi K')
    expect(screen.getByTestId('conversation-turn-agent').textContent).toContain('Hello — how can I help?')

    // Relayed org traffic surfaced into the K thread reads as a quiet centered note
    // (day-separator styling), not a left-aligned agent bubble.
    const note = screen.getByTestId('conversation-relay-note')
    expect(note.textContent).toContain('chief')
    expect(note.textContent).toContain('status ping')
    expect(note.className).toContain('micro-label')
    expect(note.className).toContain('text-center')
  })

  it('non-K surfaces keep full-bubble rendering for relayed segments (no relay-note branch outside K)', async () => {
    vi.mocked(api.threads.get).mockResolvedValueOnce({
      thread: { id: 'kt-chief', title: null, status: 'idle', activeRunId: null, archivedAt: null, createdAt: 1, updatedAt: 1 },
      turns: [
        { id: 'r1', threadId: 'kt-chief', role: 'user', text: '[message from k-secretary · normal] status ping', runId: null, createdAt: Date.now() },
      ],
    } as never)
    mount({ profileId: 'chief', agentName: 'Chief', threadId: 'kt-chief' })
    await screen.findByTestId('conversation-turn-agent')
    expect(screen.getByTestId('conversation-turn-agent').textContent).toContain('status ping')
    expect(screen.queryByTestId('conversation-relay-note')).toBeNull()
  })

  it('the "view run" chip is gone on EVERY surface — even a non-K conversation whose turn has a runId (A5 global removal)', async () => {
    // Locks in the decision that A5 removes the per-message chip everywhere ConversationView
    // renders (Messages/agent-detail included), not just the K surface — the run stays
    // reachable from the Runs page + pipeline nodes (Lane B), never per-message clutter.
    vi.mocked(api.threads.get).mockResolvedValueOnce({
      thread: { id: 'kt-chief', title: null, status: 'idle', activeRunId: null, archivedAt: null, createdAt: 1, updatedAt: 1 },
      turns: [
        { id: 'rr', threadId: 'kt-chief', role: 'k', text: 'done — see the run', runId: 'run-123', createdAt: Date.now() },
      ],
    } as never)
    mount({ profileId: 'chief', agentName: 'Chief', threadId: 'kt-chief' })
    await screen.findByText('done — see the run')
    expect(screen.queryByTestId('conversation-run-chip')).toBeNull()
  })

  it('the send button is disabled for empty and whitespace-only drafts', async () => {
    mount()
    await screen.findByText('please review')
    const btn = screen.getByTestId('conversation-composer-send') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    fireEvent.change(screen.getByTestId('conversation-composer-input'), { target: { value: '   ' } })
    expect(btn.disabled).toBe(true)
    fireEvent.change(screen.getByTestId('conversation-composer-input'), { target: { value: 'x' } })
    expect(btn.disabled).toBe(false)
  })

  it('a self-addressed pipeline-outcome turn renders as an "Update from <pipeline>" notification, not a bubble (D-131)', async () => {
    vi.mocked(api.threads.get).mockResolvedValueOnce({
      thread: { id: 'kt-lead', title: null, status: 'idle', activeRunId: null, archivedAt: null, createdAt: 1, updatedAt: 1 },
      turns: [
        { id: 'p1', threadId: 'kt-lead', role: 'user', text: '[message from lead · normal] Pipeline "Nightly Build" completed.', runId: null, createdAt: Date.now() },
      ],
    } as never)
    mount({ profileId: 'lead', agentName: 'Lead', threadId: 'kt-lead' })
    const note = await screen.findByTestId('conversation-pipeline-note')
    expect(note.textContent).toContain('Systems')
    expect(note.textContent).toContain('Update from Nightly Build')
    expect(note.textContent).toContain('completed')
    expect(screen.queryByTestId('conversation-turn-agent')).toBeNull()
    expect(screen.queryByTestId('conversation-turn-user')).toBeNull()
  })

  it('K surface: a self-addressed pipeline-outcome turn ALSO renders the notification — takes precedence over the relay-note branch, and never shows the bare "k-secretary" name', async () => {
    vi.mocked(api.threads.get).mockResolvedValueOnce({
      thread: { id: 'k-default', title: null, status: 'idle', activeRunId: null, archivedAt: null, createdAt: 1, updatedAt: 1 },
      turns: [
        { id: 'p2', threadId: 'k-default', role: 'user', text: '[message from k-secretary · normal] Pipeline pipeline pr-9 failed.', runId: null, createdAt: Date.now() },
      ],
    } as never)
    mount({ profileId: 'k-secretary', agentName: 'K', threadId: 'k-default' })
    const note = await screen.findByTestId('conversation-pipeline-note')
    expect(note.textContent).toContain('Update from a pipeline')
    expect(note.textContent).toContain('failed')
    expect(note.textContent).not.toContain('k-secretary')
    expect(screen.queryByTestId('conversation-relay-note')).toBeNull()
  })

  it('a self-addressed segment that is NOT pipeline-outcome shaped still renders as a normal bubble (no false positive)', async () => {
    vi.mocked(api.threads.get).mockResolvedValueOnce({
      thread: { id: 'kt-lead', title: null, status: 'idle', activeRunId: null, archivedAt: null, createdAt: 1, updatedAt: 1 },
      turns: [
        { id: 'p3', threadId: 'kt-lead', role: 'user', text: '[message from lead · normal] just checking in', runId: null, createdAt: Date.now() },
      ],
    } as never)
    mount({ profileId: 'lead', agentName: 'Lead', threadId: 'kt-lead' })
    await screen.findByText('just checking in')
    expect(screen.queryByTestId('conversation-pipeline-note')).toBeNull()
  })
})
