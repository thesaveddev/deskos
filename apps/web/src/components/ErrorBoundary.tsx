import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  fallback?: ReactNode
  /** When true, chunk-load errors auto-reload the page instead of showing UI. */
  autoReloadOnChunkError?: boolean
}

interface State {
  hasError: boolean
  error: Error | null
}

/** Detect chunk-load errors from React.lazy / dynamic import. */
function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return (
    msg.includes('loading chunk') ||
    msg.includes('loading module') ||
    msg.includes('dynamically imported module') ||
    msg.includes('failed to fetch dynamically imported module') ||
    error.name === 'ChunkLoadError' ||
    error.name === 'ChunkLoadError'
  );
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null }
  private retryCount = 0
  private static MAX_RETRIES = 2

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack)

    // Auto-reload on chunk load errors (stale bundles after deploy).
    // This prevents the user from seeing the scary error screen when the
    // only problem is that the old code chunk no longer exists on the server.
    if (this.props.autoReloadOnChunkError && isChunkLoadError(error)) {
      if (this.retryCount < ErrorBoundary.MAX_RETRIES) {
        this.retryCount++
        console.warn(
          `[ErrorBoundary] Chunk load error detected (attempt ${this.retryCount}/${ErrorBoundary.MAX_RETRIES}). Reloading page...`,
        )
        // Small delay so the network can catch up after a deploy
        setTimeout(() => window.location.reload(), 500 * this.retryCount)
      } else {
        console.error(
          '[ErrorBoundary] Chunk load error persisted after max retries. Showing error UI.',
        )
      }
    }
  }

  handleReset = () => {
    this.retryCount = 0
    this.setState({ hasError: false, error: null })
  }

  handleReload = () => {
    window.location.reload()
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback

      const isChunk = isChunkLoadError(this.state.error)

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
            <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>
              {isChunk ? 'App update available' : 'Something went wrong'}
            </h2>
            <p style={{ color: 'var(--text-2)', fontSize: 14, marginBottom: 8, lineHeight: 1.5 }}>
              {isChunk
                ? 'The application has been updated since this page was loaded. Reload to get the latest version.'
                : 'An unexpected error occurred. Your work has not been lost.'}
            </p>
            {this.state.error && !isChunk && (
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
                {isChunk ? 'Dismiss' : 'Try again'}
              </button>
              <button className="btn btn-primary" onClick={this.handleReload}>
                {isChunk ? 'Reload now' : 'Reload page'}
              </button>
            </div>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
