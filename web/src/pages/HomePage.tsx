import { useState } from 'react'
import SegControl from '../components/SegControl'
import ChatView from './home/ChatView'
import OverviewView from './home/OverviewView'

const VIEW_KEY = 'k.home.view'
type HomeView = 'chat' | 'overview'

/**
 * Home hub (UI Simplification Task 11) — replaces the Task-10 stub as the
 * routed `home` view. A top-of-page `Chat | Overview` SegControl (spec 5):
 * Chat is the two-pane thread list + transcript (ChatView, this task);
 * Overview stays the Task-10 placeholder until the widget grid lands
 * (Tasks 12-13). The last-used tab is remembered per device (localStorage
 * `'k.home.view'`) — S-6: a fresh install with nothing stored lands on
 * `'chat'` so a first boot faces K, not an empty widget grid. The composer
 * itself is NOT here — the MessageDock bar variant is mounted at Shell level
 * on this route (Task 10) and shares the same thread-select store ChatView
 * reads, so a send lands in the transcript live.
 */
export default function HomePage() {
  const [view, setView] = useState<HomeView>(() => {
    try {
      const stored = localStorage.getItem(VIEW_KEY)
      return stored === 'overview' ? 'overview' : 'chat'
    } catch {
      return 'chat'
    }
  })

  function switchView(v: HomeView) {
    setView(v)
    try { localStorage.setItem(VIEW_KEY, v) } catch { /* storage unavailable */ }
  }

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <SegControl<HomeView>
        ariaLabel="Home view"
        value={view}
        onChange={switchView}
        options={[{ label: 'Chat', value: 'chat' }, { label: 'Overview', value: 'overview' }]}
      />
      {view === 'chat' ? <ChatView /> : <OverviewView />}
    </div>
  )
}
