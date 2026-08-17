import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  fallback?: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null })
  }

  handleReload = () => {
    window.location.reload()
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback

      return (
        <div style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
          background: 'var(--bg-0)',
          color: 'var(--text-1)',
          fontFamily: 'var(--font-sans)',
        }}>
          <div style={{
            maxWidth: 480,
            textAlign: 'center',
            background: 'var(--bg-1)',
            border: '1px solid var(--line-1)',
            borderRadius: 'var(--radius)',
            padding: 40,
          }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>⚠️</div>
            <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>Something went wrong</h2>
            <p style={{ color: 'var(--text-2)', fontSize: 14, marginBottom: 8, lineHeight: 1.5 }}>
              An unexpected error occurred. Your work has not been lost.
            </p>
            {this.state.error && (
              <details style={{
                marginBottom: 20,
                textAlign: 'left',
                background: 'var(--bg-0)',
                border: '1px solid var(--line-1)',
                borderRadius: 'var(--radius-sm)',
                padding: 12,
              }}>
                <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--text-3)' }}>
                  Error details
                </summary>
                <pre style={{
                  marginTop: 8,
                  fontSize: 11,
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--crit)',
                  whiteSpace: 'pre-wrap',
                  overflow: 'auto',
                  maxHeight: 200,
                }}>
                  {this.state.error.message}
                  {'\n\n'}
                  {this.state.error.stack}
                </pre>
              </details>
            )}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
              <button className="btn btn-ghost" onClick={this.handleReset}>
                Try again
              </button>
              <button className="btn btn-primary" onClick={this.handleReload}>
                Reload page
              </button>
            </div>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
