import { useEffect, type RefObject } from 'react'

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Minimal modal focus trap (a11y, wave C1). While `active`, a keydown listener on
 * the container wraps Tab / Shift+Tab at the boundaries: Tab on the LAST focusable
 * element wraps to the first, Shift+Tab on the FIRST wraps to the last. The
 * CONTAINER itself is also a backward boundary: dialogs that open by focusing the
 * container (tabIndex={-1}, e.g. the evals RunDialog) would otherwise let Shift+Tab
 * fall through to the browser and walk focus backward OUT of the modal. Interior
 * tabbing is left to the browser. Focusables are re-queried per keydown so rows
 * added/removed while the dialog is open are always included. Focusing INTO the
 * dialog on open stays the caller's job (all our dialogs already do it).
 */
export function useFocusTrap(ref: RefObject<HTMLElement>, active: boolean) {
  useEffect(() => {
    if (!active) return
    const el = ref.current
    if (!el) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Tab' || !el) return
      const focusables = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE))
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (e.shiftKey && (document.activeElement === first || document.activeElement === el)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    el.addEventListener('keydown', onKeyDown)
    return () => el.removeEventListener('keydown', onKeyDown)
  }, [ref, active])
}
