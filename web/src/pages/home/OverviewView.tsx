/**
 * OverviewView — Home's Overview tab (UI Simplification Task 11). Carries
 * forward the Task-10 HomePage placeholder verbatim now that HomePage owns
 * the Chat|Overview switch; Tasks 12-13 replace this with the widget grid.
 */
export default function OverviewView() {
  return (
    <div data-testid="home-overview-stub" className="glass-tint rounded-panel flex-1 overflow-y-auto p-6">
      <h1 className="text-lg font-semibold text-[var(--text)]">Home</h1>
      <p className="mt-1 text-sm text-[var(--muted)]">The Home hub is arriving in this phase.</p>
    </div>
  )
}
