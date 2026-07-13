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
