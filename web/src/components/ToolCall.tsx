import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { cn } from '../lib/cn'
import {
  type ToolItem,
  commandText,
  commandDescription,
  fileSummary,
  fileOp,
  fileDetail,
  delegateLabel,
  delegateChildLabel,
  delegatePrompt,
  delegateResultText,
  resultText,
  resolveToolKind,
  toolArgSummary,
  isPending,
  isError,
} from '../lib/console'

/**
 * Rich, collapsible rendering of a single paired tool call (Wave D4).
 *
 * Collapsed by default: only the summary line shows; details reveal on expand.
 * The expand reveal uses framer-motion (NOT a CSS transition) so it honors the
 * app-wide `<MotionConfig reducedMotion="user">` in Shell.tsx — Framer ignores
 * the CSS reduced-motion rule. Error styling (red) is shown only when the
 * result is EXPLICITLY flagged as an error.
 */
export default function ToolCall({ item, runEnded = false }: { item: ToolItem; runEnded?: boolean }) {
  // Resolve on the display side so a name-recognized shell tool the core
  // classifier tagged 'other' (PowerShell/pwsh) still renders as a command card
  // with its command in the header (F-078).
  switch (resolveToolKind(item)) {
    case 'command':
      return <CommandCall item={item} runEnded={runEnded} />
    case 'file':
      return <FileCall item={item} runEnded={runEnded} />
    case 'delegate':
      return <DelegateCall item={item} runEnded={runEnded} />
    default:
      return <OtherCall item={item} runEnded={runEnded} />
  }
}

// ─── Shared expandable shell ──────────────────────────────────────────────────

function ExpandableRow({
  icon,
  summary,
  detail,
  error = false,
  pending = false,
  testid,
}: {
  icon: React.ReactNode
  summary: React.ReactNode
  /** Expanded body. When omitted the row is a non-interactive summary only. */
  detail?: React.ReactNode
  error?: boolean
  pending?: boolean
  testid?: string
}) {
  const [open, setOpen] = useState(false)
  const hasDetail = detail != null
  return (
    <div
      data-testid={testid}
      className={cn(
        'rounded-lg border bg-[var(--raised)]',
        error ? 'border-[var(--red)]/50' : 'border-[var(--border)]',
      )}
    >
      <button
        type="button"
        onClick={() => hasDetail && setOpen(o => !o)}
        disabled={!hasDetail}
        aria-expanded={hasDetail ? open : undefined}
        className={cn(
          'flex w-full items-center gap-2 px-3 py-1.5 text-left',
          hasDetail && 'cursor-pointer',
        )}
      >
        <span className="flex-shrink-0 text-xs text-[var(--muted)]">{icon}</span>
        <span
          className={cn(
            'min-w-0 flex-1 truncate font-mono text-xs',
            error ? 'text-[var(--red)]' : 'text-[var(--text)]',
          )}
        >
          {summary}
        </span>
        {pending && (
          <span className="flex-shrink-0 text-[10px] italic text-[var(--muted)]">running…</span>
        )}
        {hasDetail && (
          <span
            className={cn(
              'flex-shrink-0 text-[10px] text-[var(--muted)] transition-transform',
              open && 'rotate-90',
            )}
            aria-hidden
          >
            ▸
          </span>
        )}
      </button>
      <AnimatePresence initial={false}>
        {open && hasDetail && (
          <motion.div
            key="detail"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden"
          >
            <div className="border-t border-[var(--border)] px-3 py-2">{detail}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/** Mono code/output block, scrollable so long output can't blow up the row. */
function CodeBlock({ text, tone }: { text: string; tone?: 'add' | 'del' | 'error' }) {
  return (
    <pre
      className={cn(
        'max-h-64 overflow-auto whitespace-pre-wrap break-words rounded px-2.5 py-1.5 font-mono text-xs',
        tone === 'add' && 'bg-green/10 text-[var(--green)]',
        tone === 'del' && 'bg-red/10 text-[var(--red)]',
        tone === 'error' && 'bg-red/10 text-[var(--red)]',
        tone == null && 'bg-[var(--surface)] text-[var(--muted)]',
      )}
    >
      {text}
    </pre>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">
      {children}
    </p>
  )
}

// ─── Command (Bash) ───────────────────────────────────────────────────────────

export function CommandCall({ item, runEnded = false }: { item: ToolItem; runEnded?: boolean }) {
  const command = commandText(item)
  const description = commandDescription(item)
  const output = resultText(item)
  // A tool_use with no result after the run ended is resolved (unknown), never
  // perpetually "running…" (F-063).
  const pending = isPending(item) && !runEnded
  const error = isError(item)

  const detail =
    !pending ? (
      <div className="space-y-2">
        {description && <p className="text-xs text-[var(--muted)]">{description}</p>}
        {output ? (
          <CodeBlock text={output} tone={error ? 'error' : undefined} />
        ) : (
          <p className="text-xs italic text-[var(--muted)]">(no output)</p>
        )}
      </div>
    ) : undefined

  return (
    <ExpandableRow
      testid="tool-command"
      icon="$"
      error={error}
      pending={pending}
      summary={<span>{command || '(empty command)'}</span>}
      detail={detail}
    />
  )
}

// ─── File ops (Write / Edit / MultiEdit) ──────────────────────────────────────

const FILE_OP_LABEL: Record<string, string> = {
  write: 'Write',
  edit: 'Edit',
  multiedit: 'MultiEdit',
  unknown: 'File',
}

export function FileCall({ item, runEnded = false }: { item: ToolItem; runEnded?: boolean }) {
  const path = fileSummary(item)
  const op = fileOp(item)
  const detail = fileDetail(item)
  const error = isError(item)
  const errorText = error ? resultText(item) : ''
  const pending = isPending(item) && !runEnded

  let body: React.ReactNode
  if (detail.type === 'write') {
    body = (
      <div>
        <SectionLabel>New file content</SectionLabel>
        <CodeBlock text={detail.content || '(empty)'} tone="add" />
      </div>
    )
  } else if (detail.type === 'diff') {
    body = (
      <div className="space-y-3">
        {detail.hunks.map((h, i) => (
          <div key={i} className="space-y-1">
            {detail.hunks.length > 1 && <SectionLabel>Edit {i + 1}</SectionLabel>}
            <CodeBlock text={h.oldText || '(empty)'} tone="del" />
            <CodeBlock text={h.newText || '(empty)'} tone="add" />
          </div>
        ))}
      </div>
    )
  } else {
    body = <p className="text-xs italic text-[var(--muted)]">(no preview available)</p>
  }

  return (
    <ExpandableRow
      testid="tool-file"
      icon="✎"
      error={error}
      pending={pending}
      summary={
        <span>
          <span className="text-[var(--accent-hover)]">{FILE_OP_LABEL[op]}</span> {path}
        </span>
      }
      detail={
        <div className="space-y-2">
          {errorText && <CodeBlock text={errorText} tone="error" />}
          {body}
        </div>
      }
    />
  )
}

// ─── Delegated agents (Agent / Task) ──────────────────────────────────────────

export function DelegateCall({ item, runEnded = false }: { item: ToolItem; runEnded?: boolean }) {
  const agent = delegateLabel(item)
  const label = delegateChildLabel(item)
  const prompt = delegatePrompt(item)
  const result = delegateResultText(item)
  const pending = isPending(item) && !runEnded
  const error = isError(item)

  return (
    <ExpandableRow
      testid="tool-delegate"
      icon="◆"
      error={error}
      pending={pending}
      summary={
        <span>
          <span className="text-[var(--accent-hover)]">{agent}</span>
          {label && <span className="text-[var(--muted)]"> · {label}</span>}
        </span>
      }
      detail={
        <div className="space-y-3">
          <div>
            <SectionLabel>Prompt</SectionLabel>
            <CodeBlock text={prompt || '(no prompt)'} />
          </div>
          {!pending && (
            <div>
              <SectionLabel>Result</SectionLabel>
              {result ? (
                <CodeBlock text={result} tone={error ? 'error' : undefined} />
              ) : (
                <p className="text-xs italic text-[var(--muted)]">(no result)</p>
              )}
            </div>
          )}
        </div>
      }
    />
  )
}

// ─── Other / unknown tools ────────────────────────────────────────────────────

export function OtherCall({ item, runEnded = false }: { item: ToolItem; runEnded?: boolean }) {
  const name = item.call.tool ?? 'tool'
  // Show the tool's salient input arg in the header instead of empty parens
  // (Read → path, ToolSearch → query, mcp__ tools → their key arg) — F-063.
  const arg = toolArgSummary(item)
  const output = resultText(item)
  const pending = isPending(item) && !runEnded
  const error = isError(item)

  return (
    <ExpandableRow
      testid="tool-other"
      icon="⚙"
      error={error}
      pending={pending}
      summary={
        <span>
          <span className="text-[var(--accent-hover)]">{name}</span>
          <span className="text-[var(--muted)]">({arg})</span>
        </span>
      }
      detail={
        !pending && output ? (
          <CodeBlock text={output} tone={error ? 'error' : undefined} />
        ) : undefined
      }
    />
  )
}
