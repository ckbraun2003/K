/**
 * Agents hub — UI Simplification Task 10 stub. Merges Org (roster/tree/graph) +
 * Skills (catalog/MCP/hooks/automations) + Runs' pipelines sub-tab under one
 * surface; Task 16 fills this in.
 */
export default function AgentsPage({ tab, sub }: { tab?: string; sub?: string }) {
  return (
    <div className="h-full overflow-y-auto p-6">
      <div data-testid="agents-page" className="glass-tint rounded-panel p-6">
        <h1 className="text-lg font-semibold text-[var(--text)]">Agents</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">The Agents hub is arriving in this phase.</p>
        {(tab || sub) && (
          <p className="mt-1 text-xs text-[var(--muted)]">
            {tab && <>tab: {tab} </>}{sub && <>sub: {sub}</>}
          </p>
        )}
      </div>
    </div>
  )
}
