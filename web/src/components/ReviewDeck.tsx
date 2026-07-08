// web/src/components/ReviewDeck.tsx (W0 stub — Lane A replaces the whole body,
// keeping this exact prop contract)
export interface ReviewDeckProps {
  runId: string
  projectId: string | null
}

export default function ReviewDeck(_props: ReviewDeckProps) {
  return (
    <div data-testid="review-deck" className="flex-1 flex items-center justify-center text-xs text-[var(--muted)]">
      Review Deck
    </div>
  )
}
