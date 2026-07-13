import { useState, useId } from 'react'
import { GLOSSARY } from '../generated/glossary'

/**
 * E-12: wrap any inline text in a glossary tooltip. If the term is unknown, renders
 * the children plainly (no dangling affordance). Keyboard + hover accessible.
 */
export default function GlossaryTerm({ term, children }: { term: string; children: React.ReactNode }) {
  const def = GLOSSARY[term]
  const [open, setOpen] = useState(false)
  const id = useId()
  if (!def) return <>{children}</>
  return (
    <span className="relative inline-block">
      <span
        tabIndex={0}
        aria-describedby={open ? id : undefined}
        data-testid="glossary-term"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className="cursor-help underline decoration-dotted underline-offset-2"
      >
        {children}
      </span>
      {open && (
        <span
          id={id}
          role="tooltip"
          className="absolute left-0 top-full z-30 mt-1 w-56 rounded border border-border bg-surface p-2 text-[11px] font-normal text-text shadow-lg"
        >
          <span className="font-semibold">{term}</span> — {def}
        </span>
      )}
    </span>
  )
}
