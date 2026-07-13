// E-16 NL→cron translation — RULES-ONLY (resolved decision, no model call). See
// cron-util.ts::nlToCron for the injection point + validation boundary. This module
// is the deterministic rule table: a small set of natural-language phrases map to a
// cron string; anything unmapped returns '' (nlToCron then rejects it as invalid,
// and the route answers 400). Never throws.
const RULES: Array<[RegExp, string]> = [
  [/every minute/i, '* * * * *'],
  [/hourly|every hour/i, '0 * * * *'],
  [/every monday/i, '0 9 * * 1'],
  [/weekday|monday to friday|every weekday/i, '0 9 * * 1-5'],
  [/daily|every day|each day/i, '0 9 * * *'],
]

export async function translateNlToCron(text: string): Promise<string> {
  // 12-hour clock: only 1..12 is a valid hour digit. Without this bound "at 25am"
  // slips through `%12` → a valid-but-WRONG cron ("0 1 * * *"); reject it so nlToCron
  // rejects the empty string and the route 400s instead of scheduling the wrong time.
  const am = text.match(/at (\d{1,2})\s*am/i)
  if (am) {
    const h = Number(am[1])
    if (h < 1 || h > 12) return ''
    return `0 ${h % 12} * * *`         // 12am → 0
  }
  const pm = text.match(/at (\d{1,2})\s*pm/i)
  if (pm) {
    const h = Number(pm[1])
    if (h < 1 || h > 12) return ''
    return `0 ${(h % 12) + 12} * * *`  // 12pm → 12
  }
  for (const [re, cron] of RULES) if (re.test(text)) return cron
  return ''   // untranslatable → nlToCron rejects → route 400s
}
