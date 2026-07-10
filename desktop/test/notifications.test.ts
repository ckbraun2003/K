import { describe, it, expect } from 'vitest'
import { notificationFromEnvelope, buildTrayMenu, coreWsUrl } from '../src/notifications'

describe('notificationFromEnvelope', () => {
  const envelope = (browser: boolean, over: Record<string, unknown> = {}) => ({
    type: 'notification',
    browser,
    notification: { title: 'Run needs your reply', body: 'refactor the auth module', runId: 'run-9', ...over },
  })

  it('raises a toast for an E-19 notification whose browser channel is on', () => {
    expect(notificationFromEnvelope(envelope(true))).toEqual({
      title: 'Run needs your reply',
      body: 'refactor the auth module',
      runId: 'run-9',
    })
  })

  it('stays silent when the browser channel is off (honors the operator rule)', () => {
    expect(notificationFromEnvelope(envelope(false))).toBeNull()
  })

  it('uses the title/body/runId already computed by core (no re-derivation)', () => {
    const n = notificationFromEnvelope(envelope(true, { title: 'Plan ready for review', body: null, runId: null }))
    expect(n).toEqual({ title: 'Plan ready for review', body: '', runId: undefined })
  })

  it('ignores non-notification messages and garbage', () => {
    expect(notificationFromEnvelope({ type: 'run_update', run: { id: 'r', status: 'done' } })).toBeNull()
    expect(notificationFromEnvelope({ type: 'event', event: {} })).toBeNull()
    expect(notificationFromEnvelope({ type: 'notification', browser: true })).toBeNull() // no notification body
    expect(notificationFromEnvelope({ type: 'notification', browser: true, notification: { title: '' } })).toBeNull()
    expect(notificationFromEnvelope(null)).toBeNull()
    expect(notificationFromEnvelope('nope')).toBeNull()
    expect(notificationFromEnvelope(42)).toBeNull()
  })
})

describe('buildTrayMenu', () => {
  it('shows Hide when the window is visible, Show when hidden; always offers Quit', () => {
    expect(buildTrayMenu(true)).toEqual([
      { label: 'Hide K', action: 'toggle' },
      { label: 'Quit K', action: 'quit' },
    ])
    expect(buildTrayMenu(false)[0].label).toBe('Show K')
  })
})

describe('coreWsUrl', () => {
  it('builds the loopback /ws url with the token in the query', () => {
    expect(coreWsUrl(51234, 'tok/with?special')).toBe(
      'ws://127.0.0.1:51234/ws?token=tok%2Fwith%3Fspecial',
    )
  })
})
