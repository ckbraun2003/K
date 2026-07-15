import { useSyncExternalStore } from 'react'

/**
 * ask-pending (Impressive Wave FE Task 9 Step 4) — a tiny external store that
 * names the thread id an in-flight `useAskK().send()` is targeting, so
 * ChatView can render a "K is thinking..." indicator on the right transcript
 * while the ask round-trip is outstanding. Mirrors thread-select.ts's module-
 * level store + useSyncExternalStore pattern (no context provider needed).
 * `null` means "no ask in flight" (also true for TreeView's `useAskK()` call,
 * which never passes a `threadId` — a harmless no-op for that caller).
 */
let pending: string | null = null
const subs = new Set<() => void>()

export function setAskPending(threadId: string | null) {
  pending = threadId
  subs.forEach(f => f())
}

export function useAskPending(): string | null {
  return useSyncExternalStore(cb => { subs.add(cb); return () => { subs.delete(cb) } }, () => pending)
}
