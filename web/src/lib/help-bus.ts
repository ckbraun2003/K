// web/src/lib/help-bus.ts — Sidebar's Help entry opens the guide dialog that
// Shell owns (FE-6). Mirrors dock-bus: a zero-dep module event bus.
type Fn = () => void
const subs = new Set<Fn>()
export function openHelp() { subs.forEach(f => f()) }
export function onHelpOpen(fn: Fn) { subs.add(fn); return () => { subs.delete(fn) } }

// First-run auto-open check, homed here (not in Shell.tsx) so it stays a
// zero-dependency pure function — a test can import it directly instead of
// pulling in Shell's entire routed-page import graph just to unit-test one
// localStorage check. Returns true (and marks 'k.help.seen') only the very
// first time it's called for a given localStorage; every later call is false.
export function shouldAutoOpenHelp(): boolean {
  try {
    if (localStorage.getItem('k.help.seen')) return false
    localStorage.setItem('k.help.seen', '1')
    return true
  } catch {
    return false
  }
}
