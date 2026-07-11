/**
 * Personal hub — UI Simplification Task 10 stub. Absorbs Inbox/Memory + (later)
 * chats and tasks under one tabbed surface; Task 14 fills this in.
 */
export default function PersonalPage({ tab }: { tab?: string }) {
  return (
    <div className="h-full overflow-y-auto p-6">
      <div data-testid="personal-page" className="glass-tint rounded-panel p-6">
        <h1 className="text-lg font-semibold text-[var(--text)]">Personal</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">The Personal hub is arriving in this phase.</p>
        {tab && <p className="mt-1 text-xs text-[var(--muted)]">tab: {tab}</p>}
      </div>
    </div>
  )
}
