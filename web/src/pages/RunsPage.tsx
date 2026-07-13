import { navigate } from '../lib/route'
import RunList from '../components/RunList'
import RunConsole from '../components/RunConsole'
import { EmptyState } from '../ui/EmptyState'

function RunsMasterDetail({ runId }: { runId?: string }) {
  return (
    <div className="flex h-full overflow-hidden">
      {/* NOT glass-chrome — this scrolls dense run-list data, so it stays an
          opaque surface (bg-surface, no blur/radius/all-side border — a flush
          full-height divider, not a floating card) per "dense data never sits
          on blur". */}
      <aside className="bg-surface w-72 flex-shrink-0 overflow-hidden border-r border-border">
        <RunList selectedId={runId ?? null} onSelect={id => navigate('runs', id)} />
      </aside>
      {/* section, not main — the shell already provides the page's <main> landmark */}
      <section className="min-w-0 flex-1 overflow-hidden">
        {runId ? (
          <RunConsole runId={runId} />
        ) : (
          <div className="flex h-full items-center justify-center">
            <EmptyState icon="runs" headline="Select a run" hint="or press ⌘K to dispatch one" />
          </div>
        )}
      </section>
    </div>
  )
}

export default function RunsPage({ runId }: { runId?: string }) {
  return <RunsMasterDetail runId={runId} />
}
