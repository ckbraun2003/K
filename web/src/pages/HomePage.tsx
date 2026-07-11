/**
 * Home hub — UI Simplification Task 10 stub. Replaces KHome as the routed
 * `home` view; Task 11 fills this in with the chat-first Home layout (the
 * MessageDock bar variant, mounted at Shell level, is already live here).
 */
export default function HomePage() {
  return (
    <div className="h-full overflow-y-auto p-6">
      <div data-testid="home-page" className="glass-tint rounded-panel p-6">
        <h1 className="text-lg font-semibold text-[var(--text)]">Home</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">The Home hub is arriving in this phase.</p>
      </div>
    </div>
  )
}
