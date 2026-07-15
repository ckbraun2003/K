// web/src/help/pages/Welcome.tsx — help guide page 1/7 (FE-6)
export function Welcome() {
  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-title text-text">Welcome to K</h2>
      <p className="text-body text-muted">
        K is an agentic organization with a front desk. You talk to <strong className="text-text">K</strong>, a
        secretary who answers logistics itself and hands engineering work to the{' '}
        <strong className="text-text">Chief</strong>, who staffs it to staff-engineer{' '}
        <strong className="text-text">leads</strong> — every step visible, durable, and reviewable.
      </p>
      <p className="text-body text-muted">The sidebar is the whole map:</p>
      <ul className="flex flex-col gap-1.5 text-body text-muted">
        <li><strong className="text-text">Home</strong> — chat with K & your overview grid</li>
        <li><strong className="text-text">Personal</strong> — inbox, tasks, chats, memories</li>
        <li><strong className="text-text">Agents</strong> — the org, skills & automations</li>
        <li><strong className="text-text">Runs</strong> — live and past agent runs</li>
        <li><strong className="text-text">Insights</strong> — charts, deltas, routing, evals</li>
        <li><strong className="text-text">Projects</strong> — your registered repos and their workspaces</li>
      </ul>
      <p className="text-body text-muted">
        Nothing runs on its own unless you switch the Autonomous Org on in Settings; by default the org acts only
        when you ask.
      </p>
    </div>
  )
}
