import { forwardRef, useCallback, useEffect, useRef, type TextareaHTMLAttributes } from 'react'

type Props = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  /** Max height in px before the textarea scrolls instead of growing further. */
  maxHeight?: number
}

/**
 * A controlled textarea that auto-grows to fit its content up to `maxHeight`,
 * then scrolls. Shared by the ⌘K dispatch composer and the run-console HITL
 * answer box so both get identical Enter-to-send / Shift+Enter-newline ergonomics
 * and growth behaviour (callers own the key handling).
 */
const AutoTextarea = forwardRef<HTMLTextAreaElement, Props>(function AutoTextarea(
  { value, maxHeight = 240, className = '', ...rest },
  ref,
) {
  const innerRef = useRef<HTMLTextAreaElement | null>(null)

  // Merge the forwarded ref with our internal one so the parent can focus while
  // we still measure for auto-grow. Memoized so React doesn't detach/reattach the
  // callback ref (null→el) on every render.
  const setRefs = useCallback(
    (el: HTMLTextAreaElement | null) => {
      innerRef.current = el
      if (typeof ref === 'function') ref(el)
      else if (ref) (ref as React.MutableRefObject<HTMLTextAreaElement | null>).current = el
    },
    [ref],
  )

  // Resize on every value change (controlled component).
  useEffect(() => {
    const el = innerRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden'
  }, [value, maxHeight])

  return <textarea ref={setRefs} value={value} rows={1} className={className} {...rest} />
})

export default AutoTextarea
