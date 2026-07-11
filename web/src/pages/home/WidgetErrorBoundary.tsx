import { Component, type ErrorInfo, type ReactNode } from 'react'
import type { HomeWidgetId } from '@k/shared'

/**
 * Per-cell error boundary (UI Simplification Task 12) — wraps a widget's
 * customize chrome (WidgetShell) AND its body together (OverviewView), so a
 * throwing widget degrades to an inline error card WITHOUT taking the rest of
 * the 3x3 grid down. One boundary per cell = one crashing widget stays
 * isolated; every sibling cell keeps its own boundary and renders normally.
 * Class component: error boundaries have no hooks equivalent (React docs).
 * Mirrors GraphErrorBoundary's shape (components/GraphErrorBoundary.tsx).
 */
interface Props {
  id: HomeWidgetId
  children: ReactNode
}

interface State {
  hasError: boolean
}

export default class WidgetErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`WidgetErrorBoundary(${this.props.id}) caught a widget render error:`, error, info)
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div data-testid={`widget-error-${this.props.id}`} className="p-3 text-xs text-[var(--red)]">
          This widget hit an error. The rest of Home is fine.
        </div>
      )
    }
    return this.props.children
  }
}
