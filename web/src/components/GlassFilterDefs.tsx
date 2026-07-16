/**
 * LG2 refraction (impressive-wave W0.4) — the ONE inline SVG filter def the
 * glass tiers pull through `backdrop-filter: url(#lg-refract) …` (see the
 * @supports block in index.css). Chromium-first: engines that don't support
 * url() backdrop filters never match the guard and keep the plain-blur look.
 * Mounted exactly once, in Shell.
 */

/**
 * Mirrors `--lg-refract-scale` in web/src/index.css :root. CSS custom
 * properties cannot reach SVG filter-primitive attributes, so the number is
 * duplicated here as a literal — change BOTH together (tokens.test.ts pins the
 * token; glass-filter-defs.test.tsx pins this attr to the same value).
 */
export const LG_REFRACT_SCALE = 14

export default function GlassFilterDefs() {
  return (
    <svg aria-hidden focusable="false" width="0" height="0" style={{ position: 'absolute' }}>
      <filter id="lg-refract" x="-20%" y="-20%" width="140%" height="140%" colorInterpolationFilters="sRGB">
        <feTurbulence type="fractalNoise" baseFrequency="0.008 0.012" numOctaves="2" seed="7" result="noise" />
        <feDisplacementMap in="SourceGraphic" in2="noise" scale={LG_REFRACT_SCALE} xChannelSelector="R" yChannelSelector="G" />
      </filter>
    </svg>
  )
}
