import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes, type SelectHTMLAttributes } from 'react'
import { cn } from '../lib/cn'

const SKIN = 'bg-bg/60 border text-body text-text placeholder:text-muted/70 rounded-control px-3 py-1.5 ' +
  'transition-colors duration-[var(--dur-1)] focus-visible:outline-none focus-visible:glow-focus'
const border = (invalid?: boolean) => (invalid ? 'border-red/60' : 'border-border hover:border-border-strong')

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(
  function Input({ invalid, className, ...rest }, ref) {
    return <input ref={ref} aria-invalid={invalid || undefined} className={cn(SKIN, border(invalid), className)} {...rest} />
  })

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }>(
  function Textarea({ invalid, className, ...rest }, ref) {
    return <textarea ref={ref} aria-invalid={invalid || undefined} className={cn(SKIN, border(invalid), 'min-h-20', className)} {...rest} />
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
          'h-4 w-4 shrink-0 cursor-pointer rounded border border-border bg-bg/60 accent-accent',
          'focus-visible:outline-none focus-visible:glow-focus disabled:cursor-default disabled:opacity-50',
          className,
        )}
        {...rest}
      />
    )
  })
