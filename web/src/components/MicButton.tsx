import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { useVoiceRecorder } from '../lib/useVoiceRecorder'
import { api } from '../lib/api'
import { cn } from '../lib/cn'

/**
 * Reusable hold-to-talk mic control (P5.4).
 *
 * Hold (pointer down / Space / Enter) records; release stops, transcribes via
 * `api.voice.transcribe` (core → local Whisper), and hands the text back to the
 * parent through `onTranscript`. It NEVER writes to the parent input on any
 * failure — the keyboard always remains the fallback.
 *
 * The recording pulse and the transcribing spinner are Framer `motion` elements,
 * so they honor the app-wide `<MotionConfig reducedMotion="user">` in Shell.tsx —
 * no hand-rolled CSS keyframes.
 */

interface MicButtonProps {
  /** Called with the transcribed text (non-empty only). Parent appends to its input. */
  onTranscript: (text: string) => void
  /** Voice globally disabled (e.g. ENABLE_VOICE not set) — renders an inert button. */
  disabled?: boolean
  title?: string
  className?: string
}

type MicStatus = 'idle' | 'recording' | 'transcribing' | 'error'

function MicGlyph() {
  // Mirrors core's `#i-mic` symbol paths (ui-artifact.ts).
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="2.5" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
      <path d="M8.5 21h7" />
    </svg>
  )
}

function Spinner() {
  // motion.svg → governed by the app MotionConfig (reduced-motion safe).
  return (
    <motion.svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
      animate={{ rotate: 360 }}
      transition={{ repeat: Infinity, duration: 0.8, ease: 'linear' }}
    >
      <path d="M12 3a9 9 0 1 0 9 9" />
    </motion.svg>
  )
}

export default function MicButton({ onTranscript, disabled, title, className }: MicButtonProps) {
  const recorder = useVoiceRecorder()
  const [status, setStatus] = useState<MicStatus>('idle')
  const [errMsg, setErrMsg] = useState<string | null>(null)
  // Synchronous guard so pointerUp + pointerLeave (or a stray keyup) can't double-fire.
  const activeRef = useRef(false)

  const unavailable = !!disabled || !recorder.supported

  // Surface a recorder error (e.g. permission denied — set asynchronously by the
  // hook after start() awaits getUserMedia) as the button's error state.
  useEffect(() => {
    if (recorder.error) {
      setErrMsg(recorder.error)
      setStatus('error')
      activeRef.current = false
    }
  }, [recorder.error])

  const tooltip = disabled
    ? 'Enable ENABLE_VOICE to use voice'
    : !recorder.supported
      ? 'Voice input not supported in this browser'
      : status === 'error'
        ? errMsg ?? 'Voice input failed'
        : status === 'transcribing'
          ? 'Transcribing…'
          : title ?? 'Hold to talk — release to transcribe'

  async function begin() {
    if (unavailable || activeRef.current || status === 'transcribing') return
    activeRef.current = true
    setErrMsg(null)
    setStatus('recording')
    // start() never throws on denial — it sets recorder.error, which the effect
    // above turns into the 'error' state; stop() then yields null so nothing lands.
    await recorder.start()
  }

  async function end() {
    if (!activeRef.current) return
    activeRef.current = false
    let blob: Blob | null = null
    try {
      blob = await recorder.stop()
    } catch {
      blob = null
    }
    if (!blob) {
      // Nothing recorded, or start() was denied (the error effect owns that state).
      setStatus(s => (s === 'error' ? s : 'idle'))
      return
    }
    setStatus('transcribing')
    try {
      // Read defensively: req() returns undefined on a 204/empty body, so a
      // destructure would throw. Whisper also commonly returns a leading space —
      // trim so the parent's space-joined append doesn't double/lead a space.
      const result = await api.voice.transcribe(blob)
      const clean = result?.text?.trim()
      if (clean) onTranscript(clean)
      setStatus('idle')
    } catch (e) {
      // Network / 502 / 503 — never touch the parent input; keyboard still works.
      setErrMsg(e instanceof Error ? e.message : 'Transcription failed')
      setStatus('error')
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.repeat) return // ignore auto-repeat while the key is held
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault()
      void begin()
    }
  }
  function onKeyUp(e: React.KeyboardEvent) {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault()
      void end()
    }
  }

  const recordingNow = status === 'recording'

  return (
    <motion.button
      type="button"
      data-testid="mic-button"
      data-state={status}
      disabled={unavailable || status === 'transcribing'}
      // aria-label mirrors the live tooltip (incl. the disabled/error reason);
      // aria-pressed announces the hold-to-talk recording state to screen readers.
      aria-label={tooltip}
      aria-pressed={recordingNow}
      title={tooltip}
      // Capture the pointer on down so up/cancel fire on THIS button regardless of
      // where the finger/cursor drifts — a 1px slip off the 32px target must not
      // cancel recording. (Guarded: jsdom has no setPointerCapture.)
      onPointerDown={(e) => {
        if (unavailable || status === 'transcribing') return
        e.currentTarget.setPointerCapture?.(e.pointerId)
        void begin()
      }}
      onPointerUp={() => void end()}
      onPointerCancel={() => void end()}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      // Recording pulse — transform/opacity only, MotionConfig-governed.
      animate={recordingNow ? { scale: [1, 1.09, 1] } : { scale: 1 }}
      transition={
        recordingNow
          ? { duration: 1.4, repeat: Infinity, ease: 'easeInOut' }
          : { duration: 0.15 }
      }
      className={cn(
        'inline-grid h-8 w-8 flex-shrink-0 place-items-center rounded-lg border outline-none transition-colors',
        recordingNow
          // Accent FILL → dark --bg text for WCAG contrast (see ui-demo .micbtn.rec).
          ? 'border-[var(--accent)] bg-[var(--accent)] text-[var(--bg)]'
          : status === 'error'
            ? 'border-[color:rgba(248,113,113,0.5)] bg-[var(--surface)] text-[var(--red)]'
            : 'border-[var(--border)] bg-[var(--surface)] text-[var(--muted)] hover:border-accent/50 hover:text-[var(--accent-hover)]',
        'disabled:cursor-not-allowed disabled:opacity-40',
        className,
      )}
    >
      {status === 'transcribing' ? <Spinner /> : <MicGlyph />}
    </motion.button>
  )
}
