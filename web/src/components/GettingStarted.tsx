import { useState } from 'react'
import { motion } from 'framer-motion'
import type { Project } from '@k/shared'
import { navigate } from '../lib/route'
import { staggerContainer, staggerItem, microLift } from '../lib/motion'

const DISMISS_KEY = 'k:getting-started-dismissed'

interface Step {
  n: number
  title: string
  body: string
  cta: string
  done: boolean
  action: () => void
}

/**
 * First-run onboarding card — guides a brand-new user through the three steps
 * that get the harness usable: register a project, build its knowledge graph,
 * then verify / dispatch a run. Only step 1 reflects live progress (its
 * checkmark lights up once `hasProject` is true); steps 2–3 are static guidance
 * and never toggle their done state. Each step's CTA either triggers the flow or
 * navigates to where it lives.
 *
 * Rendered on Home. When `forceOpen` (e.g. the projects empty state) it ignores
 * the persisted dismissal so the guidance always shows while there's nothing set
 * up yet. Otherwise it's a dismissible first-run panel.
 */
export default function GettingStarted({
  projects,
  forceOpen = false,
  onRegister,
}: {
  projects: Project[]
  forceOpen?: boolean
  onRegister: () => void
}) {
  const [dismissed, setDismissed] = useState(
    () => !forceOpen && localStorage.getItem(DISMISS_KEY) === '1',
  )

  const hasProject = projects.length > 0
  const firstId = projects[0]?.id

  // Once the user has projects AND chose to dismiss, stay out of the way.
  if (dismissed) return null

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, '1')
    setDismissed(true)
  }

  const steps: Step[] = [
    {
      n: 1,
      title: 'Register a project',
      body: 'Point K at a local repo or paste a GitHub URL to clone it in.',
      cta: hasProject ? 'Add another' : 'Register project',
      done: hasProject,
      action: onRegister,
    },
    {
      n: 2,
      title: 'Build its knowledge graph',
      body: 'Index symbols & relationships so agents can navigate the code.',
      cta: 'Open knowledge graph',
      done: false,
      action: () => {
        if (firstId) navigate('project', firstId, 'knowledge-graph')
        else onRegister()
      },
    },
    {
      n: 3,
      title: 'Verify & dispatch a run',
      body: 'Score project health, then dispatch an agent — or press ⌘K anywhere.',
      cta: 'Open workspace',
      done: false,
      action: () => {
        if (firstId) navigate('project', firstId, 'overview')
        else onRegister()
      },
    },
  ]

  return (
    <motion.section
      key="getting-started"
      variants={staggerContainer}
      initial="hidden"
      animate="visible"
      className="glass relative mt-3 overflow-hidden rounded-xl p-5"
      aria-label="Getting started"
    >
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-sm font-semibold text-[var(--text)]">Getting started</h2>
            <p className="mt-0.5 text-xs text-[var(--muted)]">
              Three steps to a working harness.
            </p>
          </div>
          {!forceOpen && (
            <button
              onClick={dismiss}
              className="-mr-1 -mt-1 rounded p-1 text-[var(--muted)] transition-colors hover:text-[var(--text)]"
              aria-label="Dismiss getting started"
            >
              ✕
            </button>
          )}
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-3">
          {steps.map(step => (
            <motion.div
              key={step.n}
              variants={staggerItem}
              className="flex flex-col rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4"
            >
              <div className="flex items-center gap-2">
                <span
                  className={
                    step.done
                      ? 'flex h-5 w-5 items-center justify-center rounded-full bg-[var(--green)] text-[10px] font-bold text-[var(--bg)]'
                      : 'flex h-5 w-5 items-center justify-center rounded-full border border-[var(--border)] text-[10px] font-semibold text-[var(--muted)]'
                  }
                >
                  {step.done ? '✓' : step.n}
                </span>
                <span className="text-xs font-semibold text-[var(--text)]">{step.title}</span>
              </div>
              <p className="mt-2 flex-1 text-[11px] leading-snug text-[var(--muted)]">{step.body}</p>
              <motion.button
                {...microLift}
                onClick={step.action}
                className={
                  step.n === 1 && !step.done
                    ? 'mt-3 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-[11px] font-semibold text-[var(--bg)] transition-opacity hover:opacity-90'
                    : 'mt-3 rounded-lg border border-[var(--border)] bg-[var(--raised)] px-3 py-1.5 text-[11px] font-semibold text-[var(--text)] transition-colors hover:border-[var(--accent)]'
                }
              >
                {step.cta} →
              </motion.button>
            </motion.div>
          ))}
        </div>
    </motion.section>
  )
}
