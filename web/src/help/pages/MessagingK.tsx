// web/src/help/pages/MessagingK.tsx — help guide page 2/7 (FE-6)
export function MessagingK() {
  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-title text-text">Messaging K & dispatching</h2>
      <p className="text-body text-muted">
        The dock is the one front door: a bar on Home, a floating K button everywhere else.{' '}
        <kbd className="mono rounded bg-raised px-1.5 py-0.5 text-[10px] text-text">⌘K</kbd> focuses it anywhere.
      </p>
      <p className="text-body text-muted">
        The route preview shows where a message will land before you send it. Typing{' '}
        <strong className="text-text">@project</strong> turns the send into an agent dispatch with a confirm card —
        model, scope, <strong className="text-text">Interactive</strong> to answer questions mid-run,{' '}
        <strong className="text-text">Plan-first</strong> to approve a plan before any edits.
      </p>
      <p className="text-body text-muted">
        Every send has a 5-second <strong className="text-text">Undo</strong>. Model and force-route overrides live
        under the expander.
      </p>
    </div>
  )
}
