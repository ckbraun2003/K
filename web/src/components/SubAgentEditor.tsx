import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { AvailableModelsResponse } from '@k/shared'
import { api } from '../lib/api'
import { Dialog } from '../ui/Dialog'
import { Button } from '../ui/Button'
import { Input, Textarea, Select, Checkbox } from '../ui/Field'
import { Tag } from '../ui/Tag'
import CapabilityPicker from './CapabilityPicker'

/**
 * The sub-agent worker-bee editor (Task B.5) — used for BOTH an operator's full edit of an
 * existing `source:'operator'` row (PATCH) and the "Fork to edit" flow off a read-only K-native
 * row (POST with cloneFrom). The caller owns which mutation `onSave` triggers; this component
 * only collects the form. Seeded ONCE from `initial` (SkillDraftEditor's pattern) — the caller
 * keys this component on the target id so switching targets (a different card's Edit/Fork) remounts
 * a fresh editor rather than bleeding stale field state across targets.
 */
export interface SubAgentFormValues {
  name: string
  role: string
  model: string | null
  allowedTools: string[]
  mcpServers: string[]
  skills: string[]
  prompt: string
  enabled: boolean
}

function ChipListField({
  label,
  values,
  onChange,
  placeholder,
  testidPrefix,
}: {
  label: string
  values: string[]
  onChange: (next: string[]) => void
  placeholder: string
  testidPrefix: string
}) {
  const [draft, setDraft] = useState('')
  const add = () => {
    const v = draft.trim()
    if (v && !values.includes(v)) onChange([...values, v])
    setDraft('')
  }
  return (
    <div>
      <label className="mb-1 block text-xs text-muted">{label}</label>
      <div className="mb-1.5 flex flex-wrap gap-1.5" data-testid={`${testidPrefix}-chips`}>
        {values.length === 0 && <span className="text-[11px] italic text-muted">none</span>}
        {values.map(v => (
          <Tag key={v} onDismiss={() => onChange(values.filter(x => x !== v))}>
            {v}
          </Tag>
        ))}
      </div>
      <form className="flex gap-2" onSubmit={e => { e.preventDefault(); add() }}>
        <Input
          value={draft}
          onChange={e => setDraft(e.target.value)}
          placeholder={placeholder}
          data-testid={`${testidPrefix}-input`}
          className="flex-1 text-xs"
        />
        <Button
          type="submit"
          variant="ghost"
          size="sm"
          disabled={draft.trim() === ''}
          data-testid={`${testidPrefix}-add`}
        >
          add
        </Button>
      </form>
    </div>
  )
}

export default function SubAgentEditor({
  open,
  title,
  initial,
  busy,
  error,
  saveLabel = 'Save',
  onSave,
  onCancel,
}: {
  open: boolean
  title: string
  initial: SubAgentFormValues
  busy?: boolean
  error?: string | null
  saveLabel?: string
  onSave: (values: SubAgentFormValues) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(initial.name)
  const [role, setRole] = useState(initial.role)
  const [model, setModel] = useState(initial.model ?? '')
  const [allowedTools, setAllowedTools] = useState(initial.allowedTools)
  const [mcpServers, setMcpServers] = useState(initial.mcpServers)
  const [skills, setSkills] = useState(initial.skills)
  const [prompt, setPrompt] = useState(initial.prompt)
  const [enabled, setEnabled] = useState(initial.enabled)

  // Unified Claude+local model aggregate (usability-access C.5) — replaces the
  // static KNOWN_MODELS-only option list, same as the orchestrator page (C.4).
  const { data: modelsResp } = useQuery<AvailableModelsResponse>({
    queryKey: ['models-available'],
    queryFn: api.models.available,
  })

  const nameValid = name.trim() !== ''
  const roleValid = role.trim() !== ''
  const promptValid = prompt.trim() !== ''
  const canSave = nameValid && roleValid && promptValid && !busy

  const save = () => {
    if (!canSave) return
    onSave({
      name: name.trim(),
      role: role.trim(),
      model: model === '' ? null : model,
      allowedTools,
      mcpServers,
      skills,
      prompt,
      enabled,
    })
  }

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onCancel() }} title={title}>
      <div data-testid="sub-agent-editor" className="max-h-[70vh] space-y-3 overflow-y-auto pr-1">
        <div>
          <label htmlFor="sub-agent-editor-name" className="mb-1 block text-xs text-muted">Name</label>
          <Input
            id="sub-agent-editor-name"
            data-testid="sub-agent-editor-name"
            value={name}
            invalid={!nameValid}
            onChange={e => setName(e.target.value)}
            placeholder="worker-name"
            className="w-full text-sm"
          />
        </div>
        <div>
          <label htmlFor="sub-agent-editor-role" className="mb-1 block text-xs text-muted">Role</label>
          <Input
            id="sub-agent-editor-role"
            data-testid="sub-agent-editor-role"
            value={role}
            invalid={!roleValid}
            onChange={e => setRole(e.target.value)}
            placeholder="one-line goal / responsibility"
            className="w-full text-sm"
          />
        </div>
        <div>
          <label htmlFor="sub-agent-editor-model" className="mb-1 block text-xs text-muted">Model</label>
          <Select
            id="sub-agent-editor-model"
            data-testid="sub-agent-editor-model"
            value={model}
            onChange={e => setModel(e.target.value)}
            className="w-full text-sm"
          >
            <option value="">(runtime default)</option>
            {(modelsResp?.models ?? []).map(m => (
              <option key={m.id} value={m.id}>
                {m.label}{m.kind === 'local' ? ' (local)' : ''}
              </option>
            ))}
          </Select>
        </div>

        <ChipListField
          label="Tools"
          values={allowedTools}
          onChange={setAllowedTools}
          placeholder="add tool by name"
          testidPrefix="sub-agent-editor-tools"
        />
        {/* Skills / MCP — catalog-backed mount editors (C.5), same component the
            orchestrator detail page uses (C3): mounted rows carry provenance +
            token cost, and the add box only offers real catalog entries. */}
        <CapabilityPicker
          kind="skills"
          profile={{ skills, mcpServers }}
          onChange={setSkills}
          busy={!!busy}
          testidPrefix="sub-agent-editor-skills"
          title="Skills"
        />
        <CapabilityPicker
          kind="mcp"
          profile={{ skills, mcpServers }}
          onChange={setMcpServers}
          busy={!!busy}
          testidPrefix="sub-agent-editor-mcp"
          title="MCP servers"
        />

        <div>
          <label htmlFor="sub-agent-editor-prompt" className="mb-1 block text-xs text-muted">
            Prompt (system prompt / charter body)
          </label>
          <Textarea
            id="sub-agent-editor-prompt"
            data-testid="sub-agent-editor-prompt"
            value={prompt}
            invalid={!promptValid}
            onChange={e => setPrompt(e.target.value)}
            className="w-full min-h-32 text-xs"
          />
        </div>

        <label className="flex cursor-pointer items-center gap-2 text-xs text-text">
          <Checkbox
            checked={enabled}
            onChange={e => setEnabled(e.target.checked)}
            data-testid="sub-agent-editor-enabled"
          />
          enabled
        </label>

        {error && (
          <p data-testid="sub-agent-editor-error" className="text-caption text-red">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" size="sm" onClick={onCancel} data-testid="sub-agent-editor-cancel">
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={save}
            disabled={!canSave}
            loading={busy}
            data-testid="sub-agent-editor-save"
          >
            {saveLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
