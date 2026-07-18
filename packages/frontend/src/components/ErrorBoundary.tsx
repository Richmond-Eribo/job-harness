import { Component, type ReactNode } from "react"

// Top-level error boundary. Wraps the router so an uncaught render error
// shows a recoverable message instead of blanking the whole app. Class
// component because React's error-boundary API is still class-only.
type Props = { children: ReactNode }
type State = { error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Surfaced to wrangler tail / observability via the Worker's console.
    console.error("[app] uncaught render error:", error, info)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen bg-background text-foreground flex items-center justify-center p-6">
          <div className="max-w-md text-center">
            <h1 className="text-xl font-bold mb-2">Something went wrong</h1>
            <p className="text-sm text-muted-foreground mb-6">
              An unexpected error occurred while rendering this page.
            </p>
            <pre className="text-xs text-left bg-secondary/50 border border-border rounded-md p-3 mb-6 overflow-auto max-h-40">
              {this.state.error.message}
            </pre>
            <button
              onClick={() => this.setState({ error: null })}
              className="inline-flex items-center justify-center rounded-md bg-primary text-primary-foreground hover:bg-primary/90 px-4 py-2 text-sm font-medium transition-colors"
            >
              Try again
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
