import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import LandingLayout from '../components/LandingLayout'

interface OpenApiSpec {
  openapi: string
  info: { title: string; version: string; description: string }
  servers: { url: string; description: string }[]
  paths: Record<string, Record<string, OpenApiMethod>>
  components?: { securitySchemes?: Record<string, unknown> }
  'x-reydesk-scopes'?: { scope: string; description: string }[]
}

interface OpenApiMethod {
  operationId: string
  summary: string
  description?: string
  security?: unknown[]
  requestBody?: {
    required?: boolean
    content?: Record<string, { schema?: unknown }>
  }
  responses: Record<string, { description: string; content?: Record<string, { schema?: unknown }> }>
}

const METHOD_COLORS: Record<string, string> = {
  get: 'var(--ok)',
  post: 'var(--info)',
  put: 'var(--accent)',
  patch: 'var(--warn)',
  delete: 'var(--crit)',
}

function SchemaBlock({ schema }: { schema: unknown }) {
  if (!schema || typeof schema !== 'object') return null
  const s = schema as Record<string, unknown>
  if (s.type === 'object' && s.properties) {
    const props = s.properties as Record<string, Record<string, unknown>>
    const required = (s.required as string[]) || []
    return (
      <div className="api-schema-table">
        {Object.entries(props).map(([key, val]) => (
          <div key={key} className="api-schema-row">
            <span className="api-schema-key mono">{key}</span>
            <span className="api-schema-type mono">{String(val.type || 'any')}</span>
            {required.includes(key) && <span className="api-schema-required">required</span>}
          </div>
        ))}
      </div>
    )
  }
  return <pre className="api-schema-pre">{JSON.stringify(schema, null, 2)}</pre>
}

function EndpointCard({ method, path, op }: { method: string; path: string; op: OpenApiMethod }) {
  const [expanded, setExpanded] = useState(false)
  const color = METHOD_COLORS[method] || 'var(--text-3)'

  return (
    <div className="api-endpoint">
      <button
        className="api-endpoint-header"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        <span className="api-method-badge" style={{ background: color, color: '#fff' }}>
          {method.toUpperCase()}
        </span>
        <span className="api-endpoint-path mono">{path}</span>
        <span className="api-endpoint-summary">{op.summary}</span>
        <span className="api-endpoint-expand">{expanded ? '−' : '+'}</span>
      </button>
      {expanded && (
        <div className="api-endpoint-detail">
          {op.description && <p className="api-endpoint-desc">{op.description}</p>}

          {op.requestBody && (
            <div className="api-endpoint-section">
              <h4>Request body</h4>
              {op.requestBody.required && <span className="api-schema-required" style={{ marginBottom: 8, display: 'inline-block' }}>required</span>}
              {op.requestBody.content && Object.entries(op.requestBody.content).map(([ct, ctVal]) => (
                <div key={ct}>
                  <span className="mono" style={{ fontSize: 12, color: 'var(--text-3)' }}>{ct}</span>
                  <SchemaBlock schema={ctVal.schema} />
                </div>
              ))}
            </div>
          )}

          <div className="api-endpoint-section">
            <h4>Responses</h4>
            <div className="api-responses">
              {Object.entries(op.responses).map(([code, resp]) => (
                <div key={code} className="api-response">
                  <span
                    className="api-response-code mono"
                    style={{ color: code.startsWith('2') ? 'var(--ok)' : code.startsWith('4') ? 'var(--warn)' : 'var(--crit)' }}
                  >
                    {code}
                  </span>
                  <span className="api-response-desc">{resp.description}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default function ApiDocsPage() {
  const [spec, setSpec] = useState<OpenApiSpec | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/v1/openapi.json')
      .then((r) => { if (!r.ok) throw new Error('Failed to load API spec'); return r.json() })
      .then(setSpec)
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load API spec'))
  }, [])

  return (
    <LandingLayout
      title="API Documentation — ReyDesk"
      description="ReyDesk API documentation. OAuth2-authenticated REST API with OpenAPI 3.1 specification. Integrate with your existing tools."
    >
      <section className="landing-hero">
        <div className="landing-hero-inner">
          <span className="landing-kicker">Developer API</span>
          <h1 className="landing-title">API Documentation</h1>
          <p className="landing-sub">
            OAuth2-authenticated REST API with OpenAPI 3.1 specification. Machine-to-machine via client credentials, or user-delegated access via authorization code + PKCE.
          </p>
          <div className="landing-cta">
            <a className="btn btn-primary" href="/api/v1/openapi.json" target="_blank" rel="noreferrer">
              Download OpenAPI spec (.json)
            </a>
            <Link className="btn btn-ghost" to="/login">Go to Developer Console →</Link>
          </div>
        </div>
      </section>

      <section className="landing-section" style={{ paddingTop: 0 }}>
        <div className="api-docs-container">
          {/* Quick start */}
          <div className="api-quickstart">
            <h2>Quick start</h2>
            <div className="api-quickstart-steps">
              <div className="api-quickstart-step">
                <span className="api-step-number">1</span>
                <div>
                  <h4>Register a client</h4>
                  <p>Go to Settings → Public API → Register Client. You'll get a <code>client_id</code> and <code>client_secret</code>.</p>
                </div>
              </div>
              <div className="api-quickstart-step">
                <span className="api-step-number">2</span>
                <div>
                  <h4>Get an access token</h4>
                  <pre className="api-code-block">
{`curl -X POST /api/v1/oauth/token \\
  -H "Content-Type: application/json" \\
  -d '{"grant_type":"client_credentials",
       "client_id":"YOUR_ID",
       "client_secret":"YOUR_SECRET"}'`}
                  </pre>
                </div>
              </div>
              <div className="api-quickstart-step">
                <span className="api-step-number">3</span>
                <div>
                  <h4>Call the API</h4>
                  <pre className="api-code-block">
{`curl /api/v1/public/tickets \\
  -H "Authorization: Bearer YOUR_TOKEN"`}
                  </pre>
                </div>
              </div>
            </div>
          </div>

          {/* Auth info */}
          <div className="api-auth-info">
            <h2>Authentication</h2>
            <p>All API requests require a Bearer token in the <code>Authorization</code> header.</p>
            <div className="api-auth-modes">
              <div className="api-auth-card">
                <h4>Client credentials</h4>
                <p>For machine-to-machine integrations. Exchange your client ID + secret for a token. No user interaction required.</p>
                <code className="mono">grant_type=client_credentials</code>
              </div>
              <div className="api-auth-card">
                <h4>Authorization code + PKCE</h4>
                <p>For user-delegated access. Redirect the user to authorize, they approve scopes, you exchange the code for a token.</p>
                <code className="mono">grant_type=authorization_code</code>
              </div>
            </div>
          </div>

          {/* Endpoints */}
          <div className="api-endpoints">
            <h2>Endpoints</h2>
            {error && <div className="alert alert-error">{error}</div>}
            {spec ? (
              <div className="api-endpoint-list">
                {Object.entries(spec.paths).flatMap(([path, methods]) =>
                  Object.entries(methods).map(([method, op]) => (
                    <EndpointCard key={`${method}-${path}`} method={method} path={path} op={op} />
                  ))
                )}
              </div>
            ) : !error ? (
              <span className="etch">Loading endpoints…</span>
            ) : null}
          </div>

          {/* Scopes */}
          {spec?.['x-reydesk-scopes'] && (
            <div className="api-scopes">
              <h2>Scopes</h2>
              <p>Request only the scopes your integration needs. Least-privilege is enforced.</p>
              <div className="api-scopes-grid">
                {(spec['x-reydesk-scopes'] ?? []).map((s) => (
                  <div key={s.scope} className="api-scope-card">
                    <code className="mono">{s.scope}</code>
                    <span>{s.description}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>
    </LandingLayout>
  )
}
