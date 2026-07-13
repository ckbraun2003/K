/**
 * E-16 cron helpers. isValidCron wraps node-cron's validate (the single source of
 * truth used across skills.ts + chief-wake.ts). nextRunAt is a deterministic 5-field
 * cron next-fire computation (no dependency on a running scheduler) for the routine
 * "next run" display. nlToCron translates a natural-language phrase to a cron string
 * via an injected translator (K/Ollama) and rejects anything that doesn't validate.
 */
import { validate as cronValidate } from 'node-cron'

export function isValidCron(expr: string): boolean {
  return cronValidate(expr)
}

/** Parse a 5-field cron and return the next fire time at/after `from` (exclusive),
 *  scanning minute-by-minute up to 366 days. Returns null if invalid or none found. */
export function nextRunAt(expr: string, from = Date.now()): number | null {
  if (!isValidCron(expr)) return null
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const [min, hr, dom, mon, dow] = parts
  const matches = (field: string, val: number, min0: number, max0: number): boolean => {
    if (field === '*') return true
    for (const seg of field.split(',')) {
      const stepM = seg.match(/^(\*|\d+(?:-\d+)?)\/(\d+)$/)
      if (stepM) {
        const step = Number(stepM[2])
        let lo = min0, hi = max0
        if (stepM[1] !== '*') { const r = stepM[1].split('-').map(Number); lo = r[0]; hi = r.length > 1 ? r[1] : max0 }
        for (let v = lo; v <= hi; v += step) if (v === val) return true
        continue
      }
      const rangeM = seg.match(/^(\d+)-(\d+)$/)
      if (rangeM) { if (val >= Number(rangeM[1]) && val <= Number(rangeM[2])) return true; continue }
      if (Number(seg) === val) return true
    }
    return false
  }
  const start = new Date(Math.ceil((from + 1) / 60_000) * 60_000) // next whole minute
  for (let i = 0; i < 366 * 24 * 60; i++) {
    const t = new Date(start.getTime() + i * 60_000)
    if (
      matches(min, t.getMinutes(), 0, 59) && matches(hr, t.getHours(), 0, 23) &&
      matches(dom, t.getDate(), 1, 31) && matches(mon, t.getMonth() + 1, 1, 12) &&
      matches(dow, t.getDay(), 0, 6)
    ) return t.getTime()
  }
  return null
}

export async function nlToCron(text: string, translate: (t: string) => Promise<string>): Promise<{ cron: string } | { error: string }> {
  const candidate = (await translate(text)).trim()
  if (!isValidCron(candidate)) return { error: `could not derive a valid cron from "${text}"` }
  return { cron: candidate }
}
