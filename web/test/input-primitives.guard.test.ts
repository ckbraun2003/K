import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * Input-primitives sweep guard (orch-p2 C.6). The messaging/rename/add/edit
 * surfaces were swept from raw `<input>/<textarea>/<select>` to the shared
 * `ui/Field.tsx` primitives (`Input`, `Textarea`, `Select`, `Checkbox`) so every
 * form control in the app shares one skin (border/bg/radius/focus-visible glow)
 * instead of ~25 hand-rolled chrome variants. This is a STATIC regression guard
 * (mirrors `bundle-guard.test.ts`'s walk-and-grep shape) — it fails in CI if a
 * raw system-styled element creeps back in, without needing to re-render every
 * swept surface.
 *
 * Three narrow, deliberate exceptions (not violations):
 *
 *  1. `ui/Field.tsx` and `components/AutoTextarea.tsx` — these two files ARE the
 *     primitives (Field defines Input/Textarea/Select/Checkbox; AutoTextarea is
 *     the auto-grow textarea that carries Field's exported SKIN internally). A
 *     raw element inside either is the implementation, not a bypass of it.
 *
 *  2. `type="radio"` and `type="range"` inputs — `ui/Field.tsx` has no Radio or
 *     Range primitive (the task scope was Input/Textarea/Select/Checkbox only:
 *     KnowledgeGraphTab's dispatch-action picker and RunTimeline's/
 *     SettingsAutonomy's replay/budget sliders stay raw, deliberately).
 *
 *  3. A tag mention inside a `//` line comment (e.g. TerminalPage.tsx documents
 *     xterm's own internal `.xterm-helper-textarea` DOM node in prose) is not a
 *     rendered element and must not trip the guard.
 */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
}

const EXEMPT_FILES = new Set(['src/ui/Field.tsx', 'src/components/AutoTextarea.tsx'])

const RAW_TAG = /<(input|select|textarea)\b/g

/** Grabs from a raw `<input` match up to its first `>` so we can inspect its
 *  `type="…"` attribute (radio/range are the two allowed raw input types). Plain
 *  string scan, not a second regex pass — attribute order/quoting varies and none
 *  of these tags embed a literal `>` inside a prop value in this codebase. */
function tagSlice(src: string, start: number): string {
  const end = src.indexOf('>', start)
  return end === -1 ? src.slice(start) : src.slice(start, end + 1)
}

describe('input-primitives guard — raw form elements route through ui/Field.tsx', () => {
  it('finds no raw <input>/<select>/<textarea> outside the primitives, comments, or radio/range', () => {
    const srcDir = join(__dirname, '..', 'src')
    const offenders: string[] = []

    for (const file of walk(srcDir).filter((f) => f.endsWith('.tsx'))) {
      const rel = relative(join(__dirname, '..'), file).replace(/\\/g, '/')
      if (EXEMPT_FILES.has(rel)) continue

      const src = readFileSync(file, 'utf8')
      for (const m of src.matchAll(RAW_TAG)) {
        const idx = m.index ?? 0
        const lineStart = src.lastIndexOf('\n', idx) + 1
        const line = src.slice(lineStart, src.indexOf('\n', idx) === -1 ? src.length : src.indexOf('\n', idx))
        const commentAt = line.indexOf('//')
        // A `//` earlier on the same line than the match column is prose, not JSX.
        if (commentAt !== -1 && commentAt < idx - lineStart) continue

        if (m[1] === 'input') {
          const tag = tagSlice(src, idx)
          if (/type=["']radio["']/.test(tag) || /type=["']range["']/.test(tag)) continue
        }

        const snippet = line.trim().slice(0, 100)
        offenders.push(`${rel}: ${snippet}`)
      }
    }

    expect(offenders).toEqual([])
  })
})
