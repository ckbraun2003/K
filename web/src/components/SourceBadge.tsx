import type { SkillSourceKind } from '@k/shared'

/**
 * Provenance badge — THE single color authority for the four capability source
 * kinds (D-069), shared by the catalog tabs and the CapabilityPicker so a
 * source reads the same everywhere. The plugin badge names the plugin (its
 * identity — "plugin" alone says nothing about what code the entry runs).
 */
export const SOURCE_BADGE: Record<SkillSourceKind, { label: string; className: string }> = {
  'k': { label: 'K', className: 'bg-sky-500/20 text-sky-300' },
  'claude-user': { label: 'user', className: 'bg-green-500/20 text-green-300' },
  'claude-project': { label: 'project', className: 'bg-yellow-500/20 text-yellow-300' },
  'claude-plugin': { label: 'plugin', className: 'bg-purple-500/20 text-purple-300' },
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
