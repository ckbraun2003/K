import ReactMarkdown from 'react-markdown'
import { cn } from '../lib/cn'

/**
 * DF-3 — the ONE sanitized markdown renderer for agent-authored prose (run
 * console assistant turns, NarrativeCard goal/bullets). react-markdown with
 * `skipHtml` drops raw HTML nodes entirely (no dangerouslySetInnerHTML path
 * exists in this component), so `**`/`##` render properly and injection is
 * structurally impossible. Element skins are token classes only. `inline`
 * keeps paragraphs margin-free for single-line contexts (dl cells, chips).
 */
export default function Markdown({ text, className, inline = false }: {
  text: string
  className?: string
  inline?: boolean
}) {
  return (
    <div className={cn('min-w-0 break-words', className)}>
      <ReactMarkdown
        skipHtml
        components={{
          p: ({ children }) => <p className={inline ? 'inline' : 'mb-1.5 last:mb-0'}>{children}</p>,
          h1: ({ children }) => <p className="mb-1 mt-2 text-body font-semibold text-text first:mt-0">{children}</p>,
          h2: ({ children }) => <h2 className="mb-1 mt-2 text-body font-semibold text-text first:mt-0">{children}</h2>,
          h3: ({ children }) => <h3 className="mb-0.5 mt-1.5 text-label font-semibold text-text first:mt-0">{children}</h3>,
          ul: ({ children }) => <ul className="mb-1.5 list-disc pl-4 last:mb-0">{children}</ul>,
          ol: ({ children }) => <ol className="mb-1.5 list-decimal pl-4 last:mb-0">{children}</ol>,
          li: ({ children }) => <li className="mb-0.5">{children}</li>,
          strong: ({ children }) => <strong className="font-semibold text-text">{children}</strong>,
          em: ({ children }) => <em>{children}</em>,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent-hover underline underline-offset-2">
              {children}
            </a>
          ),
          code: ({ className: cls, children }) =>
            /language-/.test(cls ?? '') ? (
              <code className="mono block text-label">{children}</code>
            ) : (
              <code className="mono rounded bg-raised px-1 py-0.5 text-label">{children}</code>
            ),
          pre: ({ children }) => (
            <pre className="mono mb-1.5 overflow-x-auto rounded-control bg-raised px-3 py-2 text-label last:mb-0">{children}</pre>
          ),
          blockquote: ({ children }) => (
            <blockquote className="mb-1.5 border-l-2 border-border pl-3 text-muted last:mb-0">{children}</blockquote>
          ),
          hr: () => <hr className="my-2 border-border" />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
