import { useState } from 'react'
import AutoTextarea from './AutoTextarea'
import { Input } from '../ui/Field'

/**
 * Editor for an agent-drafted SKILL.md (D-071) — deliberately NOT the
 * automation registry's SkillEditor (that edits a prompt-source row; this
 * edits a real SKILL.md document). Splits the draft into the two frontmatter
 * fields that matter for discovery quality (name, description) plus the
 * markdown body; save recomposes ONE skillMd string for the PATCH, preserving
 * any frontmatter lines it doesn't own (license, allowed-tools, …).
 */

export interface ParsedSkillMd {
  name: string
  description: string
  /** Frontmatter CHUNKS other than the extracted fields, verbatim and in
   *  order. A chunk is one logical entry — a key line plus any indented
   *  continuation lines (block scalars stay atomic), or a lone other line. */
  otherFrontmatter: string[]
  body: string
}

/** Group frontmatter lines into logical chunks: a top-level line owns every
 *  following indented (continuation) line — so YAML block scalars ride
 *  through parse→compose atomically instead of being orphaned (review C4-2). */
function chunkFrontmatter(lines: string[]): { key: string | null; text: string; simple: boolean }[] {
  const chunks: { key: string | null; lines: string[] }[] = []
  for (const line of lines) {
    if (/^[ \t]/.test(line) && chunks.length > 0) {
      chunks[chunks.length - 1].lines.push(line) // continuation of the previous entry
      continue
    }
    const kv = line.match(/^(\w[\w-]*):\s?(.*)$/)
    chunks.push({ key: kv ? kv[1] : null, lines: [line] })
  }
  return chunks.map(c => {
    const value = c.lines[0].match(/^(\w[\w-]*):\s?(.*)$/)?.[2] ?? ''
    // Simple = a one-line plain scalar. Block/folded scalars (|, >, variants)
    // and multi-line entries are NOT editable as fields — kept verbatim.
    const simple = c.key !== null && c.lines.length === 1 && !/^[|>]/.test(value.trim())
    return { key: c.key, text: c.lines.join('\n'), simple }
  })
}

/** Parse a SKILL.md into frontmatter fields + body. No frontmatter → empty
 *  fields, whole document as body (never destructive on odd input). */
export function parseSkillMd(md: string): ParsedSkillMd {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!m) return { name: '', description: '', otherFrontmatter: [], body: md }
  let name = ''
  let description = ''
  const other: string[] = []
  for (const chunk of chunkFrontmatter(m[1].split(/\r?\n/))) {
    const value = chunk.text.match(/^(\w[\w-]*):\s?(.*)$/)?.[2] ?? ''
    if (chunk.key === 'name' && chunk.simple && name === '') name = value
    else if (chunk.key === 'description' && chunk.simple && description === '') description = value
    else other.push(chunk.text)
  }
  return { name, description, otherFrontmatter: other, body: md.slice(m[0].length) }
}

/** Recompose a SKILL.md from the edited fields (inverse of parseSkillMd). A
 *  typed name/description REPLACES any leftover chunk for the same key (a
 *  duplicate or block-scalar original), so a save can never emit two keys. */
export function composeSkillMd(parts: ParsedSkillMd): string {
  const name = parts.name.trim()
  const description = parts.description.trim()
  const fm: string[] = []
  if (name !== '') fm.push(`name: ${name}`)
  if (description !== '') fm.push(`description: ${description}`)
  for (const chunk of parts.otherFrontmatter) {
    if (chunk.trim() === '') continue
    if (name !== '' && /^name:/.test(chunk)) continue
    if (description !== '' && /^description:/.test(chunk)) continue
    fm.push(chunk)
  }
  if (fm.length === 0) return parts.body
  return `---\n${fm.join('\n')}\n---\n${parts.body}`
}

export default function SkillDraftEditor({
  skillMd,
  busy,
  onSave,
}: {
  skillMd: string
  busy: boolean
  /** Receives the FULL recomposed skillMd — the caller PATCHes it. */
  onSave: (nextMd: string) => void
}) {
  // Seeded once per mount — the parent keys this component on draft revision/
  // updatedAt so a landed refine re-seeds a fresh editor (SkillEditor pattern).
  const [initial] = useState(() => parseSkillMd(skillMd))
  const [name, setName] = useState(initial.name)
  const [description, setDescription] = useState(initial.description)
  const [body, setBody] = useState(initial.body)

  const dirty =
    name !== initial.name || description !== initial.description || body !== initial.body

  const inputCls =
    'w-full rounded-lg border border-border bg-raised px-3 py-1.5 text-sm text-text placeholder-muted focus:border-accent focus:outline-none'

  return (
    <div data-testid="draft-editor" className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="draft-editor-name" className="mb-1 block text-xs text-muted">
            Frontmatter · name
          </label>
          <Input
            id="draft-editor-name"
            data-testid="draft-editor-name"
            className={inputCls}
            placeholder="skill-name"
            value={name}
            onChange={e => setName(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="draft-editor-description" className="mb-1 block text-xs text-muted">
            Frontmatter · description (the trigger — what makes agents load this skill)
          </label>
          <Input
            id="draft-editor-description"
            data-testid="draft-editor-description"
            className={inputCls}
            placeholder="Use when…"
            value={description}
            onChange={e => setDescription(e.target.value)}
          />
        </div>
      </div>
      <div>
        <label htmlFor="draft-editor-body" className="mb-1 block text-xs text-muted">
          SKILL.md body (markdown)
        </label>
        <AutoTextarea
          id="draft-editor-body"
          data-testid="draft-editor-body"
          maxHeight={480}
          className={`${inputCls} mono resize-none text-[12px] leading-relaxed`}
          value={body}
          onChange={e => setBody(e.target.value)}
        />
      </div>
      <button
        data-testid="draft-editor-save"
        disabled={busy || !dirty}
        onClick={() =>
          onSave(
            composeSkillMd({ name, description, otherFrontmatter: initial.otherFrontmatter, body }),
          )
        }
        className="rounded-lg bg-accent px-4 py-1.5 text-xs font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {busy ? 'saving…' : 'save draft'}
      </button>
    </div>
  )
}
