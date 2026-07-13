/**
 * Settings → Voice status section (P5.4), self-contained so the shared
 * SettingsPage container edit stays minimal + additive (mirrors SettingsModels).
 *
 * READ-ONLY: there is no runtime toggle route for voice — it is enabled via the
 * `ENABLE_VOICE` env var (with a local Whisper server). This section only reports
 * the live posture from the shared `['status']` query using `voiceVerdict`.
 *
 * T20 — migrated onto GlassPanel/SectionHeader/StatusPill/SkeletonRow. The verdict
 * label is looked up through a local, exhaustive map (never an arbitrary string
 * passed as StatusPill's `status`) — `voiceVerdict` only ever produces Disabled/
 * Reachable/Unreachable, all three covered below.
 */
import { useQuery } from '@tanstack/react-query'
import type { Status } from '@k/shared'
import { api } from '../lib/api'
import { voiceVerdict } from '../lib/settings-status'
import { GlassPanel } from '../ui/GlassPanel'
import { SectionHeader } from '../ui/SectionHeader'
import { StatusPill } from '../ui/StatusPill'
import { SkeletonRow } from '../ui/Skeleton'

const VERDICT_PILL_STATUS: Record<string, string> = {
  Reachable: 'done',
  Unreachable: 'error',
  Disabled: 'idle',
}

export function VoiceSection() {
  const { data, isLoading, error } = useQuery<Status>({
    queryKey: ['status'],
    queryFn: () => api.status(),
  })

  return (
    <GlassPanel data-testid="voice-section" className="p-4">
      <SectionHeader label="Voice (push-to-talk)" as="h2" />
      <p className="mt-1 text-caption text-muted">
        Hold the mic in the command bar (or a run&apos;s reply box) to talk; release to transcribe.
        Audio is transcribed locally by Whisper and never leaves this machine. With voice off the
        mic is disabled and the app falls back to the keyboard. Enable it with{' '}
        <span className="mono">ENABLE_VOICE</span> (no runtime toggle).
      </p>

      {isLoading ? (
        <SkeletonRow />
      ) : error || !data ? (
        <p className="mt-2 text-caption text-red">Failed to load voice status.</p>
      ) : (
        (() => {
          const v = voiceVerdict(data.voice)
          return (
            <div className="mt-2 flex items-center gap-3">
              <span data-testid="voice-status-label">
                <StatusPill status={VERDICT_PILL_STATUS[v.label] ?? 'idle'} label={v.label} />
              </span>
              {v.detail && (
                <span className="mono truncate text-caption text-muted" title={v.detail}>
                  {v.detail}
                </span>
              )}
            </div>
          )
        })()
      )}
    </GlassPanel>
  )
}
