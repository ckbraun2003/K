import { KForceRouteSchema, type KForceRoute } from '@k/shared'

/**
 * The force-route picker options shared by BOTH K composers (K-home + ⌘K's
 * plain-ask footer). Derived from the shared KForceRouteSchema enum so a new
 * member fails typecheck HERE (the Record below must be exhaustive) instead of
 * silently missing from one of the pickers. The full server-side route labels
 * live in K_ROUTE_LABELS via routeForTarget — these are the compact picker names.
 */
const SHORT_LABELS: Record<KForceRoute, string> = {
  chief: 'Chief',
  frontend: 'Frontend lead',
  backend: 'Backend lead',
  systems: 'Systems lead',
  security: 'Security lead',
  network: 'Network lead',
}

/** '' is Auto — the classifier decides (no forceRoute sent). */
export const FORCE_ROUTE_OPTIONS: ReadonlyArray<{ value: '' | KForceRoute; label: string }> = [
  { value: '', label: 'Route: auto' },
  ...KForceRouteSchema.options.map(t => ({ value: t, label: SHORT_LABELS[t] })),
]
