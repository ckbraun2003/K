// Canonical values mirror web/src/index.css :root — the ONLY sanctioned copy,
// used by canvas consumers (graph, health) and jsdom tests where CSS vars
// don't resolve. The ui-token guard test keeps hex out of everything else.
export const TOKEN_FALLBACKS: Record<string, string> = {
  '--bg': '#1b1030', '--bg-deep': '#140b26',
  '--surface': '#2a1a47', '--raised': '#33205c',
  '--border': '#3a2a5c', '--border-strong': '#4a3775',
  '--text': '#c6cede', '--muted': '#8f99ad',
  // Role anchors (ui-adjustments R4 / D-135) — user-tunable at runtime; mirrored from index.css :root.
  '--primary': '#e294e0', '--secondary': '#87cefa',
  // --accent unifies onto --primary (pink); --accent-hover/-hi are the resolved color-mix(primary, white)
  // values (72%/40%) since jsdom/canvas readers must never see a literal color-mix(...) string.
  '--accent': '#e294e0', '--accent-hover': '#eab2e9', '--accent-hi': '#f3d4f3', '--on-accent': '#241640',
  '--green': '#34d399', '--amber': '#fbbf24', '--red': '#f87171',
  '--chart-1': '#ff8fc0', '--chart-2': '#34d399', '--chart-3': '#fbbf24',
  '--chart-4': '#38bdf8', '--chart-5': '#a855f7', '--chart-6': '#f87171',
  '--chart-7': '#c084fc', '--chart-8': '#6366f1', '--chart-other': '#4c3a6e',
  '--graph-bg': '#14161c',
  // glass shade/opacity hierarchy (ui-adjustments Round 3, D-134) — color-by-role:
  // white panels warm w/ depth · pinkish-purple icons · sky-blue interactions;
  // mirrored from index.css :root.
  '--glass-1': 'rgba(255, 255, 255, 0.035)', '--glass-2': 'rgba(250, 238, 252, 0.06)',
  '--glass-3': 'rgba(244, 222, 248, 0.095)', '--glass-4': 'rgba(238, 210, 246, 0.145)',
  '--glass-icon': 'rgba(226, 148, 224, 0.20)', '--glass-icon-strong': 'rgba(226, 148, 224, 0.30)',
  '--icon-glyph': '#e6a4e5', '--glass-icon-edge': 'rgba(226, 148, 224, 0.55)',
  '--glass-hover': 'rgba(135, 206, 250, 0.18)', '--glass-active': 'rgba(135, 206, 250, 0.30)',
  '--glass-active-edge': 'rgba(135, 206, 250, 0.55)', '--glass-code': 'rgba(16, 12, 26, 0.55)',
  // LG2 + code-viewer (impressive-wave W0.2) — mirrored from index.css :root
  '--lg-blob-1': 'rgba(168, 85, 247, 0.16)', '--lg-blob-2': 'rgba(255, 143, 192, 0.13)',
  '--lg-blob-3': 'rgba(56, 189, 248, 0.11)', '--lg-blob-4': 'rgba(99, 102, 241, 0.10)',
  '--lg-edge': 'rgba(255, 255, 255, 0.12)', '--lg-sheen': 'rgba(255, 255, 255, 0.08)',
  '--code-keyword': '#c084fc', '--code-type': '#fcd34d', '--code-function': '#38bdf8',
  '--code-string': '#34d399', '--code-comment': '#958ab5', '--code-number': '#fbbf24',
  '--code-operator': '#7dd3fc', '--code-punctuation': '#b3a6cd', '--code-property': '#818cf8',
  '--code-tag': '#ff8fc0', '--code-attr': '#fcd34d',
}

// The two possible outputs of Background.tsx's onAccentFor() WCAG-luminance
// check (ui-adjustments Round 4) — dark ink for a light --primary, light ink
// for a dark one. Not CSS custom properties (there's no single static
// default; the choice depends on the operator's chosen primary hex at
// runtime) — kept here only because this file is the one raw-hex exemption
// in web/src/** (ui-token-gate.test.ts). ON_ACCENT_DARK matches the
// '--on-accent' fallback above, which was tuned for the default light
// --primary.
export const ON_ACCENT_DARK = '#241640'
export const ON_ACCENT_LIGHT = '#f2ecff'

export function readToken(name: string): string {
  if (typeof window !== 'undefined') {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    if (v) return v
  }
  return TOKEN_FALLBACKS[name] ?? ''
}
