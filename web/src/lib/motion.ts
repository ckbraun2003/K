import type { Transition, Variants } from 'framer-motion'

/**
 * Centralized Framer Motion presets — Phase H Wave 4.
 *
 * One source of truth for the harness's motion language so hero surfaces feel
 * consistent and stay 60fps (animate transform/opacity only). Dense data views
 * stay precision-minimal and should NOT pull from here.
 *
 * Reduced-motion: the global CSS rule in index.css neutralizes CSS
 * transitions/animations under `prefers-reduced-motion: reduce`, and the app
 * root wraps everything in `<MotionConfig reducedMotion="user">` so every
 * `motion.*` element honors the OS setting too. For imperative JS animation the
 * CSS/MotionConfig can't reach (e.g. the graph-canvas zoom), gate on
 * `prefersReducedMotion()`.
 */

/** True when the user asked the OS to reduce motion. Safe in SSR/no-window. */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  )
}

/* ── spring presets ─────────────────────────────────────────────────────── */

/** Snappy spring for micro-interactions (hover/tap on hero controls). */
export const springSnappy: Transition = { type: 'spring', stiffness: 420, damping: 32 }

/** Softer spring for surfaces that settle into place (modals, panels). */
export const springSoft: Transition = { type: 'spring', stiffness: 260, damping: 30 }

/* ── micro-interactions ─────────────────────────────────────────────────── */

/** Hover/tap lift for hero buttons & cards. Spread onto a motion element. */
export const microLift = {
  whileHover: { scale: 1.02, y: -1 },
  whileTap: { scale: 0.97 },
  transition: springSnappy,
} as const

/* ── modal / dialog enter-exit ──────────────────────────────────────────── */

/** Backdrop fade for overlay scrims. */
export const overlayFade: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { duration: 0.2 } },
  exit: { opacity: 0, transition: { duration: 0.18 } },
}

/** Card-style modal: fade + scale + slight rise on a soft spring. */
export const modalCard: Variants = {
  hidden: { opacity: 0, y: -16, scale: 0.98 },
  visible: { opacity: 1, y: 0, scale: 1, transition: springSnappy },
  exit: { opacity: 0, y: -16, scale: 0.98, transition: { duration: 0.15 } },
}

/** Centered dialog (confirm cards): gentler rise so it reads as "settled". */
export const dialogCard: Variants = {
  hidden: { opacity: 0, y: 8, scale: 0.97 },
  visible: { opacity: 1, y: 0, scale: 1, transition: springSoft },
  exit: { opacity: 0, y: 8, scale: 0.97, transition: { duration: 0.15 } },
}

/** Side panel (node inspector): slide in from the trailing edge. */
export const sidePanel: Variants = {
  hidden: { opacity: 0, x: 24 },
  visible: { opacity: 1, x: 0, transition: springSoft },
  exit: { opacity: 0, x: 24, transition: { duration: 0.18 } },
}

/* ── list / stagger ─────────────────────────────────────────────────────── */

// reserved for future list-stagger use
/** Parent that staggers children in. Pair with `staggerItem`. */
export const staggerContainer: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.035 } },
}

/** Child for a staggered list. */
export const staggerItem: Variants = {
  hidden: { opacity: 0, y: 6 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.2, ease: 'easeOut' } },
}

/* ── stage / tab transitions ────────────────────────────────────────────── */

/** Cross-fade with a small rise for stage/tab content swaps. */
export const stageTransition: Variants = {
  hidden: { opacity: 0, y: 8 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.22, ease: 'easeOut' } },
  exit: { opacity: 0, y: -8, transition: { duration: 0.16, ease: 'easeIn' } },
}

/** Plain fade for transient toasts/notices. */
export const fade: Variants = {
  hidden: { opacity: 0, y: 8 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.2, ease: 'easeOut' } },
  exit: { opacity: 0, y: 8, transition: { duration: 0.15 } },
}
