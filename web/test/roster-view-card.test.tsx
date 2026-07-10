/**
 * OrchestratorCard — the roster card's recent-run health line (C2). REAL counts
 * from the lead's activation history (OrchestratorRosterEntry.recent), never an
 * invented score/band: no history → NOTHING renders. Lives in a .tsx file because
 * component tests need jsdom (orchestrators.test.ts stays pure/node).
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import type { AgentProfile, OrchestratorRosterEntry } from '@k/shared'
import { OrchestratorCard } from '../src/pages/org/RosterView'

function profile(over: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'lead-frontend',
    name: 'Frontend',
    tier: 'orchestrator',
    charter: 'orchestrator',
    defaultModel: null,
    allowedTools: [],
    mcpServers: [],
    skills: [],
    ...over,
  }
}

function entry(over: Partial<OrchestratorRosterEntry> = {}): OrchestratorRosterEntry {
  return { profile: profile(), latestRun: null, live: false, wakes: 0, ...over }
}

afterEach(() => cleanup())

describe('OrchestratorCard — recent-run health line', () => {
  it('renders succeeded/total (green when zero failed)', () => {
    render(<OrchestratorCard entry={entry({ recent: { total: 5, succeeded: 5, failed: 0 } })} />)
    const line = screen.getByTestId('orchestrator-recent-lead-frontend')
    expect(line.textContent).toBe('5/5 recent ✓')
    expect(line.className).toContain('--green')
  })

  it('appends the failed count (amber) when failures exist', () => {
    render(<OrchestratorCard entry={entry({ recent: { total: 4, succeeded: 2, failed: 1 } })} />)
    const line = screen.getByTestId('orchestrator-recent-lead-frontend')
    expect(line.textContent).toBe('2/4 recent ✓ · 1 failed')
    expect(line.className).toContain('--amber')
  })

  it('renders NOTHING with no history — no invented health data', () => {
    render(<OrchestratorCard entry={entry()} />)
    expect(screen.queryByTestId('orchestrator-recent-lead-frontend')).toBeNull()

    cleanup()
    render(<OrchestratorCard entry={entry({ recent: { total: 0, succeeded: 0, failed: 0 } })} />)
    expect(screen.queryByTestId('orchestrator-recent-lead-frontend')).toBeNull()
  })
})
