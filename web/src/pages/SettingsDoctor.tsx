/**
 * Settings → System requirements section (Wave 2 — the host-prerequisite "doctor"),
 * self-contained so the shared SettingsPage container edit stays minimal + additive
 * (mirrors SettingsModels / SettingsVoice).
 *
 * Detects whether the host tools K drives are installed: `claude` (the agent engine,
 * NOT bundled) + git/node are required; gh/ollama optional. A required-but-absent
 * tool reads as a problem (red banner + row); an optional-absent tool is a mild note.
 *
 * T20 — migrated onto the shared design-system primitives (GlassPanel/SectionHeader/
 * StatusPill/Tag/ErrorState/SkeletonRow). The status dot+label is now StatusPill,
 * colored off the SAME canonical status metas every other list on the app uses
 * (never an invented colour) — `doctorPillStatus` is the guard mapping so an
 * unrecognized tone can't slip an arbitrary string into `status`.
 *
 * NOTE (flagged, not guessed): the Install affordance MUST stay an <a href> — the
 * test contract (settings-doctor.test.tsx) asserts href/target/rel, which the
 * Button primitive (a <button>, no navigation attrs) cannot carry. Its className
 * mirrors Button's variant="primary" size="sm" visual set (bg-accent/text-on-accent/
 * rounded-control/etc.) adapted onto the anchor, so it reads as the same affordance.
 */
import { useQuery } from '@tanstack/react-query'
import type { DoctorReport, DoctorTool } from '@k/shared'
import { api } from '../lib/api'
import { GlassPanel } from '../ui/GlassPanel'
import { SectionHeader } from '../ui/SectionHeader'
import { StatusPill } from '../ui/StatusPill'
import { Tag } from '../ui/Tag'
import { ErrorState } from '../ui/ErrorState'
import { SkeletonRow } from '../ui/Skeleton'

/** Doctor row → StatusPill canonical status. Present tools read as 'done' (green);
 *  a missing REQUIRED tool is a problem ('error', red); a missing OPTIONAL tool is
 *  a mild/advisory note — mapped to 'queued' for its static-amber meta (not its
 *  literal queued-run meaning), since 'awaiting_input' carries the live pulse
 *  reserved for genuinely live states, wrong for a static readiness label. */
function doctorPillStatus(tool: DoctorTool): string {
  if (tool.present) return 'done'
  return tool.required ? 'error' : 'queued'
}

function DoctorToolRow({ tool }: { tool: DoctorTool }) {
  const status = tool.present
    ? 'Installed'
    : tool.required
      ? 'Missing (required)'
      : 'Not installed (optional)'
  return (
    <li className="flex items-start gap-3 py-3" data-testid={`doctor-tool-${tool.id}`}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-label font-semibold text-text">{tool.name}</span>
          {!tool.required && <Tag tint="neutral">OPTIONAL</Tag>}
          <span data-testid={`doctor-tool-${tool.id}-status`}>
            <StatusPill status={doctorPillStatus(tool)} label={status} />
          </span>
        </div>
        <p className="mt-0.5 text-caption text-muted">{tool.purpose}</p>
        {tool.present && tool.version && (
          <p className="mono mt-0.5 truncate text-micro text-muted" title={tool.version}>
            {tool.version}
          </p>
        )}
      </div>
      {!tool.present && (
        <a
          href={tool.installUrl}
          target="_blank"
          rel="noreferrer"
          data-testid={`doctor-tool-${tool.id}-install`}
          className="inline-flex flex-shrink-0 items-center justify-center h-7 px-2.5 rounded-control bg-accent text-on-accent text-label font-medium select-none transition-[transform,filter] duration-[var(--dur-1)] hover:brightness-110 active:scale-[0.98] focus-visible:glow-focus"
        >
          Install
        </a>
      )}
    </li>
  )
}

export function SystemRequirementsSection() {
  const { data, isLoading, error } = useQuery<DoctorReport>({
    queryKey: ['system-doctor'],
    queryFn: () => api.system.doctor(),
    refetchInterval: 60_000,
  })

  return (
    <GlassPanel tier="solid" className="p-4">
      <SectionHeader label="System requirements" as="h2" />
      <p className="mt-1 text-caption text-muted">
        Host tools K drives. The <span className="mono">claude</span> CLI is the agent engine and is
        not bundled — install and authenticate it. Optional tools degrade gracefully if absent.
      </p>

      {isLoading ? (
        <div className="mt-3">
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </div>
      ) : error || !data ? (
        <p className="mt-2 text-caption text-red">Failed to check host tools.</p>
      ) : (
        <div className="mt-3">
          {!data.ok && (
            <div data-testid="system-doctor-problem" className="mb-3">
              <ErrorState message="A required tool is missing — K can’t run agents until it’s installed." />
            </div>
          )}
          <ul className="flex flex-col divide-y divide-border">
            {data.tools.map(tool => (
              <DoctorToolRow key={tool.id} tool={tool} />
            ))}
          </ul>
        </div>
      )}
    </GlassPanel>
  )
}
