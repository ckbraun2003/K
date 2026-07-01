/**
 * Settings → Voice status section (P5.4), self-contained so the shared
 * SettingsPage container edit stays minimal + additive (mirrors SettingsModels).
 *
 * READ-ONLY: there is no runtime toggle route for voice — it is enabled via the
 * `ENABLE_VOICE` env var (with a local Whisper server). This section only reports
 * the live posture from the shared `['status']` query using `voiceVerdict`.
 *
 * All colours are existing midnight-glass CSS vars (no new palette entry).
 */
import { useQuery } from '@tanstack/react-query'
import type { Status } from '@k/shared'
import { api } from '../lib/api'
import { voiceVerdict, toneColor } from '../lib/settings-status'

const SECTION_H2 =
  'text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]'

export function VoiceSection() {
  const { data, isLoading, error } = useQuery<Status>({
    queryKey: ['status'],
    queryFn: () => api.status(),
  })

  return (
    <div data-testid="voice-section">
      <h2 className={SECTION_H2}>Voice (push-to-talk)</h2>
      <p className="mt-1 text-[11px] text-[var(--muted)]">
        Hold the mic in the command bar (or a run&apos;s reply box) to talk; release to transcribe.
        Audio is transcribed locally by Whisper and never leaves this machine. With voice off the
        mic is disabled and the app falls back to the keyboard. Enable it with{' '}
        <span className="mono">ENABLE_VOICE</span> (no runtime toggle).
      </p>

      {isLoading ? (
        <p className="mt-2 text-xs text-[var(--muted)]">Loading…</p>
      ) : error || !data ? (
        <p className="mt-2 text-xs text-[var(--red)]">Failed to load voice status.</p>
      ) : (
        (() => {
          const v = voiceVerdict(data.voice)
          return (
            <div className="mt-2 flex items-center gap-3">
              <span className="flex items-center gap-1.5 text-xs text-[var(--text)]">
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ background: toneColor(v.tone) }}
                  aria-hidden
                />
                <span data-testid="voice-status-label">{v.label}</span>
              </span>
              {v.detail && (
                <span className="mono truncate text-[11px] text-[var(--muted)]" title={v.detail}>
                  {v.detail}
                </span>
              )}
            </div>
          )
        })()
      )}
    </div>
  )
}
