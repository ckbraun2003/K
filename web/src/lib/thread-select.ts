import { useSyncExternalStore } from 'react'

/**
 * The one selected-thread store for the MessageDock (UI Simplification Task 8):
 * which durable K thread (`api.threads.*`, Task 7) the dock's composer currently
 * targets. `null` means "new chat draft" — the dock creates a thread lazily on
 * first send (Task 9), not on selection. A plain module store (mirrors
 * `dock-bus.ts`'s listener-set idiom) so the bar and float variants — and any
 * other future surface (e.g. a Chats list, Task 15) — share one source of truth
 * without prop drilling through Shell.
 *
 * UI Adjustments Task C1: the boot default is ALWAYS a new-chat draft (`null`)
 * — a reload never resumes the last-open thread. Full history stays one click
 * away in the Messages list; only the initial seed changed. In-session writes
 * still persist to localStorage (below) so a selection made THIS session
 * survives an in-page remount; `localStorage` access is guarded (private-
 * browsing / disabled-storage throws) so a blocked store degrades to
 * in-memory only.
 */
const KEY = 'k.chat.selected'
type Listener = (id: string | null) => void
const listeners = new Set<Listener>()
let selected: string | null = null

export function getSelectedThread(): string | null { return selected }

export function selectThread(id: string | null): void {
  selected = id
  try { id === null ? localStorage.removeItem(KEY) : localStorage.setItem(KEY, id) } catch { /* storage unavailable */ }
  for (const l of listeners) l(id)
}

export function subscribeSelectedThread(l: Listener): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** React binding — re-renders the caller on every in-page `selectThread` call, whether this
 *  surface's or another mounted surface's (both share the module store). NOT wired to the
 *  `storage` event, so a selection made in ANOTHER TAB won't re-render here until a reload —
 *  acceptable: chat selection is a per-surface convenience, not shared cross-tab state. */
export function useSelectedThread(): string | null {
  return useSyncExternalStore(subscribeSelectedThread, getSelectedThread)
}
