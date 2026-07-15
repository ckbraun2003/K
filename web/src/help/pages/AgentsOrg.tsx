// web/src/help/pages/AgentsOrg.tsx — help guide page 5/7 (FE-6)
export function AgentsOrg() {
  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-title text-text">Agents & the org</h2>
      <p className="text-body text-muted">
        The org lives under Agents: <strong className="text-text">Org</strong> (roster of K, Chief and the
        discipline leads; tree & fleet graph), <strong className="text-text">Skills</strong> (the capability
        catalog: enable host skills, trust-then-enable MCP servers — you always review the exact command first —
        probe token cost, mount capabilities on leads), and <strong className="text-text">Automations</strong>{' '}
        (named role-chain templates you can dispatch as one unit).
      </p>
      <p className="text-body text-muted">
        The Skill Creator drafts, refines, evaluates and saves new skills with an agent.
      </p>
    </div>
  )
}
