// web/src/help/pages/SettingsShortcuts.tsx — help guide page 7/7 (FE-6)
const SHORTCUTS: { keys: string; desc: string }[] = [
  { keys: '⌘K', desc: 'Message K' },
  { keys: 'g then a letter', desc: 'Jump to a section (? lists them)' },
  { keys: 'j / k', desc: 'Next/prev file in Changes' },
  { keys: 'f', desc: 'Fit a graph' },
  { keys: 'Esc', desc: 'Close dialogs and overlays' },
  { keys: '?', desc: 'Toggle the shortcut legend' },
]

export function SettingsShortcuts() {
  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-title text-text">Settings & shortcuts</h2>
      <p className="text-body text-muted">
        Settings holds provider status (Claude/Ollama/GitHub/auth), default + local models, voice push-to-talk, the
        Autonomous Org master switch and behaviors, notification rules, the guarded global system prompt, host
        diagnostics and the guarded terminal.
      </p>
      <ul className="flex flex-col gap-2">
        {SHORTCUTS.map((s) => (
          <li key={s.keys} className="flex items-center justify-between gap-4 text-body text-muted">
            <span>{s.desc}</span>
            <kbd className="mono rounded bg-raised px-1.5 py-0.5 text-[10px] text-text">{s.keys}</kbd>
          </li>
        ))}
      </ul>
    </div>
  )
}
