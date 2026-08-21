import { useCallback, useEffect, useState } from 'react'
import { Shell } from '../components/Shell.js'
import { Alert, PageHeader, Panel } from '../components/ui.js'
import { getDeveloperOverview, type DeveloperOverview } from '../lib/developer.js'

export default function DeveloperPage() {
  const [overview, setOverview] = useState<DeveloperOverview | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setOverview(await getDeveloperOverview())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load the developer overview')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <Shell>
      <PageHeader
        title="Developer API"
        subtitle="Integrate with ReyDesk over OAuth2. Machine-to-machine uses client credentials; user-delegated access uses authorization code + PKCE. Register clients under Settings → Public API."
        actions={<a className="btn btn-primary btn-sm" href={overview?.specUrl ?? '#'} target="_blank" rel="noreferrer">Open OpenAPI 3.1 spec</a>}
      />

      {error ? <Alert kind="error">{error}</Alert> : null}

      {overview === null ? (
        <span className="etch">Loading developer overview…</span>
      ) : (
        <>
          <Panel title="Endpoints">
            <ul className="channel-list">
              <li className="channel-card">
                <div className="channel-main">
                  <span className="channel-name mono">{overview.auth.tokenUrl}</span>
                  <span className="channel-meta">OAuth2 token endpoint (client credentials / authorization code)</span>
                </div>
              </li>
              <li className="channel-card">
                <div className="channel-main">
                  <span className="channel-name mono">{overview.auth.authorizeUrl}</span>
                  <span className="channel-meta">OAuth2 authorization-code step 1 (authenticated user)</span>
                </div>
              </li>
              {overview.endpoints.map((e) => (
                <li key={e.path} className="channel-card">
                  <div className="channel-main">
                    <span className="channel-name mono">{e.method} {e.path}</span>
                    <span className="channel-meta">scope <code>{e.scope}</code> — {e.description}</span>
                  </div>
                </li>
              ))}
            </ul>
          </Panel>

          <div style={{ height: 16 }} />

          <Panel title="Scopes" subtitle={`Grant types: ${overview.auth.grantTypes.join(', ')}`}>
            <ul className="channel-list">
              {overview.scopes.map((s) => (
                <li key={s.scope} className="channel-card">
                  <div className="channel-main">
                    <span className="channel-name mono">{s.scope}</span>
                    <span className="channel-meta mono">→ {s.permission}</span>
                    <span className="channel-meta">{s.description}</span>
                  </div>
                </li>
              ))}
            </ul>
          </Panel>
        </>
      )}
    </Shell>
  )
}
