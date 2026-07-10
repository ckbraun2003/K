/**
 * SettingsPage / SystemRequirementsSection (Wave 2 — System Doctor).
 *
 * Renders the host-prerequisite card against a mocked doctor report and asserts a
 * required-but-absent tool reads as a problem (banner + status + an Install link),
 * while a present tool shows its version and offers no Install link. Mirrors
 * voice-section.test.tsx's mock-api + react-query-provider style.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { DoctorReport } from '@k/shared'

const doctorSpy = vi.fn<[], Promise<DoctorReport>>()
vi.mock('../src/lib/api', () => ({
  api: { system: { doctor: () => doctorSpy() } },
}))

import { SystemRequirementsSection } from '../src/pages/SettingsDoctor'

function renderWithQuery(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

// ok:false — a required tool (claude) is absent; git present; an optional tool (ollama) absent.
const REPORT: DoctorReport = {
  ok: false,
  tools: [
    {
      id: 'claude', name: 'Claude Code CLI', required: true, present: false, version: null,
      purpose: 'The agent engine K drives.', installUrl: 'https://docs.claude.com/en/docs/claude-code/overview',
    },
    {
      id: 'git', name: 'Git', required: true, present: true, version: 'git version 2.44.0',
      purpose: 'Version control.', installUrl: 'https://git-scm.com/downloads',
    },
    {
      id: 'ollama', name: 'Ollama', required: false, present: false, version: null,
      purpose: 'Optional local models.', installUrl: 'https://ollama.com/download',
    },
  ],
}

beforeEach(() => doctorSpy.mockReset())
afterEach(() => cleanup())

describe('SystemRequirementsSection — Wave 2', () => {
  it('a required-but-absent tool reads as a problem and offers an Install link', async () => {
    doctorSpy.mockResolvedValue(REPORT)
    renderWithQuery(<SystemRequirementsSection />)

    // The overall problem banner appears because ok:false.
    await screen.findByTestId('system-doctor-problem')

    // The claude row shows a "missing (required)" status + an Install link to its url.
    const status = screen.getByTestId('doctor-tool-claude-status')
    expect(status.textContent?.toLowerCase()).toContain('missing')
    const install = screen.getByTestId('doctor-tool-claude-install') as HTMLAnchorElement
    expect(install.getAttribute('href')).toBe('https://docs.claude.com/en/docs/claude-code/overview')
    expect(install.getAttribute('target')).toBe('_blank')
    expect(install.getAttribute('rel')).toBe('noreferrer')
  })

  it('a present tool shows its version and offers no Install link', async () => {
    doctorSpy.mockResolvedValue(REPORT)
    renderWithQuery(<SystemRequirementsSection />)
    await screen.findByTestId('doctor-tool-git')
    expect(screen.getByTestId('doctor-tool-git').textContent).toContain('git version 2.44.0')
    expect(screen.queryByTestId('doctor-tool-git-install')).toBeNull()
  })

  it('an optional-absent tool is flagged optional (a mild note, not the required-problem copy)', async () => {
    doctorSpy.mockResolvedValue(REPORT)
    renderWithQuery(<SystemRequirementsSection />)
    const ollamaStatus = await screen.findByTestId('doctor-tool-ollama-status')
    expect(ollamaStatus.textContent?.toLowerCase()).toContain('optional')
  })

  it('ok:true (all required present) renders NO problem banner', async () => {
    doctorSpy.mockResolvedValue({
      ok: true,
      tools: [
        { id: 'claude', name: 'Claude Code CLI', required: true, present: true, version: '2.1.0', purpose: 'x', installUrl: 'https://a' },
        { id: 'git', name: 'Git', required: true, present: true, version: 'git 2.44', purpose: 'x', installUrl: 'https://b' },
        { id: 'ollama', name: 'Ollama', required: false, present: false, version: null, purpose: 'x', installUrl: 'https://c' },
      ],
    })
    renderWithQuery(<SystemRequirementsSection />)
    // Wait for the rows to render, then assert the problem banner is absent.
    await screen.findByTestId('doctor-tool-claude')
    expect(screen.queryByTestId('system-doctor-problem')).toBeNull()
  })
})
