import { describe, it, expect } from 'vitest'
import { cn } from '../src/lib/cn'

// M-2 (locking test) — DEV-17 fixed a real regression: tailwind.config.ts
// registers `text` as BOTH a color key (text-on-accent, text-muted, ...) and
// the prefix for the custom type-scale (text-display/title/body/label/
// caption/micro, via fontSize). Without declaring the type-scale names as a
// `font-size` classGroup in lib/cn.ts, twMerge bucketed them with the color
// group instead, so pairing a color class with a size class silently deleted
// the color (e.g. Button primary's `text-on-accent` vanished under
// `text-body`) because twMerge "conflict-resolves" same-group classes by
// keeping only the last one. This file locks that fix in place — it must
// keep failing loudly if the classGroup config regresses.
describe('cn() keeps type-scale and color classes in separate conflict groups', () => {
  it.each([
    ['text-on-accent', 'text-body'],
    ['text-body', 'text-on-accent'],
    ['text-muted', 'text-title'],
    ['text-title', 'text-muted'],
  ])('color %s + size %s survive together, order-independent', (a, b) => {
    const out = cn(a, b)
    expect(out).toContain(a)
    expect(out).toContain(b)
  })

  it('a real call site: Button primary keeps text-on-accent alongside a type-scale class', () => {
    const out = cn('text-on-accent', 'text-body', 'font-medium')
    expect(out).toContain('text-on-accent')
    expect(out).toContain('text-body')
  })

  it('same-group color conflicts still resolve last-wins (not both kept)', () => {
    const out = cn('text-red', 'text-on-accent')
    expect(out).toContain('text-on-accent')
    expect(out).not.toContain('text-red')
  })

  it('same-group type-scale conflicts still resolve last-wins (not both kept)', () => {
    const out = cn('text-body', 'text-title')
    expect(out).toContain('text-title')
    expect(out).not.toContain('text-body')
  })

  it('three-way mix: last color wins, size class is untouched', () => {
    const out = cn('text-red', 'text-title', 'text-on-accent')
    expect(out).toContain('text-on-accent')
    expect(out).not.toContain('text-red')
    expect(out).toContain('text-title')
  })
})
