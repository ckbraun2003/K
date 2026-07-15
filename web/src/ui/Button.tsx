import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cn } from '../lib/cn'
import { Icon, type IconName } from './Icon'
import { Spinner } from './Spinner'

type Variant = 'primary' | 'glass' | 'ghost' | 'danger'
type Size = 'sm' | 'md'

const VARIANT: Record<Variant, string> = {
  primary: 'bg-accent text-on-accent font-medium hover:brightness-110',
  glass: 'glass-chrome glass-interactive text-text hover:border-border-strong',
  ghost: 'text-muted hover:text-text hover:bg-raised',
  danger: 'border border-red/40 text-red hover:bg-red/10',
}
const SIZE: Record<Size, string> = {
  sm: 'h-7 px-2.5 text-label gap-1.5 rounded-control',
  md: 'h-9 px-3.5 text-body gap-2 rounded-control',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant; size?: Size; loading?: boolean; icon?: IconName
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'glass', size = 'md', loading, icon, className, children, disabled, type = 'button', ...rest }, ref
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center justify-center select-none transition-[transform,filter,background-color,border-color] duration-[var(--dur-1)]',
        'active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none focus-visible:glow-focus',
        VARIANT[variant], SIZE[size], className,
      )}
      {...rest}
    >
      {loading ? <Spinner size={14} /> : icon ? <Icon name={icon} size={size === 'sm' ? 14 : 16} /> : null}
      {children}
    </button>
  )
})

export const IconButton = forwardRef<HTMLButtonElement,
  Omit<ButtonProps, 'icon' | 'children' | 'aria-label' | 'title'> & { name: IconName; label: string }
>(function IconButton({ name, label, size = 'sm', className, ...rest }, ref) {
  return (
    <Button ref={ref} size={size} aria-label={label} title={label}
      className={cn('px-0 aspect-square', className)} {...rest}>
      <Icon name={name} size={size === 'sm' ? 14 : 16} />
    </Button>
  )
})
