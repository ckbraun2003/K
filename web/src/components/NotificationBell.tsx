import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { Notification as KNotification } from '@k/shared'
import { api } from '../lib/api'
import { navigate } from '../lib/route'
import { relativeTime } from '../lib/verify'
import { INBOX_KEY } from '../lib/inbox-query'
import { cn } from '../lib/cn'
import { Icon, type IconName } from '../ui/Icon'
import { IconButton } from '../ui/Button'
import Toast from './Toast'

/** Task 8 — one severity read per event key: an icon + color, never color alone. */
function severityFor(eventKey: string): { name: IconName; cls: string } {
  if (/fail|error|kill/.test(eventKey)) return { name: 'warning', cls: 'text-red' }
  if (/input|plan|review|trust|park/.test(eventKey)) return { name: 'warning', cls: 'text-amber' }
  if (/done|pass|merge/.test(eventKey)) return { name: 'check', cls: 'text-green' }
  return { name: 'bell', cls: 'text-muted' }
}

/**
 * E-19 — the in-app notification center. Reads the durable notifications table
 * (['notifications'], live-refreshed by makeInboxInvalidator on a `notification`
 * WS message).
 *
 * Task 8: the popover is portaled to document.body. It used to be an OPAQUE
 * DOM descendant of TopBar's glass-chrome header (a nested backdrop-filter would
 * be both disallowed and, since `fixed` is contained by any `backdrop-filter`
 * ancestor, mispositioned) — the portal escapes that subtree entirely, so
 * `glass-overlay` + true-viewport `fixed` positioning are both now correct.
 */
export default function NotificationBell() {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const { data } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.notifications.list({ limit: 15 }),
  })
  const notifications = data?.notifications ?? []
  const unread = data?.unread ?? 0

  // A read flip also changes the inbox badge's needs-YOU math on some kinds → refresh both.
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['notifications'] })
    void qc.invalidateQueries({ queryKey: INBOX_KEY })
  }

  // markRead / markAllRead go through react-query mutations so a failed request
  // surfaces via Toast (the InboxPage convention) instead of an unhandled
  // rejection that silently drops the read + refresh.
  const markRead = useMutation({
    mutationFn: (id: string) => api.notifications.markRead(id),
    onSuccess: refresh,
    onError: () => setToast('Could not mark the notification read.'),
  })
  const markAll = useMutation({
    mutationFn: () => api.notifications.markAllRead(),
    onSuccess: refresh,
    onError: () => setToast('Could not mark all notifications read.'),
  })

  function onRowClick(n: KNotification) {
    markRead.mutate(n.id)
    if (n.runId != null) {
      navigate('runs', n.runId)
      setOpen(false)
    }
  }

  return (
    <span className="relative">
      <button
        data-testid="notif-bell"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={unread > 0 ? `Notifications (${unread} unread)` : 'Notifications'}
        onClick={() => setOpen(o => !o)}
        className="relative flex h-8 w-8 items-center justify-center rounded-control text-muted transition-colors hover:text-text"
      >
        <Icon name="bell" size={16} />
        {unread > 0 && (
          <span data-testid="notif-unread-dot" className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-amber glow-live" />
        )}
      </button>

      {open && createPortal(
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            data-testid="notif-popover"
            className="glass-overlay fixed right-4 top-12 z-50 w-80 overflow-hidden rounded-control"
          >
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
              <span className="text-xs font-semibold text-text">
                Notifications{unread > 0 && <span className="ml-1 text-muted">· {unread} unread</span>}
              </span>
              <button
                data-testid="notif-mark-all"
                onClick={() => markAll.mutate()}
                disabled={notifications.length === 0 || markAll.isPending}
                className="text-[11px] font-medium text-accent-hover transition-colors hover:underline disabled:opacity-40"
              >
                Mark all read
              </button>
            </div>

            <div className="max-h-96 overflow-y-auto">
              {notifications.length === 0 ? (
                <p className="px-3 py-8 text-center text-xs text-muted">No notifications yet.</p>
              ) : (
                notifications.map(n => {
                  const sev = severityFor(n.eventKey)
                  return (
                    <div
                      key={n.id}
                      data-testid={`notif-row-${n.id}`}
                      role="button"
                      tabIndex={0}
                      onClick={() => onRowClick(n)}
                      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRowClick(n) } }}
                      className={cn(
                        'group flex w-full items-start gap-2 border-b border-border px-3 py-2 text-left transition-colors last:border-b-0 hover:bg-raised cursor-pointer',
                        n.readAt != null && 'opacity-50',
                      )}
                    >
                      <Icon name={sev.name} size={14} className={cn('mt-0.5 flex-shrink-0', sev.cls)} />
                      <div className="min-w-0 flex-1">
                        <div className="flex w-full items-center justify-between gap-2">
                          <span className="min-w-0 flex-1 truncate text-xs font-medium text-text">{n.title}</span>
                          <span className="mono flex-shrink-0 text-[10px] text-muted">{relativeTime(n.createdAt)}</span>
                        </div>
                        {n.body && <span className="block w-full truncate text-[11px] text-muted">{n.body}</span>}
                      </div>
                      {n.readAt == null && (
                        /* IN-6: true per-item delete pending a BE endpoint; mark-read is the dismiss. */
                        <IconButton
                          name="check"
                          label="Mark read"
                          size="sm"
                          variant="ghost"
                          className="flex-shrink-0 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
                          onClick={e => { e.stopPropagation(); markRead.mutate(n.id) }}
                        />
                      )}
                    </div>
                  )
                })
              )}
            </div>
          </div>
        </>,
        document.body,
      )}

      <Toast open={toast != null} message={toast ?? ''} kind="warning" testid="notif-toast" onDismiss={() => setToast(null)} />
    </span>
  )
}
