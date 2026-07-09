import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { Notification as KNotification } from '@k/shared'
import { api } from '../lib/api'
import { navigate } from '../lib/route'
import { relativeTime } from '../lib/verify'
import { INBOX_KEY } from '../lib/inbox-query'
import { cn } from '../lib/cn'
import Toast from './Toast'

/**
 * E-19 — the in-app notification center. Reuses VerifyChip's popover shell
 * (fixed inset-0 backdrop + absolute z-50 panel + Escape-to-close). Reads the
 * durable notifications table (['notifications'], live-refreshed by
 * makeInboxInvalidator on a `notification` WS message).
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
        className="relative flex h-8 w-8 items-center justify-center rounded-lg text-[var(--muted)] transition-colors hover:text-[var(--text)]"
      >
        <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unread > 0 && (
          <span data-testid="notif-unread-dot" className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-[var(--amber)] glow-live" />
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            data-testid="notif-popover"
            className="absolute right-0 top-10 z-50 w-80 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-lg"
          >
            <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-2">
              <span className="text-xs font-semibold text-[var(--text)]">
                Notifications{unread > 0 && <span className="ml-1 text-[var(--muted)]">· {unread} unread</span>}
              </span>
              <button
                data-testid="notif-mark-all"
                onClick={() => markAll.mutate()}
                disabled={notifications.length === 0 || markAll.isPending}
                className="text-[11px] font-medium text-[var(--accent-hover)] transition-colors hover:underline disabled:opacity-40"
              >
                Mark all read
              </button>
            </div>

            <div className="max-h-96 overflow-y-auto">
              {notifications.length === 0 ? (
                <p className="px-3 py-8 text-center text-xs text-[var(--muted)]">No notifications yet.</p>
              ) : (
                notifications.map(n => (
                  <button
                    key={n.id}
                    data-testid={`notif-row-${n.id}`}
                    onClick={() => onRowClick(n)}
                    className={cn(
                      'flex w-full flex-col items-start gap-0.5 border-b border-[var(--border)] px-3 py-2 text-left transition-colors last:border-b-0 hover:bg-[var(--raised)]',
                      n.readAt != null && 'opacity-50',
                    )}
                  >
                    <div className="flex w-full items-center justify-between gap-2">
                      <span className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--text)]">{n.title}</span>
                      <span className="flex-shrink-0 text-[10px] text-[var(--muted)]">{relativeTime(n.createdAt)}</span>
                    </div>
                    {n.body && <span className="w-full truncate text-[11px] text-[var(--muted)]">{n.body}</span>}
                  </button>
                ))
              )}
            </div>
          </div>
        </>
      )}

      <Toast open={toast != null} message={toast ?? ''} testid="notif-toast" onDismiss={() => setToast(null)} />
    </span>
  )
}
