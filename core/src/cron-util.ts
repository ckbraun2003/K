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

/** Day-of-week / month name aliases → their numeric field values (node-cron accepts
 *  both). Substituted into a field BEFORE matching so `MON`/`JAN` etc. resolve. */
const DOW_NAMES: Record<string, string> = { sun: '0', mon: '1', tue: '2', wed: '3', thu: '4', fri: '5', sat: '6' }
const MON_NAMES: Record<string, string> = {
  jan: '1', feb: '2', mar: '3', apr: '4', may: '5', jun: '6',
  jul: '7', aug: '8', sep: '9', oct: '10', nov: '11', dec: '12',
}

/** Replace 3-letter named aliases (case-insensitive) in a cron field with their
 *  numeric equivalents; unknown 3-letter runs are left untouched. */
function replaceNames(field: string, table: Record<string, string>): string {
  return field.replace(/[a-z]{3}/gi, m => table[m.toLowerCase()] ?? m)
}

/** Parse a 5- OR 6-field cron and return the next fire time at/after `from` (exclusive),
 *  scanning minute-by-minute up to 366 days. Returns null if invalid or none found.
 *
 *  Matches everything node-cron's validate accepts (the create-form hint advertises
 *  "5 or 6 fields"): a 6-field expr (leading SECONDS) is reduced to its 5 minute-level
 *  fields (seconds are ignored at whole-minute resolution); day-of-week `7` is Sunday
 *  (== `0`); named day/month aliases (MON/JAN…) are normalized to numbers; and when
 *  BOTH day-of-month and day-of-week are restricted (non-`*`) the Vixie-cron rule fires
 *  on EITHER (OR), not both (AND). */
export function nextRunAt(expr: string, from = Date.now()): number | null {
  if (!isValidCron(expr)) return null
  const raw = expr.trim().split(/\s+/)
  // 6-field crons carry a leading SECONDS field; drop it and match at whole-minute
  // resolution (the "next run" display needs no sub-minute precision).
  const parts = raw.length === 6 ? raw.slice(1) : raw
  if (parts.length !== 5) return null
  const [min, hr, dom, monRaw, dowRaw] = parts
  // Named aliases (JAN.., MON..) → numbers before matching.
  const mon = replaceNames(monRaw, MON_NAMES)
  const dow = replaceNames(dowRaw, DOW_NAMES)
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
  // Day-of-week matcher: JS getDay() is 0..6 (Sun..Sat), but a cron dow field may use
  // `7` for Sunday — so a Sunday (0) ALSO matches a field that names 7.
  const matchesDow = (field: string, day: number): boolean =>
    matches(field, day, 0, 7) || (day === 0 && matches(field, 7, 0, 7))
  // Vixie-cron day semantics: if BOTH dom and dow are restricted, a match on EITHER
  // fires; otherwise (one is `*`) they AND (the `*` side is always true).
  const domRestricted = dom !== '*'
  const dowRestricted = dow !== '*'
  const start = new Date(Math.ceil((from + 1) / 60_000) * 60_000) // next whole minute
  for (let i = 0; i < 366 * 24 * 60; i++) {
    const t = new Date(start.getTime() + i * 60_000)
    if (!matches(min, t.getMinutes(), 0, 59)) continue
    if (!matches(hr, t.getHours(), 0, 23)) continue
    if (!matches(mon, t.getMonth() + 1, 1, 12)) continue
    const domOk = matches(dom, t.getDate(), 1, 31)
    const dowOk = matchesDow(dow, t.getDay())
    const dayOk = domRestricted && dowRestricted ? domOk || dowOk : domOk && dowOk
    if (dayOk) return t.getTime()
  }
  return null
}

export async function nlToCron(text: string, translate: (t: string) => Promise<string>): Promise<{ cron: string } | { error: string }> {
  const candidate = (await translate(text)).trim()
  if (!isValidCron(candidate)) return { error: `could not derive a valid cron from "${text}"` }
  return { cron: candidate }
}
