import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * A focused MediaRecorder hook for push-to-talk voice input (P5.4).
 *
 * The hook owns the browser mic lifecycle only — it never transcribes and never
 * touches the network (that is `api.voice.transcribe`). It degrades gracefully on
 * every failure surface so the app can always fall back to the keyboard:
 *  - unsupported browser → `supported: false`, start() is a no-op
 *  - permission denied   → sets `error`, resolves without throwing
 *  - stop() before start → resolves null
 *
 * Audio bytes are never logged.
 */

export interface VoiceRecorder {
  /** MediaRecorder + getUserMedia both available in this browser. */
  supported: boolean
  recording: boolean
  error: string | null
  /**
   * getUserMedia({audio:true}) → new MediaRecorder → start. On a permission
   * denial it sets `error`, leaves `recording` false, and resolves (never throws
   * uncaught) so the caller degrades to the keyboard.
   */
  start: () => Promise<void>
  /**
   * Stop the recorder, assemble the recorded chunks into one Blob tagged with the
   * chosen mime, release the mic tracks, and resolve the Blob (or null if nothing
   * was recorded / it was never started). Safe to call when not recording.
   */
  stop: () => Promise<Blob | null>
}

// Preferred container mimes, in order. '' lets MediaRecorder pick its own default
// (and the Blob is built untyped, so the POST falls back to octet-stream).
const MIME_CANDIDATES = ['audio/webm', 'audio/ogg'] as const

/** Choose the first supported candidate mime, or '' when none can be confirmed. */
function pickMime(): string {
  if (typeof MediaRecorder === 'undefined') return ''
  const canCheck = typeof MediaRecorder.isTypeSupported === 'function'
  for (const t of MIME_CANDIDATES) {
    // When isTypeSupported is unavailable, optimistically accept the first candidate.
    if (!canCheck || MediaRecorder.isTypeSupported(t)) return t
  }
  return ''
}

export function useVoiceRecorder(): VoiceRecorder {
  const supported =
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== 'undefined'

  const [recording, setRecording] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const mimeRef = useRef('')
  // A start() is awaiting getUserMedia — blocks a double-start AND lets a stop()
  // (or unmount) that fires before the stream resolves request an abort.
  const pendingRef = useRef(false)
  // A teardown was requested while the stream was still resolving (see start()).
  const abortRef = useRef(false)

  // Stop every track so the browser's mic indicator clears and the device is freed.
  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
  }, [])

  const start = useCallback(async (): Promise<void> => {
    // Ignore a double-start whether we're already recording OR still acquiring.
    if (recorderRef.current || pendingRef.current) return
    setError(null)
    if (!supported) {
      setError('Voice input not supported in this browser')
      return
    }
    abortRef.current = false
    pendingRef.current = true
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (e) {
      // Permission denied / no device — degrade to keyboard, never throw uncaught.
      // Clear both flags here (not just at the next start()) so the abort invariant
      // stays local: no path can leave abortRef stuck true after we bail.
      pendingRef.current = false
      abortRef.current = false
      const name = e instanceof Error ? e.name : ''
      setError(
        name === 'NotAllowedError' || name === 'PermissionDeniedError'
          ? 'Microphone permission denied'
          : 'Could not access the microphone',
      )
      setRecording(false)
      return
    }
    pendingRef.current = false
    // Race guard: if stop() (a fast release) or an unmount fired while getUserMedia
    // was still pending, tear the just-acquired stream down NOW and never go live —
    // otherwise the mic stays lit behind an idle-looking button with no gesture to
    // stop it (a cached permission can resolve in under a tap on warm mobile).
    if (abortRef.current) {
      abortRef.current = false
      stream.getTracks().forEach(t => t.stop())
      setRecording(false)
      return
    }
    // Assign the stream up-front so any downstream failure (or an unmount) can
    // still release the mic — otherwise a throw between here and stop() leaks it.
    streamRef.current = stream
    try {
      const mime = pickMime()
      mimeRef.current = mime
      chunksRef.current = []
      const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream)
      rec.ondataavailable = (ev: BlobEvent) => {
        if (ev.data && ev.data.size > 0) chunksRef.current.push(ev.data)
      }
      rec.start()
      // Publish the recorder only AFTER start() succeeds, so a throw can't wedge
      // the double-start guard (`if (recorderRef.current) return`) or leak state.
      recorderRef.current = rec
      setRecording(true)
    } catch {
      // Unsupported mime / InvalidStateError — release the mic, reset, degrade to
      // the keyboard (never throw uncaught; the caller invokes this via `void`).
      releaseStream()
      recorderRef.current = null
      chunksRef.current = []
      setRecording(false)
      setError('Could not start recording')
    }
  }, [supported, releaseStream])

  const stop = useCallback((): Promise<Blob | null> => {
    // A start() is still awaiting getUserMedia — request an abort so its
    // continuation tears the stream down instead of going live, and bail now.
    if (pendingRef.current) {
      abortRef.current = true
      setRecording(false)
      return Promise.resolve(null)
    }
    const rec = recorderRef.current
    if (!rec) {
      // Never started (or already stopped) — nothing to assemble, but still free
      // any lingering stream defensively.
      releaseStream()
      return Promise.resolve(null)
    }
    return new Promise<Blob | null>(resolve => {
      const finalize = () => {
        const chunks = chunksRef.current
        chunksRef.current = []
        releaseStream()
        recorderRef.current = null
        setRecording(false)
        if (chunks.length === 0) {
          resolve(null)
          return
        }
        const mime = mimeRef.current
        resolve(new Blob(chunks, mime ? { type: mime } : undefined))
      }
      rec.onstop = finalize
      try {
        rec.stop()
      } catch {
        // Recorder already inactive — assemble whatever chunks we captured.
        finalize()
      }
    })
  }, [releaseStream])

  // Release the mic if the component unmounts mid-recording (⌘K closes, the run
  // view navigates away) — stop() would otherwise never run and the browser mic
  // indicator would stay lit until GC.
  useEffect(() => () => {
    // Abort a start() that's still awaiting getUserMedia so its continuation frees
    // the resolving stream (it hasn't reached streamRef yet).
    abortRef.current = true
    try { recorderRef.current?.stop() } catch { /* already inactive */ }
    // The explicit getTracks().stop() is the real guarantor: rec.onstop is async
    // and may fire after unmount, so we can't rely on the stop() finalize path.
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
  }, [])

  return { supported, recording, error, start, stop }
}
