import type { SkillSourceKind } from '@k/shared'

/**
 * Provenance badge — THE single color authority for the four capability source
 * kinds (D-069), shared by the catalog tabs and the CapabilityPicker so a
 * source reads the same everywhere. The plugin badge names the plugin (its
 * identity — "plugin" alone says nothing about what code the entry runs).
 *
 * Tag.tsx only ships 3 tints (neutral/accent/sky) — reusing it here would
 * collapse these 4 distinct provenance hues onto fewer than 4 colors,
 * defeating "read the source at a glance." Kept as a bespoke span, mapped onto
 * the sanctioned palette: sky stays sky (k), green stays green (claude-user),
 * yellow → amber (claude-project, nearest sanctioned hue), purple → blush/
 * accent (claude-plugin, nearest sanctioned hue) — 4 distinct hues preserved.
 */
export const SOURCE_BADGE: Record<SkillSourceKind, { label: string; className: string }> = {
  'k': { label: 'K', className: 'bg-accent-hover/20 text-accent-hover' },
  'claude-user': { label: 'user', className: 'bg-green/20 text-green' },
  'claude-project': { label: 'project', className: 'bg-amber/20 text-amber' },
  'claude-plugin': { label: 'plugin', className: 'bg-accent/20 text-accent' },
}

export default function SourceBadge({
  sourceKind,
  pluginName,
}: {
  sourceKind: SkillSourceKind
  /** Shown instead of the generic "plugin" label for claude-plugin entries. */
  pluginName?: string | null
}) {
  const { label, className } = SOURCE_BADGE[sourceKind]
  const text = sourceKind === 'claude-plugin' && pluginName ? pluginName : label
  // No testid — decorative within a row; tests assert through the parent row's
  // scoped testid (a literal id here would collide across list rows).
  return (
    <span
      title={`source: ${sourceKind}`}
      className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${className}`}
    >
      {text}
    </span>
  )
}
