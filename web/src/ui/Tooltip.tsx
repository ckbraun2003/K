import * as RT from '@radix-ui/react-tooltip'
import { type ReactNode } from 'react'

export function Tooltip({ content, children }: { content: string; children: ReactNode }) {
  return (
    <RT.Provider delayDuration={300}>
      <RT.Root>
        <RT.Trigger asChild>{children}</RT.Trigger>
        <RT.Portal>
          <RT.Content sideOffset={6}
            className="glass-overlay z-[60] rounded-control px-2 py-1 text-caption text-text">
            {content}
          </RT.Content>
        </RT.Portal>
      </RT.Root>
    </RT.Provider>
  )
}
