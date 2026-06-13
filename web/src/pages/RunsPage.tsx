import RunList from '../components/RunList'
import RunConsole from '../components/RunConsole'
import { navigate } from '../lib/route'

export default function RunsPage({ runId }: { runId?: string }) {
  return (
    <div className="flex h-full">
      <aside className="w-72 flex-shrink-0 overflow-hidden border-r border-[var(--border)]">
        <RunList selectedId={runId ?? null} onSelect={id => navigate('runs', id)} />
      </aside>
      {/* section, not main — the shell already provides the page's <main> landmark */}
      <section className="flex-1 overflow-hidden">
        {runId ? (
          <RunConsole runId={runId} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <div className="text-4xl opacity-40">▶</div>
            <p className="text-sm text-[var(--muted)]">Select a run — or press <kbd className="mono rounded bg-[var(--raised)] px-1.5 py-0.5 text-[10px]">⌘K</kbd> to dispatch one.</p>
          </div>
        )}
      </section>
    </div>
  )
}
