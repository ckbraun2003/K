import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import type { Run, AgentEvent, WsMessage, Status, Project, DiffPayload } from '@k/shared'
import { api } from '../lib/api'
import { navigate } from '../lib/route'
import { onWsMessage } from '../lib/ws'
import { cn } from '../lib/cn'
import { pairToolCalls, groupConsoleItems } from '../lib/console'
import { contextPressure, nextAutoCompact, type AutoCompactState } from '../lib/context'
import { cleanRunPrompt } from '../lib/prompt'
import { linkify } from '../lib/linkify'
import Markdown from './Markdown'
import RunTimeline from './RunTimeline'
import PlanCard from './PlanCard'
import NarrativeCard from './NarrativeCard'
import ReviewDeck from './ReviewDeck'
import VerifyChip from './VerifyChip'
import ToolCall from './ToolCall'
import ConfirmDialog from './ConfirmDialog'
import AutoTextarea from './AutoTextarea'
import ContextMeter from './ContextMeter'
import MicButton from './MicButton'
import SegControl from './SegControl'
import { StatusPill } from '../ui/StatusPill'
import { Tag } from '../ui/Tag'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { EmptyState } from '../ui/EmptyState'

interface Props {
  runId: string
}

/**
 * Merge backfilled history with live events, deduped by id and sorted by seq.
 * Live events may arrive out of order (or before the backfill resolves), so the
 * merged result is re-sorted by `seq` for stable, in-order rendering.
 * Extracted as a pure function so the ordering contract can be unit-tested.
 */
export function mergeEvents(history: AgentEvent[], live: AgentEvent[]): AgentEvent[] {
  const seen = new Set(history.map(e => e.id))
  return [...history, ...live.filter(e => !seen.has(e.id))].sort((a, b) => a.seq - b.seq)
}

/**
 * The CLI `/compact` slash-command, delivered as a normal operator turn over the
 * stream-json input wire. Smoke D6.0 confirmed the CLI HONORS this — it runs its
 * real compaction machinery (`system/status:"compacting"` → `compact_result`)
 * and ends the turn with a `{type:"result"}` line, so the supervisor re-parks the
 * run at `awaiting_input` after compacting. This is REAL context compaction, not
 * a soft self-summary.
 */
export const COMPACT_COMMAND = '/compact'

/**
 * Runtime badge for LOCAL (ollama) runs — derived from the agent loop's
 * run-start system declaration (`ollama-agent: … toolSupport=true|false`) and
 * any later degrade event ("degraded to prompt-only"), so the header always
 * reflects what ACTUALLY ran:
 *   'local · tools'        — the K tool loop with tools advertised;
 *   'local · prompt-only'  — degraded (no tool support), skills inlined.
 * Returns null for claude runs AND for legacy `ollama run` dispatches (no
 * declaration event) — no badge is honest there. Pure + exported for tests.
 */
export function ollamaRuntimeBadge(
  run: Pick<Run, 'provider'> | undefined,
  events: AgentEvent[],
): string | null {
  if (run?.provider !== 'ollama') return null
  let toolSupport: boolean | null = null
  for (const e of events) {
    if (e.type !== 'system' || !e.text || !e.text.startsWith('ollama-agent:')) continue
    const m = /toolSupport=(true|false)/.exec(e.text)
    if (m) toolSupport = m[1] === 'true'
    if (e.text.includes('degraded to prompt-only')) toolSupport = false
  }
  if (toolSupport === null) return null
  return toolSupport ? 'local · tools' : 'local · prompt-only'
}

export const EVENT_COLOR: Record<string, string> = {
  system:    'text-muted',
  assistant: 'text-text',
  user:      'text-accent-hover',
  usage:     'text-green',
  error:     'text-red',
  status:    'text-amber',
}

/**
 * Render a non-tool event exactly as the flat console always has (status / usage
 * / error / assistant text / system+user text). Assistant events that carry a
 * tool name but no enriched `toolUseId` (pre-D3 history) keep the old `⚙ tool()`
 * line so older runs still read correctly.
 */
function EventLine({ event: e }: { event: AgentEvent }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.1 }}
      className={cn('leading-relaxed whitespace-pre-wrap break-words', EVENT_COLOR[e.type] ?? 'text-text')}
    >
      {e.type === 'status' && (
        <span className="text-muted">── {e.text} ──</span>
      )}
      {e.type === 'usage' && (
        <span className="tabular-nums">
          ▸ {e.tokensIn?.toLocaleString()} in / {e.tokensOut?.toLocaleString()} out
          {e.costUsd ? ` / $${e.costUsd.toFixed(4)}` : ''}
        </span>
      )}
      {e.type === 'error' && (
        <span>⚠ {linkify(e.text ?? '')}</span>
      )}
      {e.type === 'assistant' && e.tool && (
        <span className="text-accent-hover">⚙ {e.tool}()</span>
      )}
      {e.type === 'assistant' && !e.tool && e.text && (
        <Markdown text={e.text} className="font-sans" />
      )}
      {(e.type === 'system' || e.type === 'user') && e.text && (
        <span className="opacity-60">{linkify(e.text)}</span>
      )}
    </motion.div>
  )
}

export default function RunConsole({ runId }: Props) {
  const qc = useQueryClient()
  const [events, setEvents] = useState<AgentEvent[]>([])
  const [view, setView] = useState<'console' | 'timeline' | 'changes'>('console')
  const [confirmKill, setConfirmKill] = useState(false)
  const [killing, setKilling] = useState(false)
  // Operator's reply while the run is parked at awaiting_input (interactive HITL).
  const [answer, setAnswer] = useState('')
  const [sending, setSending] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const answerRef = useRef<HTMLTextAreaElement>(null)
  // Hysteresis state for auto-`/compact` — armed initially, disarmed after a fire,
  // re-armed only when context recovers to the 'ok' band (see nextAutoCompact).
  // The ref is the synchronous re-entrancy guard; `autoCompactFired` is a
  // display-only mirror used solely to vary the danger-hint copy.
  const autoCompactRef = useRef<AutoCompactState>({ armed: true })
  const [autoCompactFired, setAutoCompactFired] = useState(false)

  const { data: run, isError } = useQuery<Run>({
    queryKey: ['run', runId],
    queryFn: () => api.runs.get(runId),
  })

  // Shared-cache status query (same key as Settings — no fan-out) so the
  // HITL reply box can gate the mic on whether voice is enabled.
  const { data: status } = useQuery<Status>({ queryKey: ['status'], queryFn: () => api.status() })

  // The run's project (app-wide cached ['projects']) — its `githubRemote` gates the
  // "Create PR from Run →" shortcut: a remoteless project has nowhere to open a PR
  // (F-061), so the shortcut is hidden there.
  const { data: projects = [] } = useQuery<Project[]>({ queryKey: ['projects'], queryFn: api.projects.list })
  const runProjectHasRemote = !!projects.find(p => p.id === run?.projectId)?.githubRemote

  // A terminal run's tool calls can't still be running: an unpaired tool_use is
  // resolved (not perpetually pending) once the run ends (F-063). awaiting_input
  // is NOT terminal — the CLI is live and a turn may still be in flight. Hoisted
  // above the early returns (null-tolerant) so the diffStats query below — an
  // unconditional hook — can gate on it without violating the rules of hooks.
  const runEnded = run != null &&
    (run.status === 'done' || run.status === 'error' || run.status === 'killed' || run.status === 'interrupted')

  // Files/± badge for the "Changes" tab — one cheap query on the DEFAULT
  // context key (dedupes with ReviewDeck/ChangesLayout's own query). Only
  // enabled once the run is terminal — no point polling a live run for a badge.
  const { data: diffStats } = useQuery<DiffPayload>({
    queryKey: ['run-diff', runId, 3],
    queryFn: () => api.runs.diff(runId, 3),
    enabled: runEnded,
    staleTime: 30_000,
  })

  // Pair tool_use↔tool_result and coalesce consecutive tool calls once per event
  // change, not on every render (each WS event would otherwise rebuild ~2N objects).
  const segments = useMemo(() => groupConsoleItems(pairToolCalls(events)), [events])

  // Persisted history + live events via WS (deduped by event id — live
  // events can arrive while the backfill request is in flight)
  useEffect(() => {
    setEvents([]) // reset when run changes
    setAnswer('')
    let cancelled = false
    const unsub = onWsMessage((msg: WsMessage) => {
      if (msg.type === 'event' && msg.event.runId === runId) {
        // Reuse mergeEvents so the array stays deduped-by-id AND seq-sorted on
        // every append — keeps tool grouping/expand state stable even when live
        // events arrive out of order. (prev = "history", the new event = "live".)
        setEvents(prev => mergeEvents(prev, [msg.event]))
      }
      if (msg.type === 'run_update' && msg.run.id === runId) {
        qc.setQueryData(['run', runId], msg.run)
      }
    })
    // Fetch without raw — live WS events carry raw inline; backfilled events
    // fetch raw lazily per-expand via api.runs.eventRaw (see RunTimeline).
    api.runs.events(runId).then(history => {
      if (cancelled) return
      setEvents(prev => mergeEvents(history, prev))
    }).catch(() => { /* live stream still works without backfill */ })
    return () => { cancelled = true; unsub() }
  }, [runId, qc])

  // Auto-scroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [events])

  // Focus the answer box when the run parks at awaiting_input so the operator can
  // type their reply immediately without reaching for the mouse.
  const awaiting = run?.status === 'awaiting_input'
  useEffect(() => {
    if (awaiting) answerRef.current?.focus()
  }, [awaiting])

  async function handleKill() {
    setKilling(true)
    try {
      await api.runs.kill(runId)
      setConfirmKill(false)
    } finally {
      setKilling(false)
    }
  }

  // Send one operator turn; on success the run flips back to 'running' via a
  // run_update WS message, which hides the answer box. Shared by the manual
  // reply, the manual "Compact context" button, and the auto-compact effect so
  // all three get the same send/disable/error handling. Returns whether the send
  // succeeded. Memoized (stable per runId/sending) so the auto-compact effect can
  // list it as a dependency without re-firing every render.
  const submitTurn = useCallback(async (text: string): Promise<boolean> => {
    if (!text.trim() || sending) return false
    setSending(true)
    try {
      await api.runs.sendInput(runId, text)
      return true
    } catch { /* a 409 means it already left awaiting_input — the WS state will correct the UI */
      return false
    } finally { setSending(false) }
  }, [runId, sending])

  async function handleSend() {
    if (await submitTurn(answer)) setAnswer('')
  }

  // Real CLI context compaction: sends `/compact` as an operator turn. The CLI
  // honors it over the stream-json wire (smoke D6.0), runs its compaction, and
  // ends with a `result` line so the run re-parks at awaiting_input.
  async function handleCompact() {
    await submitTurn(COMPACT_COMMAND)
  }

  async function handleEnd() {
    try { await api.runs.end(runId) } catch { /* run may have already completed */ }
  }

  // Context-pressure for the header indicator. Computed above the `!run` guard
  // (run may be undefined before load) with a tolerant `run?.model`.
  const pressure = useMemo(() => contextPressure(events, run?.model), [events, run?.model])

  // Local-runtime badge (D-072 B4): "local · tools" / "local · prompt-only",
  // derived from the ollama agent loop's system declarations. null → no badge
  // (claude runs and legacy `ollama run` dispatches).
  const runtimeBadge = useMemo(() => ollamaRuntimeBadge(run, events), [run, events])

  // Guarded + debounced auto-compaction. The pure `nextAutoCompact` decides
  // (hysteresis: fire once per danger episode, re-arm at 'ok'); we only own the
  // side effect. The web Run type carries no explicit `interactive` flag, so we
  // use `awaiting_input` as the interactivity proxy — only interactive runs ever
  // reach that status. Never fires during initial load (run undefined), while a
  // send is in flight, or while the operator is mid-answer.
  useEffect(() => {
    if (!run) return
    const awaiting = run.status === 'awaiting_input'
    const { state, fire } = nextAutoCompact(autoCompactRef.current, {
      band: pressure.band,
      awaiting,
      interactive: awaiting, // proxy: only interactive runs reach awaiting_input
      sending,
      operatorTyping: answer.trim().length > 0,
    })
    autoCompactRef.current = state
    if (fire) {
      setAutoCompactFired(true)
      void submitTurn(COMPACT_COMMAND)
    }
    // Re-arm episode → clear the display mirror (guarded so it can't loop).
    if (pressure.band === 'ok' && autoCompactFired) setAutoCompactFired(false)
  }, [run, pressure.band, sending, answer, submitTurn, autoCompactFired])

  // A bad/removed run id 404s (api throws on non-ok) — surface a real not-found
  // instead of looping on "Loading…" forever (F-002). Loading is only the pre-
  // resolution state (no data, no error yet).
  if (isError) {
    return (
      <div data-testid="run-not-found" className="flex-1 flex items-center justify-center px-6">
        <EmptyState
          icon="warning"
          headline="Run not found"
          hint="This run doesn’t exist or is no longer available."
          action={<Button variant="ghost" size="sm" onClick={() => navigate('runs')}>← All runs</Button>}
        />
      </div>
    )
  }
  if (!run) return <div className="flex-1 flex items-center justify-center text-muted">Loading…</div>

  return (
    // Round 2 (Lane B): the selected run detail sits in its own glass box —
    // overflow-hidden so the panel's rounded-panel corners clip the scrolling
    // event-stream/timeline/changes body beneath the header.
    <div className="glass-panel rounded-panel flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-3 border-b border-border flex-shrink-0">
        <div className="flex-1 min-w-0">
          <p className="text-title truncate">{cleanRunPrompt(run.prompt)}</p>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-caption text-muted">
            <span className="mono tabular-nums">
              {run.model} · {run.tokensIn.toLocaleString()} in / {run.tokensOut.toLocaleString()} out · ${run.costUsd.toFixed(4)}
            </span>
            {runtimeBadge && (
              <span data-testid="run-runtime-badge">
                <Tag tint="sky">{runtimeBadge}</Tag>
              </span>
            )}
            <span aria-hidden>·</span>
            <ContextMeter pressure={pressure} />
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {diffStats && diffStats.files.length > 0 && (
            <span data-testid="changes-badge" className="mono text-label tabular-nums text-muted">
              {diffStats.files.length} files
              {' '}<span className="text-green">+{diffStats.files.reduce((s, f) => s + f.additions, 0)}</span>
              {' '}<span className="text-red">−{diffStats.files.reduce((s, f) => s + f.deletions, 0)}</span>
            </span>
          )}
          {/* Console | Timeline | Changes toggle */}
          <SegControl<'console' | 'timeline' | 'changes'>
            ariaLabel="Run view"
            options={[
              { label: 'console', value: 'console' },
              { label: 'timeline', value: 'timeline' },
              { label: 'changes', value: 'changes' },
            ]}
            value={view}
            onChange={setView}
          />
          <VerifyChip runId={runId} />
          <StatusPill status={run.status} />
          {(run.status === 'running' || run.status === 'awaiting_input') && (
            <Button
              variant="danger"
              size="sm"
              icon="stop"
              onClick={() => setConfirmKill(true)}
              data-testid="run-kill-btn"
            >
              Kill
            </Button>
          )}
        </div>
      </div>

      {view === 'changes' ? (
        <ReviewDeck runId={runId} projectId={run.projectId ?? null} />
      ) : view === 'timeline' ? (
        // key={runId} remounts on run switch so per-seq raw cache never leaks across runs
        <RunTimeline key={runId} events={events} runId={runId} terminal={runEnded} />
      ) : (
        /* Event stream — dense log, stays an opaque surface (no glass/blur).
           Tool calls rendered richly & collapsed, grouped when consecutive. */
        <div className="flex-1 overflow-y-auto px-5 py-4 mono text-body space-y-1">
          {events.length === 0 && (
            <div className="text-muted italic">Waiting for output…</div>
          )}
          {segments.map(seg =>
            seg.type === 'tools' ? (
              <div key={seg.key} className="space-y-1 border-l border-border pl-2">
                {seg.items.map(it => (
                  <ToolCall key={it.call.id} item={it} runEnded={runEnded} />
                ))}
              </div>
            ) : (
              <EventLine key={seg.event.id} event={seg.event} />
            ),
          )}
          <div ref={bottomRef} />
        </div>
      )}

      {/* E-02 plan park — render/edit/approve surface (Lane A fills PlanCard). */}
      {run.status === 'awaiting_plan' && <PlanCard runId={runId} />}

      {/* E-08 run narrative — deterministic fields + auto/degrade local-model bullets (Lane A fills NarrativeCard). */}
      <NarrativeCard runId={runId} />

      {/* HITL answer box — shown while the interactive run is waiting on the operator.
          Glass-panel card, accent-tinted border — a top-level flex child of the
          console root (not nested inside the opaque event-stream area), so no
          nested-backdrop-filter risk. */}
      {run.status === 'awaiting_input' && (
        <div className="glass-panel flex-shrink-0 mx-5 mb-3 border-accent/25 px-5 py-3 space-y-2" data-testid="run-answer-box">
          <p className="flex items-center gap-1.5 text-label font-medium text-amber">
            <Icon name="warning" size={14} />
            The agent is waiting for your reply.
          </p>
          <AutoTextarea
            ref={answerRef}
            aria-label="Answer the agent"
            data-testid="run-answer-input"
            value={answer}
            onChange={e => setAnswer(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void handleSend() }
            }}
            placeholder="Type your reply…  (↵ send · ⇧↵ newline)"
            className="glow-focus w-full resize-none rounded-control border border-border bg-bg/60 px-3 py-2 text-body text-text placeholder:text-muted/70 outline-none"
          />
          {pressure.band === 'danger' && (
            <p
              data-testid="run-compact-hint"
              className="flex items-center gap-1 text-label text-red"
            >
              <Icon name="warning" size={14} />
              {autoCompactFired
                ? 'Context near limit — automatic compaction attempted. Press “Compact context” to retry.'
                : 'Context near limit — compacting automatically. You can also press “Compact context” now.'}
            </p>
          )}
          <div className="flex items-center gap-2">
            <MicButton
              title="Hold to talk — release to transcribe into your reply"
              onTranscript={(t) => { setAnswer(a => (a ? a + ' ' : '') + t); answerRef.current?.focus() }}
              disabled={!status?.voice?.enabled}
            />
            <Button variant="ghost" size="sm" onClick={() => void handleEnd()}>
              End session
            </Button>
            <div className="ml-auto flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void handleCompact()}
                disabled={sending}
                data-testid="run-compact-btn"
                title="Runs the CLI's /compact to condense the conversation and free up context."
              >
                Compact context
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => void handleSend()}
                disabled={sending || !answer.trim()}
                data-testid="run-answer-send"
              >
                {sending ? 'Sending…' : 'Send ↵'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Footer: Create PR shortcut — only for terminal runs whose project has a
          GitHub remote (a remoteless project can't open a PR — F-061). */}
      {runEnded && run.projectId && runProjectHasRemote && (
          <div className="flex-shrink-0 border-t border-border py-2 pl-5 pr-20 flex justify-end">
            <Button
              variant="glass"
              size="sm"
              icon="pr"
              onClick={() => navigate('project', run.projectId!, 'prs-ci')}
            >
              Create PR from Run →
            </Button>
          </div>
        )}

      <ConfirmDialog
        open={confirmKill}
        title="Kill run?"
        testid="run-kill-dialog"
        busy={killing}
        message="Terminating this run stops the agent immediately. This cannot be undone."
        confirmLabel="Kill run"
        onConfirm={handleKill}
        onCancel={() => setConfirmKill(false)}
      />
    </div>
  )
}
