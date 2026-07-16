// web/src/help/pages/RunsReview.tsx — help guide page 3/7 (FE-6)
export function RunsReview() {
  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-title text-text">Runs & reviewing changes</h2>
      <p className="text-body text-muted">
        Every dispatch becomes a run with a live console (event stream), a <strong className="text-text">Timeline</strong>{' '}
        (replayable, checkpoint markers with Rewind-here), and <strong className="text-text">Changes</strong> — the
        per-wave diff of what the agent actually edited: file tree, syntax-highlighted split/unified diff,
        word-level change marks, viewed-checkmarks,{' '}
        <kbd className="mono rounded bg-raised px-1.5 py-0.5 text-[10px] text-text">j</kbd>/
        <kbd className="mono rounded bg-raised px-1.5 py-0.5 text-[10px] text-text">k</kbd> file hops.
      </p>
      <p className="text-body text-muted">
        Interactive runs park at <em>awaiting your reply</em> — answer inline, "Compact context" when the meter runs
        hot, "End session" when done.
      </p>
      <p className="text-body text-muted">
        From Changes: comment on lines → <strong className="text-text">Request changes</strong> dispatches a fix run
        carrying your notes; <strong className="text-text">Approve → PR</strong> publishes the final checkpoint as a{' '}
        <code className="mono text-[10px] text-text">k-review/*</code> branch and opens the PR.
      </p>
    </div>
  )
}
