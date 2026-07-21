// Canonical values mirror web/src/index.css :root — the ONLY sanctioned copy,
// used by canvas consumers (graph, health) and jsdom tests where CSS vars
// don't resolve. The ui-token guard test keeps hex out of everything else.
export const TOKEN_FALLBACKS: Record<string, string> = {
  '--bg': '#1b1030', '--bg-deep': '#140b26',
  '--surface': '#2a1a47', '--raised': '#33205c',
  '--border': '#3a2a5c', '--border-strong': '#4a3775',
  '--text': '#c6cede', '--muted': '#8f99ad',
  '--accent': '#a855f7', '--accent-hover': '#c084fc', '--accent-hi': '#e9d5ff', '--on-accent': '#241640',
  '--green': '#34d399', '--amber': '#fbbf24', '--red': '#f87171',
  '--chart-1': '#ff8fc0', '--chart-2': '#34d399', '--chart-3': '#fbbf24',
  '--chart-4': '#38bdf8', '--chart-5': '#a855f7', '--chart-6': '#f87171',
  '--chart-7': '#c084fc', '--chart-8': '#6366f1', '--chart-other': '#4c3a6e',
  '--terminal-bg': '#0b0e14',
  '--graph-bg': '#14161c',
  // glass shade/opacity hierarchy (ui-adjustments Round 2, D-133) — graded
  // translucent tints for "everything-glass"; mirrored from index.css :root.
  '--glass-1': 'rgba(255, 255, 255, 0.055)', '--glass-2': 'rgba(228, 220, 248, 0.09)',
  '--glass-3': 'rgba(186, 156, 232, 0.14)', '--glass-4': 'rgba(158, 124, 218, 0.20)',
  '--glass-active': 'rgba(96, 170, 250, 0.22)',
  // LG2 + code-viewer (impressive-wave W0.2) — mirrored from index.css :root
  '--lg-blob-1': 'rgba(168, 85, 247, 0.16)', '--lg-blob-2': 'rgba(255, 143, 192, 0.13)',
  '--lg-blob-3': 'rgba(56, 189, 248, 0.11)', '--lg-blob-4': 'rgba(99, 102, 241, 0.10)',
  '--lg-edge': 'rgba(255, 255, 255, 0.12)', '--lg-sheen': 'rgba(255, 255, 255, 0.08)',
  '--code-keyword': '#c084fc', '--code-type': '#fcd34d', '--code-function': '#38bdf8',
  '--code-string': '#34d399', '--code-comment': '#958ab5', '--code-number': '#fbbf24',
  '--code-operator': '#7dd3fc', '--code-punctuation': '#b3a6cd', '--code-property': '#818cf8',
  '--code-tag': '#ff8fc0', '--code-attr': '#fcd34d',
}

export function readToken(name: string): string {
  if (typeof window !== 'undefined') {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    if (v) return v
  }
  return TOKEN_FALLBACKS[name] ?? ''
}
