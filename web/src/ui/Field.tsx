import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes, type SelectHTMLAttributes } from 'react'
import { cn } from '../lib/cn'

// Shared control geometry/typography — no surface (no glass box, no focus ring),
// so it can back both the glass skin and the bare variant.
const SKIN_BASE = 'text-body text-text placeholder:text-muted/70 rounded-control px-3 py-1.5 ' +
  'transition-colors duration-[var(--dur-1)] focus-visible:outline-none'
// Exported so AutoTextarea (which needs auto-grow height management the plain
// Textarea primitive doesn't do) can carry the same base skin (orch-p2 C.6).
export const SKIN = `glass-control ${SKIN_BASE} focus-visible:glow-focus`
// Bare variant (ui-adjustments Round 2) — no glass-control box-shadow/border and
// no focus glow, so the composer reads as a plain bar not a form. The wrapper
// supplies whatever surface (or none) it wants; the field itself is transparent.
export const SKIN_BARE = `bg-transparent ${SKIN_BASE}`
const border = (invalid?: boolean) => (invalid ? 'border-red/60' : 'border-border hover:border-border-strong')

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean; variant?: 'bare' }>(
  function Input({ invalid, variant, className, ...rest }, ref) {
    const bare = variant === 'bare'
    return <input ref={ref} aria-invalid={invalid || undefined} className={cn(bare ? SKIN_BARE : SKIN, bare ? '' : border(invalid), className)} {...rest} />
  })

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean; variant?: 'bare' }>(
  function Textarea({ invalid, variant, className, ...rest }, ref) {
    const bare = variant === 'bare'
    return <textarea ref={ref} aria-invalid={invalid || undefined} className={cn(bare ? SKIN_BARE : SKIN, bare ? '' : border(invalid), 'min-h-20', className)} {...rest} />
  })

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }>(
  function Select({ invalid, className, ...rest }, ref) {
    return <select ref={ref} aria-invalid={invalid || undefined} className={cn(SKIN, border(invalid), 'pr-8', className)} {...rest} />
  })

// The one filled checkbox skin (Task 8) — every raw `type="checkbox"` in the app adopts
// this instead of the browser default, so form controls read as one system.
export const Checkbox = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Checkbox({ className, ...rest }, ref) {
    return (
      <input
        ref={ref}
        type="checkbox"
        className={cn(
          'h-4 w-4 shrink-0 cursor-pointer rounded glass-control accent-accent',
          'focus-visible:outline-none focus-visible:glow-focus disabled:cursor-default disabled:opacity-50',
          className,
        )}
        {...rest}
      />
    )
  })
