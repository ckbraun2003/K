import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

// The custom type-scale classes (tailwind.config.ts fontSize) must be declared
// as font-size utilities here: without this twMerge buckets text-body/text-label
// etc. as text COLORS, so a size class silently deletes a variant's ink on the
// same element (e.g. Button primary lost text-on-accent) — DEV-17.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ['display', 'title', 'body', 'label', 'caption', 'micro'] }],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
