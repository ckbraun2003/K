import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * Error boundary for the WebGL/Three (`ForceGraph3D`) render surfaces.
 *
 * ForceGraph3D builds a WebGL context on MOUNT; if context creation fails
 * (headless / GPU-disabled / context-limit reached) it throws during render.
 * Because Shell statically imports the graph pages, that throw would otherwise
 * blank the entire route — the same failure shape as the old AFRAME blank-screen
 * bug. This boundary catches the throw and renders a glass-styled fallback in the
 * same area, keeping the rest of the route alive. Error boundaries MUST be class
 * components (no hooks equivalent).
 */
interface Props {
  children: ReactNode
  fallback?: ReactNode
  className?: string
}

interface State {
  hasError: boolean
}

export class GraphErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('GraphErrorBoundary caught a graph render error:', error, info)
  }

  private reset = () => this.setState({ hasError: false })

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children
    if (this.props.fallback) return this.props.fallback
    return (
      <div
        className={
          this.props.className ??
          'flex h-full flex-col items-center justify-center gap-2 text-sm text-[var(--muted)]'
        }
      >
        <span>Graph failed to render.</span>
        <span className="text-[11px] text-[var(--muted)]">Try reloading the page.</span>
        <button
          onClick={this.reset}
          className="mt-1 rounded-lg border border-[var(--border)] bg-[var(--raised)] px-2.5 py-1 text-xs text-[var(--text)] transition-colors hover:border-[var(--accent)]"
        >
          Retry
        </button>
      </div>
    )
  }
}

export default GraphErrorBoundary
