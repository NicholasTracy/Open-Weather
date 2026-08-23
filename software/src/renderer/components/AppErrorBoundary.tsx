import { Component, type ErrorInfo, type ReactNode } from 'react'

type Props = {
  children: ReactNode
}

type State = {
  error: Error | null
}

/** Prevents a renderer crash from leaving a fully blank window. */
export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Open Weather renderer crash', error, info.componentStack)
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children

    return (
      <div className="app-crash" role="alert">
        <h1>Something went wrong</h1>
        <p>The dashboard hit an unexpected error. Reload to continue.</p>
        <pre>{this.state.error.message}</pre>
        <button type="button" className="btn btn-ow-primary" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    )
  }
}
