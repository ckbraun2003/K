import * as RD from '@radix-ui/react-dialog'
import { type ReactNode } from 'react'
import { IconButton } from './Button'

export function Dialog({ open, onOpenChange, title, children, footer }: {
  open: boolean; onOpenChange: (o: boolean) => void
  title: string; children: ReactNode; footer?: ReactNode
}) {
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="fixed inset-0 z-50 bg-bg-deep/60" />
        <RD.Content className="glass-overlay fixed left-1/2 top-1/2 z-50 w-[min(480px,90vw)]
          -translate-x-1/2 -translate-y-1/2 p-5 focus:outline-none">
          <div className="flex items-start justify-between gap-4 mb-3">
            <RD.Title className="text-title">{title}</RD.Title>
            <RD.Close asChild><IconButton variant="ghost" name="close" label="Close" /></RD.Close>
          </div>
          <div className="text-body text-muted">{children}</div>
          {footer && <div className="mt-4 flex justify-end gap-2">{footer}</div>}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  )
}
