import type { AgentEvent } from '@k/shared'

/**
 * Pure helpers for the rich run console (Wave D4).
 *
 * The enriched stream-json parser (Wave D3) emits a tool_use block (on an
 * `assistant` event) and its matching tool_result block (on a later `user`
 * event) as SEPARATE events that pair by an equal `toolUseId`. This module
 * walks the (already seq-sorted) event list and produces ordered render items:
 * each tool_use becomes a `tool` item with its result attached once it arrives;
 * everything else passes through as an `event` item, preserving today's
 * rendering. All derivation helpers tolerate unexpected shapes and never throw —
 * a single malformed event must not crash the whole list. We use `??` (not `||`)
 * throughout so an explicitly empty string is distinguished from an unset field.
 */

// ─── Render items ─────────────────────────────────────────────────────────────

/** A tool call: the assistant `tool_use` event plus its (optional) result. */
export interface ToolItem {
  kind: 'tool'
  /** The assistant `tool_use` event (carries toolKind / toolInput / etc.). */
  call: AgentEvent
  /** The matching `user` `tool_result` event — absent while the tool is running. */
  result?: AgentEvent
}

/** Any non-tool event, rendered exactly as the flat console does today. */
export interface PassthroughItem {
  kind: 'event'
  event: AgentEvent
}

export type ConsoleItem = ToolItem | PassthroughItem

// ─── Pairing ──────────────────────────────────────────────────────────────────

/**
 * Pair assistant `tool_use` events with their `user` `tool_result` events by
 * `toolUseId`, preserving order. A result event consumed by a tool item is not
 * also emitted as a standalone item. A tool_use whose result hasn't arrived yet
 * renders as pending (no `result`). Non-tool events pass through unchanged.
 */
export function pairToolCalls(events: AgentEvent[]): ConsoleItem[] {
  // Index every result event (a `user` event carrying a join key) by toolUseId.
  // First write wins — toolUseIds are unique per call in practice.
  const resultByToolUseId = new Map<string, AgentEvent>()
  for (const e of events) {
    if (e == null) continue
    if (e.type === 'user' && e.toolUseId != null && !resultByToolUseId.has(e.toolUseId)) {
      resultByToolUseId.set(e.toolUseId, e)
    }
  }

  const items: ConsoleItem[] = []
  // Guard against the same tool_use id appearing twice (replay / injection) so a
  // single call can't render as two items.
  const emittedCallIds = new Set<string>()
  for (const e of events) {
    if (e == null) continue
    if (e.type === 'assistant' && e.toolUseId != null) {
      if (emittedCallIds.has(e.toolUseId)) continue
      emittedCallIds.add(e.toolUseId)
      items.push({ kind: 'tool', call: e, result: resultByToolUseId.get(e.toolUseId) })
      continue
    }
    // Drop result events: a `user` event carrying a toolUseId is a tool_result —
    // either consumed by its tool item above, or an orphan with no matching
    // tool_use. Either way it must not render as its own (empty) passthrough row.
    if (e.type === 'user' && e.toolUseId != null) continue
    items.push({ kind: 'event', event: e })
  }
  return items
}

// ─── Grouping ─────────────────────────────────────────────────────────────────

/** A run of consecutive tool calls (a visual group) or a single passthrough event. */
export type ConsoleSegment =
  | { type: 'tools'; key: string; items: ToolItem[] }
  | { type: 'event'; event: AgentEvent }

/** Coalesce consecutive tool items so the console can group them visually. The
 *  group key is the first item's call id — stable as long as the seq order is. */
export function groupConsoleItems(items: ConsoleItem[]): ConsoleSegment[] {
  const segments: ConsoleSegment[] = []
  for (const item of items) {
    if (item == null) continue
    if (item.kind === 'tool') {
      const last = segments[segments.length - 1]
      if (last && last.type === 'tools') last.items.push(item)
      else segments.push({ type: 'tools', key: item.call.id, items: [item] })
    } else {
      segments.push({ type: 'event', event: item.event })
    }
  }
  return segments
}

/** True while a tool call has not yet received its result event. */
export function isPending(item: ToolItem): boolean {
  return item.result == null
}

/** The render kinds ToolCall discriminates on (mirrors AgentEvent.toolKind). */
export type ToolKind = 'command' | 'file' | 'delegate' | 'other'

/** Tool NAMES whose input is a shell command (an `input.command` string) and so
 *  should render as a command card. The core classifier only tags `Bash` as
 *  'command'; PowerShell/pwsh land as 'other', hiding the command from the card
 *  header (F-078). Matched case-insensitively on the display side so already-
 *  indexed events upgrade without a re-analyze. */
const COMMAND_TOOL_NAMES = new Set(['bash', 'powershell', 'pwsh', 'sh'])

/** True when a tool's name marks it as a shell-command tool (Bash/PowerShell/…). */
export function isCommandTool(name: string | undefined): boolean {
  return COMMAND_TOOL_NAMES.has((name ?? '').toLowerCase())
}

/**
 * The render kind for a tool item. Trusts the core-assigned `toolKind` when it is
 * specific, but UPGRADES a name-recognized shell tool the classifier tagged
 * 'other' (e.g. PowerShell) to 'command' so its command shows in the header just
 * like Bash (F-078). Never downgrades a known kind.
 */
export function resolveToolKind(item: ToolItem): ToolKind {
  const stored = item.call.toolKind
  if (stored && stored !== 'other') return stored
  if (isCommandTool(item.call.tool)) return 'command'
  return stored ?? 'other'
}

// Input keys, in priority order, that carry a tool's SALIENT argument — the one
// value worth showing in a card header (Read → file_path, ToolSearch → query, an
// mcp__ tool → its title/name/query, etc.).
const SALIENT_ARG_KEYS = [
  'file_path', 'path', 'notebook_path',
  'pattern', 'query', 'command', 'url',
  'title', 'name', 'subject', 'description', 'prompt', 'text', 'message',
]

/**
 * A short summary of a tool's salient INPUT argument for the card header, so any
 * tool shows what it acted on instead of empty parens — `Read()` → the path,
 * `ToolSearch()` → the query, `mcp__kstore__lesson_propose()` → its key arg
 * (F-063). Prefers a known key, else the first non-empty string field (labeled).
 * Returns '' when nothing salient is present. Never throws.
 */
export function toolArgSummary(item: ToolItem): string {
  const input = asRecord(item.call.toolInput)
  for (const k of SALIENT_ARG_KEYS) {
    const v = asString(input[k])
    if (v != null && v.length > 0) return v
  }
  for (const key of Object.keys(input)) {
    const v = asString(input[key])
    if (v != null && v.length > 0) return `${key}: ${v}`
  }
  return ''
}

/** True only when the result is EXPLICITLY flagged as an error (tri-state). */
export function isError(item: ToolItem): boolean {
  return item.result?.toolResultIsError === true
}

// ─── Defensive readers ────────────────────────────────────────────────────────

function asRecord(v: unknown): Record<string, unknown> {
  return v != null && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

// ─── Command (Bash) ───────────────────────────────────────────────────────────

export function commandText(item: ToolItem): string {
  return asString(asRecord(item.call.toolInput).command) ?? ''
}

export function commandDescription(item: ToolItem): string | undefined {
  return asString(asRecord(item.call.toolInput).description)
}

// ─── File ops (Write / Edit / MultiEdit) ──────────────────────────────────────

export type FileOp = 'write' | 'edit' | 'multiedit' | 'unknown'

/** The target file path (degrades to a placeholder for unknown shapes). */
export function fileSummary(item: ToolItem): string {
  const input = asRecord(item.call.toolInput)
  return asString(input.file_path) ?? asString(input.path) ?? '(unknown file)'
}

export function fileOp(item: ToolItem): FileOp {
  const input = asRecord(item.call.toolInput)
  if (Array.isArray(input.edits)) return 'multiedit'
  if (asString(input.old_string) != null || asString(input.new_string) != null) return 'edit'
  if (asString(input.content) != null) return 'write'
  return 'unknown'
}

/** A diff hunk: the text being replaced and its replacement. */
export interface DiffHunk {
  oldText: string
  newText: string
}

export type FileDetail =
  | { type: 'write'; content: string }
  | { type: 'diff'; hunks: DiffHunk[] }
  | { type: 'unknown' }

/**
 * Derive the expanded detail for a file op: a content preview for Write, one or
 * more diff hunks for Edit / MultiEdit, or `unknown` for shapes we don't model.
 */
export function fileDetail(item: ToolItem): FileDetail {
  const input = asRecord(item.call.toolInput)
  if (Array.isArray(input.edits)) {
    const hunks = input.edits.map(raw => {
      const e = asRecord(raw)
      return { oldText: asString(e.old_string) ?? '', newText: asString(e.new_string) ?? '' }
    })
    return { type: 'diff', hunks }
  }
  const oldText = asString(input.old_string)
  const newText = asString(input.new_string)
  if (oldText != null || newText != null) {
    return { type: 'diff', hunks: [{ oldText: oldText ?? '', newText: newText ?? '' }] }
  }
  const content = asString(input.content)
  if (content != null) return { type: 'write', content }
  return { type: 'unknown' }
}

// ─── Delegated agents (Agent / Task) ──────────────────────────────────────────

/** The sub-agent type label — `subagentType` when present, else "default agent". */
export function delegateLabel(item: ToolItem): string {
  return item.call.subagentType ?? 'default agent'
}

/** Human label for the spawned agent (childLabel, falling back to description). */
export function delegateChildLabel(item: ToolItem): string | undefined {
  return item.call.childLabel ?? asString(asRecord(item.call.toolInput).description)
}

/** The full delegated prompt handed to the sub-agent. */
export function delegatePrompt(item: ToolItem): string {
  return asString(asRecord(item.call.toolInput).prompt) ?? ''
}

/**
 * The sub-agent's result text. Delegate results arrive as an array of
 * `{type:'text', text}` blocks; tolerate a plain string or unexpected shapes.
 */
export function delegateResultText(item: ToolItem): string {
  const r = item.result?.toolResult
  if (typeof r === 'string') return r
  if (Array.isArray(r)) {
    return r
      .map(block => {
        const b = asRecord(block)
        return b.type === 'text' && typeof b.text === 'string' ? b.text : ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

/**
 * Plain result text for command / file ops (the tool_result is a string).
 * Tolerates an array (joins text blocks) and unexpected shapes (empty string).
 */
export function resultText(item: ToolItem): string {
  const r = item.result?.toolResult
  if (typeof r === 'string') return r
  if (Array.isArray(r)) return delegateResultText(item)
  return ''
}
