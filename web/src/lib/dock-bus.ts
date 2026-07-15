/**
 * Focus-the-dock event bus (UI Simplification Task 8). A plain listener set —
 * mirrors `route.ts`'s module-level pattern — so any surface (Sidebar shortcut,
 * a keyboard chord, an empty-state CTA) can ask the MessageDock to take focus
 * without a prop-drilled callback through Shell: bar variant focuses its input,
 * float variant opens the overlay and focuses its input (Task 10 wires callers).
 */
type Cb = () => void
const cbs = new Set<Cb>()

export function focusDock(): void { for (const cb of cbs) cb() }

export function onDockFocus(cb: Cb): () => void {
  cbs.add(cb)
  return () => cbs.delete(cb)
}

/**
 * Prefill-the-dock channel (impressive-wave FE-4 systemic #2) — a suggestion
 * chip or empty-state CTA drops text into the composer and focuses it, without
 * a prop-drilled callback through Shell. Independent from the focus-only bus
 * above so a plain focus() call never fights a queued prefill.
 */
type PrefillFn = (text: string) => void
const prefillSubs = new Set<PrefillFn>()

export function prefillDock(text: string): void {
  prefillSubs.forEach(f => f(text))
  focusDock()
}

export function onDockPrefill(fn: PrefillFn): () => void {
  prefillSubs.add(fn)
  return () => { prefillSubs.delete(fn) }
}
