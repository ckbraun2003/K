// Client-side cron validation that MIRRORS the server's node-cron v4 `validate`
// (core/src/routes/skills.ts → `cronValidate`). The goal is boundary parity:
// the client must accept exactly what the server accepts and reject exactly what
// it rejects, so the inline hint never blocks a legitimate expression nor lets a
// bad one reach the 400. This is a faithful, dependency-free port of node-cron's
// `convertExpression` + `validateDetailed` (its own `dist/pattern` modules), kept
// deliberately mechanical so it stays in lockstep with the bundled validator.
//
// node-cron accepts 5- or 6-field crontab syntax with `*`, `*/n`, `a-b`, `a-b/n`,
// comma lists, and month/weekday names. A missing seconds field defaults to '0'.

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december',
]
const SHORT_MONTHS = [
  'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug',
  'sep', 'oct', 'nov', 'dec',
]
const WEEK_DAYS = [
  'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
]
const SHORT_WEEK_DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

function convertNames(expression: string, items: string[], offset: number): string {
  let out = expression
  for (let i = 0; i < items.length; i++) {
    out = out.replace(new RegExp(items[i], 'gi'), String(i + offset))
  }
  return out
}

function convertMonthNames(expr: string): string {
  return convertNames(convertNames(expr, MONTHS, 1), SHORT_MONTHS, 1)
}

function convertWeekDayNames(expr: string): string {
  // node-cron maps 7→0 first, then long then short names → 0-based index.
  let out = expr.replace('7', '0')
  out = convertNames(out, WEEK_DAYS, 0)
  return convertNames(out, SHORT_WEEK_DAYS, 0)
}

const ASTERISK_RANGES = ['0-59', '0-59', '0-23', '1-31', '1-12', '0-6']

// DoS guard (finding S8-003): every real cron field maxes at 59, so the widest
// legitimate range is `0-59` (span 59). Any numeric span beyond this cap is
// implausible and must never be materialised — building it would freeze/OOM the
// thread (`checkCron` runs on every keystroke). Far above any real range, far
// below DoS territory.
const MAX_RANGE_SPAN = 1000

function convertAsterisk(expression: string, replacement: string): string {
  return expression.indexOf('*') !== -1 ? expression.replace('*', replacement) : expression
}

function convertRange(expression: string): string {
  const rangeRegEx = /(\d+)-(\d+)(\/(\d+)|)/
  let expr = expression
  let match = rangeRegEx.exec(expr)
  while (match !== null && match.length > 0) {
    const step = parseInt(match[4] || '1', 10)
    let first = parseInt(match[1], 10)
    let last = parseInt(match[2], 10)
    if (first > last) { const t = first; first = last; last = t }
    const numbers: number[] = []
    // DoS guard (S8-003): a `step <= 0` never advances `i` (infinite loop) and a
    // span past MAX_RANGE_SPAN would materialise a giant array before any bounds
    // check. `checkCron`'s pre-scan already rejects both before convertExpression
    // runs; this bound is belt-and-suspenders so convertRange itself can never
    // hang or blow the heap. When skipped, the empty replacement parses to NaN
    // downstream and is rejected by the per-field bounds check.
    if (step > 0 && last - first <= MAX_RANGE_SPAN) {
      for (let i = first; i <= last; i += step) numbers.push(i)
    }
    expr = expr.replace(new RegExp(match[0], 'i'), numbers.join())
    match = rangeRegEx.exec(expr)
  }
  return expr
}

/** Faithful port of node-cron's `convertExpression`. Returns per-field option arrays. */
function convertExpression(expression: string): Array<Array<number | 'L'>> {
  let parts = `${expression}`.replace(/\s{2,}/g, ' ').trim().split(' ')
  if (parts.length === 5) parts = ['0', ...parts]
  parts[4] = convertMonthNames(parts[4])
  parts[5] = convertWeekDayNames(parts[5])
  for (let i = 0; i < parts.length; i++) parts[i] = convertAsterisk(parts[i], ASTERISK_RANGES[i])
  for (let i = 0; i < parts.length; i++) parts[i] = convertRange(parts[i])
  return parts.map(field =>
    field.split(',').map(tok => (/^l$/i.test(tok.trim()) ? 'L' : parseInt(tok, 10))),
  )
}

const VALIDATION_REGEX = /^(?:\d+|\*|\*\/\d+)$/

function isValidField(options: Array<number | 'L'>, min: number, max: number): boolean {
  for (const option of options) {
    const optStr = String(option)
    const asInt = parseInt(optStr, 10)
    if ((!Number.isNaN(asInt) && (asInt < min || asInt > max)) || !VALIDATION_REGEX.test(optStr)) {
      return false
    }
  }
  return true
}

const FIELD_BOUNDS: Array<[number, number, string]> = [
  [0, 59, 'second'],
  [0, 59, 'minute'],
  [0, 23, 'hour'],
  [1, 31, 'day of month'],
  [1, 12, 'month'],
  [0, 7, 'week day'],
]

export interface CronCheck {
  valid: boolean
  /** Human-readable hint for an invalid expression (undefined when valid). */
  error?: string
}

/**
 * Validate a cron expression exactly as the server's node-cron v4 does.
 * Mirrors `validateDetailed`: illegal-char guard, 5/6-field count, per-field bounds.
 */
export function checkCron(pattern: string): CronCheck {
  if (typeof pattern !== 'string' || pattern.trim() === '') {
    return { valid: false, error: 'cron expression is required' }
  }
  if (!/^[a-zA-Z0-9\-*/, ]+$/.test(pattern)) {
    return { valid: false, error: 'contains illegal characters' }
  }
  const raw = pattern.replace(/\s{2,}/g, ' ').trim().split(' ')
  // node-cron v4's `validate` (core/src/routes/skills.ts) validates only the
  // first 6 fields and IGNORES trailing ones — `0 2 * * * * *` (7 fields) is
  // accepted by the server. So reject only when there are fewer than 5 core
  // fields; extras are tolerated for boundary parity.
  if (raw.length < 5) {
    return { valid: false, error: `expected at least 5 fields, got ${raw.length}` }
  }
  const displayFields = raw.length === 5 ? ['0', ...raw] : raw
  // DoS pre-scan (finding S8-003): reject a zero step (`*/0`, `1-5/0`) or an
  // implausibly wide range (`1-5000000`) BEFORE convertExpression expands it —
  // `checkCron` runs on every keystroke, so a `*/0` (unbounded loop) or a huge
  // span (multi-second array build) would freeze/OOM the tab. All real cron
  // fields max at 59, so any span over MAX_RANGE_SPAN is implausible. Only the
  // bounds-checked fields are scanned (trailing fields are tolerated, see above),
  // so this never rejects an expression the server would accept.
  for (const field of displayFields.slice(0, FIELD_BOUNDS.length)) {
    for (const tok of field.split(',')) {
      const stepMatch = /^\*\/(\d+)$/.exec(tok)
      if (stepMatch && parseInt(stepMatch[1], 10) <= 0) {
        return { valid: false, error: `"${field}" has a step of 0 (must be > 0)` }
      }
      const rangeMatch = /^(\d+)-(\d+)(?:\/(\d+))?$/.exec(tok)
      if (rangeMatch) {
        const step = parseInt(rangeMatch[3] ?? '1', 10)
        const span = Math.abs(parseInt(rangeMatch[2], 10) - parseInt(rangeMatch[1], 10))
        if (step <= 0 || span > MAX_RANGE_SPAN) {
          return { valid: false, error: `"${field}" is an invalid range (step > 0, span <= ${MAX_RANGE_SPAN})` }
        }
      }
    }
  }
  const executable = convertExpression(pattern)
  for (let i = 0; i < FIELD_BOUNDS.length; i++) {
    const [min, max, label] = FIELD_BOUNDS[i]
    // day-of-month allows the `L` (last) token, which is not range-checked.
    const opts = label === 'day of month' ? executable[i].filter(v => v !== 'L') : executable[i]
    if (!isValidField(opts, min, max)) {
      return { valid: false, error: `"${displayFields[i]}" is invalid for ${label} (${min}-${max})` }
    }
  }
  return { valid: true }
}

export function isValidCron(pattern: string): boolean {
  return checkCron(pattern).valid
}
