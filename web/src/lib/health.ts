import { readToken } from './tokens'

/**
 * E-12: the SINGLE health-score → color/label rubric. Replaces the drifting copies
 * in verify.ts, ProjectVerification, FleetGraphPage (hex), ProjectWorkspace, and
 * ProjectCard. Canonical thresholds: null→unknown, >=75 healthy, >=50 warn, else
 * critical. Exposes both a Tailwind class (`text`/`dot`) and a raw `hex` (for the
 * canvas/SVG fleet graph, which cannot take a class).
 */
export type HealthBand = 'unknown' | 'healthy' | 'warn' | 'critical'

export interface HealthRubricInfo {
  band: HealthBand
  label: string
  text: string   // Tailwind text-color class
  dot: string    // Tailwind bg-color class (for a status dot)
  hex: string    // raw hex (FleetGraph / canvas)
}

const BANDS: Record<HealthBand, Omit<HealthRubricInfo, 'band'>> = {
  unknown:  { label: 'unknown',  text: 'text-[var(--muted)]', dot: 'bg-[var(--muted)]', hex: readToken('--muted') },
  healthy:  { label: 'healthy',  text: 'text-[var(--green)]', dot: 'bg-[var(--green)]', hex: readToken('--green') },
  warn:     { label: 'warn',     text: 'text-[var(--amber)]', dot: 'bg-[var(--amber)]', hex: readToken('--amber') },
  critical: { label: 'critical', text: 'text-[var(--red)]',   dot: 'bg-[var(--red)]',   hex: readToken('--red') },
}

export function healthRubric(score: number | null): HealthRubricInfo {
  const band: HealthBand = score == null ? 'unknown' : score >= 75 ? 'healthy' : score >= 50 ? 'warn' : 'critical'
  return { band, ...BANDS[band] }
}
