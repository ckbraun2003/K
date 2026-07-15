// web/src/help/pages/ProjectsBibles.tsx — help guide page 4/7 (FE-6)
export function ProjectsBibles() {
  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-title text-text">Projects & bibles</h2>
      <p className="text-body text-muted">
        Register a project from a local path or a GitHub URL (cloned into <code className="mono text-[10px] text-text">workspace/</code>).
        Its workspace has seven tabs: Overview, Knowledge Graph (build/refresh, node inspector, dispatch-from-node),
        Runs, Tasks (+ GitHub-issue sync), PRs & CI (<strong className="text-text">Open review</strong> → the
        full-screen Changes view), Verification (deterministic health score), Artifacts.
      </p>
      <p className="text-body text-muted">
        The bible is the living spec — edit sections in the Artifacts tab and recompile; never hand-edit compiled
        HTML. Loose <code className="mono text-[10px] text-text">.html</code> files in the project's{' '}
        <code className="mono text-[10px] text-text">artifacts/</code> folder appear in the gallery via Refresh from
        disk.
      </p>
    </div>
  )
}
