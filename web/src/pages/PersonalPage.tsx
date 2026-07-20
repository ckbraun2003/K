import { useQuery } from '@tanstack/react-query'
import Tabs, { type TabItem } from '../components/Tabs'
import { INBOX_KEY, inboxQueryFn } from '../lib/inbox-query'
import { navigate } from '../lib/route'
import InboxTab from './personal/InboxTab'
import TasksTab from './personal/TasksTab'
import MemoriesTab from './personal/MemoriesTab'

/**
 * Personal hub (UI Simplification Task 14, filled out by Task 15) — replaces
 * the Task 10 stub. Absorbs Inbox (moved intact from InboxPage.tsx) + Tasks
 * (KHome's work-items/notes/schedule cards ported for full management) +
 * Memories (operator-memory UI, Task 15) under one tabbed surface. The former
 * Chats tab folded into the Messages surface (Continuous Agents B.6) — its
 * legacy hash #/personal/chats redirects there (route.ts VIEW_REDIRECTS).
 */
const TAB_IDS = ['inbox', 'tasks', 'memories'] as const
type PersonalTab = (typeof TAB_IDS)[number]

export default function PersonalPage({ tab }: { tab?: string }) {
  const active: PersonalTab = (TAB_IDS as readonly string[]).includes(tab ?? '') ? (tab as PersonalTab) : 'inbox'
  // The ONE shared inbox query (rail badge + InboxTab + this tab count all key off
  // it, so the badge/count add zero extra fetches — inbox-query.ts).
  const { data: inbox } = useQuery({ queryKey: INBOX_KEY, queryFn: inboxQueryFn })
  const items: TabItem<PersonalTab>[] = [
    { value: 'inbox', label: 'Inbox', count: inbox?.total || undefined },
    { value: 'tasks', label: 'Tasks' },
    { value: 'memories', label: 'Memories' },
  ]
  return (
    <div className="flex h-full flex-col gap-3 p-5">
      <Tabs items={items} value={active} onChange={v => navigate('personal', v)} ariaLabel="Personal" />
      {active === 'inbox' && <InboxTab />}
      {active === 'tasks' && <TasksTab />}
      {active === 'memories' && <MemoriesTab />}
    </div>
  )
}
