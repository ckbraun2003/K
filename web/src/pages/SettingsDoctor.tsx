/**
 * Settings → System requirements section (Wave 2 — the host-prerequisite "doctor"),
 * self-contained so the shared SettingsPage container edit stays minimal + additive
 * (mirrors SettingsModels / SettingsVoice).
 *
 * Detects whether the host tools K drives are installed: `claude` (the agent engine,
 * NOT bundled) + git/node are required; gh/ollama optional. A required-but-absent
 * tool reads as a problem (red banner + row); an optional-absent tool is a mild note.
 *
 * All colours are existing midnight-glass CSS vars via toneColor (no new palette).
 */
import { useQuery } from '@tanstack/react-query'
import type { DoctorReport, DoctorTool } from '@k/shared'
import { api } from '../lib/api'
import { toneColor, type StatusTone } from '../lib/settings-status'

/** Tone for one doctor row: present → green; a missing REQUIRED tool is a problem
 *  (red); a missing OPTIONAL tool is a mild/neutral note (amber). Reuses the same
 *  --green/--amber/--red palette as the status cards (never an invented colour). */
function doctorTone(tool: DoctorTool): StatusTone {
  if (tool.present) return 'green'
  return tool.required ? 'red' : 'amber'
}

function DoctorToolRow({ tool }: { tool: DoctorTool }) {
  const tone = doctorTone(tool)
  const status = tool.present
    ? 'Installed'
    : tool.required
      ? 'Missing (required)'
      : 'Not installed (optional)'
  return (
    <li className="flex items-start gap-3 py-3" data-testid={`doctor-tool-${tool.id}`}>
      <span
        className="mt-1 inline-block h-2 w-2 flex-shrink-0 rounded-full"
        style={{ background: toneColor(tone) }}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-xs font-semibold text-[var(--text)]">{tool.name}</span>
          {!tool.required && (
            <span className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-[var(--muted)]">
              optional
            </span>
          )}
          <span className="text-[11px]" style={{ color: toneColor(tone) }} data-testid={`doctor-tool-${tool.id}-status`}>
            {status}
          </span>
        </div>
        <p className="mt-0.5 text-[11px] text-[var(--muted)]">{tool.purpose}</p>
        {tool.present && tool.version && (
          <p className="mono mt-0.5 truncate text-[10px] text-[var(--muted)]" title={tool.version}>
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
          className="flex-shrink-0 rounded-lg border border-[var(--border)] px-2.5 py-1 text-[11px] font-semibold text-[var(--accent-hover)] transition-colors hover:border-[color:rgba(56,189,248,0.35)]"
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
    <div>
      <div className="mb-2">
        <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
          System requirements
        </h2>
        <p className="mt-1 text-[11px] text-[var(--muted)]">
          Host tools K drives. The <span className="mono">claude</span> CLI is the agent engine and is
          not bundled — install and authenticate it. Optional tools degrade gracefully if absent.
        </p>
      </div>

      {isLoading ? (
        <p className="text-xs text-[var(--muted)]">Checking host tools…</p>
      ) : error || !data ? (
        <p className="text-xs text-[var(--red)]">Failed to check host tools.</p>
      ) : (
        <div className="glass rounded-xl border border-[var(--border)] p-4">
          {!data.ok && (
            <p
              data-testid="system-doctor-problem"
              className="mb-3 rounded-lg border border-[var(--red)]/40 bg-[var(--raised)] px-3 py-2 text-[11px] text-[var(--red)]"
            >
              A required tool is missing — K can’t run agents until it’s installed.
            </p>
          )}
          <ul className="flex flex-col divide-y divide-[var(--border)]">
            {data.tools.map(tool => (
              <DoctorToolRow key={tool.id} tool={tool} />
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
