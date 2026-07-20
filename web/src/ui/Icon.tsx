import {
  House, ListChecks, Crown, Play, Activity, FolderKanban, CircleHelp, Settings,
  BookOpen, PenLine, ListOrdered, Check, X, TriangleAlert, Trash2, Monitor,
  FileText, RefreshCw, ChevronRight, ChevronDown, ArrowRight, ArrowLeft, Plus,
  Search, Mic, Send, Zap, Square, Pencil, ExternalLink, Bell, Copy, GitPullRequest,
  MessagesSquare, Archive, ArchiveRestore,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '../lib/cn'

export const ICONS = {
  home: House, personal: ListChecks, agents: Crown, runs: Play, insights: Activity,
  projects: FolderKanban, help: CircleHelp, settings: Settings, docs: BookOpen,
  skillCreator: PenLine, timeline: ListOrdered, check: Check, close: X,
  warning: TriangleAlert, trash: Trash2, monitor: Monitor, file: FileText,
  refresh: RefreshCw, chevronRight: ChevronRight, chevronDown: ChevronDown,
  arrowRight: ArrowRight, arrowLeft: ArrowLeft, plus: Plus, search: Search,
  mic: Mic, send: Send, bolt: Zap, stop: Square, edit: Pencil,
  external: ExternalLink, bell: Bell, copy: Copy, pr: GitPullRequest,
  messages: MessagesSquare, archive: Archive, unarchive: ArchiveRestore,
} satisfies Record<string, LucideIcon>

export type IconName = keyof typeof ICONS

export function Icon({ name, size = 16, className, label }: {
  name: IconName; size?: 14 | 16 | 20; className?: string; label?: string
}) {
  const C = ICONS[name]
  return (
    <C
      size={size}
      strokeWidth={size >= 20 ? 1.5 : 1.75}
      className={cn('shrink-0', className)}
      aria-hidden={label ? undefined : true}
      aria-label={label}
    />
  )
}
