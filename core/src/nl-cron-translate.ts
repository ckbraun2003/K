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
  const am = text.match(/at (\d{1,2})\s*am/i)
  if (am) return `0 ${Number(am[1]) % 12} * * *`
  const pm = text.match(/at (\d{1,2})\s*pm/i)
  if (pm) return `0 ${(Number(pm[1]) % 12) + 12} * * *`
  for (const [re, cron] of RULES) if (re.test(text)) return cron
  return ''   // untranslatable → nlToCron rejects → route 400s
}
