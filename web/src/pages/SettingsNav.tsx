import { useEffect, useState } from 'react'
import { cn } from '../lib/cn'

/**
 * Sticky Settings sidebar nav (desktop only). Items are buttons, not anchors —
 * the app is hash-routed, so an `<a href="#id">` click would set
 * `location.hash` and the router would navigate away from Settings to a 404.
 * Clicking a button instead scrolls its target section into view, and an
 * IntersectionObserver highlights whichever section is currently in the
 * "active" band of the viewport as the user scrolls.
 */
export default function SettingsNav({ items }: { items: Array<{ id: string; label: string }> }) {
  const [activeId, setActiveId] = useState(items[0]?.id)

  useEffect(() => {
    const elements = items
      .map(item => document.getElementById(item.id))
      .filter((el): el is HTMLElement => el !== null)
    if (elements.length === 0) return

    const observer = new IntersectionObserver(
      entries => {
        const intersecting = entries.filter(entry => entry.isIntersecting)
        if (intersecting.length === 0) return
        // Top-most intersecting section — smallest boundingClientRect.top.
        const topMost = intersecting.reduce((a, b) =>
          a.boundingClientRect.top <= b.boundingClientRect.top ? a : b,
        )
        setActiveId(topMost.target.id)
      },
      { rootMargin: '0px 0px -70% 0px', threshold: 0 },
    )

    for (const el of elements) observer.observe(el)
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <nav aria-label="Settings sections" className="sticky top-4 hidden self-start lg:flex lg:flex-col lg:gap-0.5">
      {items.map(item => (
        <button
          key={item.id}
          type="button"
          aria-current={activeId === item.id ? 'true' : undefined}
          onClick={() => document.getElementById(item.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
          className={cn(
            'rounded-control px-2 py-1 text-caption transition-colors',
            activeId === item.id ? 'bg-raised text-text' : 'text-muted hover:text-text',
          )}
        >
          {item.label}
        </button>
      ))}
    </nav>
  )
}
