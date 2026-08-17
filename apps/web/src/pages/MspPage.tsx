import { useCallback, useEffect, useState } from 'react'
import { Shell } from '../components/Shell.js'
import { Alert } from '../components/ui.js'
import { useAuth } from '../lib/auth.js'
import { mspConsole, updateBranding, type MspTenant } from '../lib/msp.js'

interface BrandingDraft {
  portalTitle: string
  logoUrl: string
  primaryColor: string
}

function draftOf(t: MspTenant): BrandingDraft {
  return {
    portalTitle: t.branding.portalTitle ?? '',
    logoUrl: t.branding.logoUrl ?? '',
    primaryColor: t.branding.primaryColor ?? '',
  }
}

export default function MspPage() {
  const auth = useAuth()
  const [tenants, setTenants] = useState<MspTenant[] | null>(null)
  const [drafts, setDrafts] = useState<Record<string, BrandingDraft>>({})
  const [saving, setSaving] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const data = await mspConsole()
      setTenants(data.tenants)
      setDrafts(Object.fromEntries(data.tenants.map((t) => [t.id, draftOf(t)])))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load MSP console')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const save = async (id: string) => {
    const draft = drafts[id]
    if (!draft || saving) return
    setSaving(id)
    setError(null)
    try {
      await updateBranding({
        portalTitle: draft.portalTitle || null,
        logoUrl: draft.logoUrl || null,
        primaryColor: draft.primaryColor || null,
      })
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save branding')
    } finally {
      setSaving(null)
    }
  }

  const setDraft = (id: string, patch: Partial<BrandingDraft>) => {
    setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }))
  }

  const canManage = (tenant: MspTenant) => tenant.orgRole === 'owner' || tenant.orgRole === 'it_manager'

  return (
    <Shell>
      <div className="page-head">
        <h1 className="page-title">MSP console</h1>
      </div>

      {error ? <Alert kind="error">{error}</Alert> : null}

      {tenants === null ? (
        <span className="etch">Loading customers…</span>
      ) : tenants.length === 0 ? (
        <div className="empty-state">
          <p>No staff memberships yet.</p>
        </div>
      ) : (
        <div className="kb-layout">
          {tenants.map((t) => (
            <section key={t.id} className="form-panel">
              <div className="channel-main" style={{ marginBottom: 12 }}>
                <span className="channel-name">
                  {t.name}
                  {t.branding.primaryColor ? (
                    <span
                      className="msp-swatch"
                      aria-hidden="true"
                      style={{ background: t.branding.primaryColor, display: 'inline-block', width: 12, height: 12, borderRadius: '50%', marginLeft: 8, verticalAlign: 'middle' }}
                    />
                  ) : null}
                </span>
                <span className="channel-meta mono">
                  /{t.slug} · {t.region} · {t.orgRole.replace('_', ' ')}
                </span>
              </div>

              <div className="stat-row">
                <div className="stat-card">
                  <span className="stat-value">{t.stats.openTickets}</span>
                  <span className="stat-label">Open tickets</span>
                </div>
                <div className="stat-card">
                  <span className="stat-value">{t.stats.deviceCount}</span>
                  <span className="stat-label">Devices</span>
                </div>
                <div className="stat-card">
                  <span className="stat-value">{t.stats.activeSessions}</span>
                  <span className="stat-label">Active sessions</span>
                </div>
              </div>

              {canManage(t) ? (
                <div>
                  <h3 className="channel-title">Branding</h3>
                  <div className="form-row">
                    <input
                      className="field-input"
                      placeholder="Portal title"
                      value={drafts[t.id]?.portalTitle ?? ''}
                      onChange={(e) => setDraft(t.id, { portalTitle: e.target.value })}
                    />
                    <input
                      className="field-input mono"
                      type="color"
                      value={/^#[0-9a-fA-F]{6}$/.test(drafts[t.id]?.primaryColor ?? '') ? drafts[t.id].primaryColor : '#3b82f6'}
                      onChange={(e) => setDraft(t.id, { primaryColor: e.target.value })}
                      aria-label="Primary color"
                    />
                  </div>
                  <div className="form-row">
                    <input
                      className="field-input mono"
                      placeholder="Logo URL (https://…)"
                      value={drafts[t.id]?.logoUrl ?? ''}
                      onChange={(e) => setDraft(t.id, { logoUrl: e.target.value })}
                    />
                  </div>
                  <div className="form-actions">
                    <button type="button" className="btn btn-primary btn-sm" disabled={saving === t.id} onClick={() => void save(t.id)}>
                      {saving === t.id ? 'Saving…' : 'Save branding'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => {
                        auth.switchTenant(t.id)
                        window.location.reload()
                      }}
                    >
                      Switch to {t.name}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="form-actions">
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => {
                      auth.switchTenant(t.id)
                      window.location.reload()
                    }}
                  >
                    Switch to {t.name}
                  </button>
                </div>
              )}
            </section>
          ))}
        </div>
      )}
    </Shell>
  )
}
