// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { WsMessage } from '@k/shared'
import {
  browserNotificationsSupported,
  ensureNotificationPermission,
  raiseBrowserNotification,
} from '../src/lib/notifications'

// Constructed Notification instances land here for assertion.
const instances: NotificationStub[] = []

class NotificationStub {
  static permission: NotificationPermission = 'granted'
  static requestPermission = vi.fn(async (): Promise<NotificationPermission> => 'granted')
  constructor(public title: string, public opts?: { body?: string; tag?: string }) {
    instances.push(this)
  }
}

let originalNotification: unknown

beforeEach(() => {
  instances.length = 0
  originalNotification = (window as unknown as { Notification?: unknown }).Notification
  NotificationStub.permission = 'granted'
  NotificationStub.requestPermission = vi.fn(async () => 'granted')
  ;(window as unknown as { Notification: unknown }).Notification = NotificationStub
})

afterEach(() => {
  ;(window as unknown as { Notification: unknown }).Notification = originalNotification
  // Drop the per-test visibilityState override → back to jsdom's default getter,
  // so a reordered/shared run can't inherit a stale 'hidden'/'visible' value.
  delete (document as unknown as { visibilityState?: unknown }).visibilityState
})

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
}

function notifMsg(over: Record<string, unknown> = {}): WsMessage {
  return {
    type: 'notification',
    browser: true,
    notification: {
      id: 'n1',
      eventKey: 'run_failed',
      title: 'Run failed',
      body: 'The run errored out.',
      runId: null,
      projectId: null,
      createdAt: 0,
      readAt: null,
    },
    ...over,
  } as WsMessage
}

describe('browserNotificationsSupported', () => {
  it('is true when the Notification API is present on window', () => {
    expect(browserNotificationsSupported()).toBe(true)
  })

  it('is false when the Notification API is absent', () => {
    delete (window as unknown as { Notification?: unknown }).Notification
    expect(browserNotificationsSupported()).toBe(false)
  })
})

describe('ensureNotificationPermission', () => {
  it('returns true when permission is already granted (no prompt)', async () => {
    NotificationStub.permission = 'granted'
    expect(await ensureNotificationPermission()).toBe(true)
    expect(NotificationStub.requestPermission).not.toHaveBeenCalled()
  })

  it('returns false when permission is denied', async () => {
    NotificationStub.permission = 'denied'
    expect(await ensureNotificationPermission()).toBe(false)
  })

  it('requests permission when the state is default', async () => {
    NotificationStub.permission = 'default'
    NotificationStub.requestPermission = vi.fn(async () => 'granted')
    expect(await ensureNotificationPermission()).toBe(true)
    expect(NotificationStub.requestPermission).toHaveBeenCalled()
  })
})

describe('raiseBrowserNotification', () => {
  it('raises for a valid hidden + granted + browser notification message', () => {
    NotificationStub.permission = 'granted'
    setVisibility('hidden')
    raiseBrowserNotification(notifMsg())
    expect(instances.length).toBe(1)
    expect(instances[0].title).toBe('Run failed')
    expect(instances[0].opts).toMatchObject({ body: 'The run errored out.', tag: 'n1' })
  })

  it('does NOT raise while the app tab is visible (foreground owns the surface)', () => {
    NotificationStub.permission = 'granted'
    setVisibility('visible')
    raiseBrowserNotification(notifMsg())
    expect(instances.length).toBe(0)
  })

  it('does NOT raise when the rule did not request a browser Notification', () => {
    NotificationStub.permission = 'granted'
    setVisibility('hidden')
    raiseBrowserNotification(notifMsg({ browser: false }))
    expect(instances.length).toBe(0)
  })

  it('does NOT raise when permission is not granted', () => {
    NotificationStub.permission = 'denied'
    setVisibility('hidden')
    raiseBrowserNotification(notifMsg())
    expect(instances.length).toBe(0)
  })

  it('does NOT raise for a non-notification message', () => {
    NotificationStub.permission = 'granted'
    setVisibility('hidden')
    raiseBrowserNotification({ type: 'pong' } as WsMessage)
    expect(instances.length).toBe(0)
  })
})
