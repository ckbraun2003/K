/**
 * LG2 living-ambient layer (impressive-wave W0.3): the base wash plus four
 * hue-drifting gradient blobs the glass tiers blur/refract. Pure decoration —
 * aria-hidden, pointer-events none, GPU transforms only, frozen under
 * prefers-reduced-motion (index.css). Still the ONE decorative element.
 */
export default function Ambient() {
  return (
    <div className="ambient" aria-hidden data-testid="ambient">
      <div className="ambient-blob ambient-blob-1" />
      <div className="ambient-blob ambient-blob-2" />
      <div className="ambient-blob ambient-blob-3" />
      <div className="ambient-blob ambient-blob-4" />
    </div>
  )
}
