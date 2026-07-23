import OverviewView from './home/OverviewView'

/**
 * Home hub (D-129 — Home = Overview only). Home is now a single Overview
 * surface — no Chat|Overview split (ChatView is retired from this route; the
 * quick-ask affordance is the globally-mounted MessageDock bar variant at
 * Shell level, which now redirects a Home send to the Chats/Messages surface
 * with K's conversation open instead of rendering inline). See
 * MessageDock.tsx's `submit()` for the redirect and OverviewView.tsx for the
 * in-page "Overview" section header.
 */
export default function HomePage() {
  return (
    <div className="flex h-full flex-col gap-3 p-5">
      <OverviewView />
    </div>
  )
}
