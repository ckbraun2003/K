// Canonical values mirror web/src/index.css :root — the ONLY sanctioned copy,
// used by canvas consumers (graph, health) and jsdom tests where CSS vars
// don't resolve. The ui-token guard test keeps hex out of everything else.
export const TOKEN_FALLBACKS: Record<string, string> = {
  '--bg': '#1b1030', '--bg-deep': '#140b26',
  '--surface': '#2a1a47', '--raised': '#33205c',
  '--border': '#3a2a5c', '--border-strong': '#4a3775',
  '--text': '#f4f0ff', '--muted': '#b3a6cd',
  '--accent': '#ff8fc0', '--accent-hover': '#38bdf8', '--on-accent': '#241640',
  '--green': '#34d399', '--amber': '#fbbf24', '--red': '#f87171',
  '--chart-1': '#ff8fc0', '--chart-2': '#34d399', '--chart-3': '#fbbf24',
  '--chart-4': '#38bdf8', '--chart-5': '#a855f7', '--chart-6': '#f87171',
  '--chart-7': '#c084fc', '--chart-8': '#6366f1', '--chart-other': '#4c3a6e',
}

export function readToken(name: string): string {
  if (typeof window !== 'undefined') {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    if (v) return v
  }
  return TOKEN_FALLBACKS[name] ?? ''
}
