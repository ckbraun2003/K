import { useQuery } from '@tanstack/react-query'
import Tabs, { type TabItem } from '../components/Tabs'
import { INBOX_KEY, inboxQueryFn } from '../lib/inbox-query'
import { navigate } from '../lib/route'
import InboxTab from './personal/InboxTab'
import TasksTab from './personal/TasksTab'

/**
 * Personal hub (UI Simplification Task 14) — replaces the Task 10 stub. Absorbs
 * Inbox (moved intact from InboxPage.tsx, F-none) + a new Tasks tab (KHome's
 * work-items/notes/schedule cards ported for full management) under one tabbed
 * surface. Chats/Memories are placeholder panels until Task 15 fills them in —
 * declared inline here as one-line stubs so the Tabs bar has all 4 destinations.
 */
const TAB_IDS = ['inbox', 'tasks', 'chats', 'memories'] as const
type PersonalTab = (typeof TAB_IDS)[number]

function ChatsTab() {
  return (
    <div data-testid="personal-chats-stub" className="p-4 text-sm italic text-[var(--muted)]">
      Chats — arriving in the next phase.
    </div>
  )
}

function MemoriesTab() {
  return (
    <div data-testid="personal-memories-stub" className="p-4 text-sm italic text-[var(--muted)]">
      Memories — arriving in the next phase.
    </div>
  )
}

export default function PersonalPage({ tab }: { tab?: string }) {
  const active: PersonalTab = (TAB_IDS as readonly string[]).includes(tab ?? '') ? (tab as PersonalTab) : 'inbox'
  // The ONE shared inbox query (rail badge + InboxTab + this tab count all key off
  // it, so the badge/count add zero extra fetches — inbox-query.ts).
  const { data: inbox } = useQuery({ queryKey: INBOX_KEY, queryFn: inboxQueryFn })
  const items: TabItem<PersonalTab>[] = [
    { value: 'inbox', label: 'Inbox', count: inbox?.total || undefined },
    { value: 'tasks', label: 'Tasks' },
    { value: 'chats', label: 'Chats' },
    { value: 'memories', label: 'Memories' },
  ]
  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <Tabs items={items} value={active} onChange={v => navigate('personal', v)} ariaLabel="Personal" />
      {active === 'inbox' && <InboxTab />}
      {active === 'tasks' && <TasksTab />}
      {active === 'chats' && <ChatsTab />}
      {active === 'memories' && <MemoriesTab />}
    </div>
  )
}
