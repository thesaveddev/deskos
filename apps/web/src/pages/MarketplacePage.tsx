import { useEffect, useState } from 'react'
import { useAuth } from '../lib/auth.js'
import {
  listApps,
  listInstalls,
  installApp,
  uninstallApp,
  toggleInstall,
  createApp,
  deleteApp,
  type AppRegistryEntry,
  type AppInstall,
} from '../lib/marketplace.js'
import { PageHeader, Panel, Modal, useConfirm } from '../components/ui.js'

export default function MarketplacePage() {
  const perms = new Set(useAuth((s) => s.memberships).flatMap((m: any) => m.permissions))
  const canManage = perms.has('marketplace.manage')
  const confirm = useConfirm()

  const [apps, setApps] = useState<AppRegistryEntry[]>([])
  const [installs, setInstalls] = useState<AppInstall[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'browse' | 'installed'>('browse')
  const [search, setSearch] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [newApp, setNewApp] = useState({ name: '', slug: '', description: '', developer: '', version: '1.0.0' })
  const [creating, setCreating] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const refresh = async () => {
    setLoading(true)
    try {
      const [a, i] = await Promise.all([listApps(), listInstalls()])
      setApps(a)
      setInstalls(i)
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void refresh() }, [])

  const installedIds = new Set(installs.map((i) => i.app_id))

  const filtered = apps.filter((a) =>
    !search || a.name.toLowerCase().includes(search.toLowerCase()) ||
    a.developer.toLowerCase().includes(search.toLowerCase())
  )

  const handleInstall = async (appId: string) => {
    setBusyId(appId)
    try {
      await installApp(appId)
      await refresh()
    } catch (e) {
      console.error(e)
    } finally {
      setBusyId(null)
    }
  }

  const handleUninstall = async (appId: string) => {
    setBusyId(appId)
    try {
      await uninstallApp(appId)
      await refresh()
    } catch (e) {
      console.error(e)
    } finally {
      setBusyId(null)
    }
  }

  const handleToggle = async (appId: string, enabled: boolean) => {
    setBusyId(appId)
    try {
      await toggleInstall(appId, enabled)
      await refresh()
    } catch (e) {
      console.error(e)
    } finally {
      setBusyId(null)
    }
  }

  const handleCreate = async () => {
    if (!newApp.name || !newApp.slug) return
    setCreating(true)
    try {
      await createApp(newApp)
      setShowCreate(false)
      setNewApp({ name: '', slug: '', description: '', developer: '', version: '1.0.0' })
      await refresh()
    } catch (e) {
      console.error(e)
    } finally {
      setCreating(false)
    }
  }

  const handleDelete = async (slug: string) => {
    if (!await confirm(`Delete “${slug}”? This cannot be undone.`, { title: 'Delete marketplace app', confirmLabel: 'Delete app', destructive: true })) return
    try {
      await deleteApp(slug)
      await refresh()
    } catch (e) {
      console.error(e)
    }
  }

  const installed = installs.map((i) => ({
    ...i,
    app: apps.find((a) => a.id === i.app_id),
  }))

  return (
    <div>
      <PageHeader
        title="Marketplace"
        subtitle={`${apps.length} apps available · ${installs.length} installed`}
        actions={canManage ? <button className="btn btn-primary btn-sm" onClick={() => setShowCreate(true)}>Register app</button> : undefined}
      />

      <div className="tabs" style={{ marginBottom: 16 }}>
        <button className={`tab${tab === 'browse' ? ' active' : ''}`} onClick={() => setTab('browse')}>
          Browse ({apps.length})
        </button>
        <button className={`tab${tab === 'installed' ? ' active' : ''}`} onClick={() => setTab('installed')}>
          Installed ({installs.length})
        </button>
      </div>

      {tab === 'browse' && (
        <Panel
          title="Available apps"
          subtitle={`${filtered.length} apps`}
          toolbar={
            <div className="toolbar">
              <input
                className="field-input"
                placeholder="Search apps…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <div className="toolbar-spacer" />
            </div>
          }
        >
          {loading ? (
            <div className="panel-empty">Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="panel-empty">No apps found.</div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12, padding: 16 }}>
              {filtered.map((app) => (
                <div key={app.id} className="detail-card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div>
                      <strong style={{ fontSize: 15 }}>{app.name}</strong>
                      <span className="mono muted" style={{ marginLeft: 8 }}>v{app.version}</span>
                    </div>
                    {canManage && (
                      <button
                        className="btn btn-ghost btn-sm"
                        style={{ fontSize: 11, color: 'var(--crit)' }}
                        onClick={() => handleDelete(app.slug)}
                      >
                        Delete
                      </button>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-3)' }}>by {app.developer || 'Unknown'}</div>
                  <p style={{ margin: 0, fontSize: 13, color: 'var(--text-2)', lineHeight: 1.5 }}>
                    {app.description || 'No description.'}
                  </p>
                  {app.capabilities && app.capabilities.length > 0 && (
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {(app.capabilities as string[]).map((cap) => (
                        <span key={cap} className="mono" style={{ fontSize: 10, padding: '2px 6px', background: 'var(--bg-0)', border: '1px solid var(--line-2)', borderRadius: 4, color: 'var(--text-3)' }}>
                          {cap}
                        </span>
                      ))}
                    </div>
                  )}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 'auto' }}>
                    <span className="muted" style={{ fontSize: 12 }}>{app.install_count} install{app.install_count !== 1 ? 's' : ''}</span>
                    {installedIds.has(app.id) ? (
                      <button
                        className="btn btn-ghost btn-sm"
                        disabled={busyId === app.id}
                        onClick={() => handleUninstall(app.id)}
                      >
                        {busyId === app.id ? '…' : 'Uninstall'}
                      </button>
                    ) : (
                      <button
                        className="btn btn-primary btn-sm"
                        disabled={busyId === app.id || !canManage}
                        onClick={() => handleInstall(app.id)}
                      >
                        {busyId === app.id ? '…' : 'Install'}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>
      )}

      {tab === 'installed' && (
        <Panel
          title="Installed apps"
          subtitle={`${installed.length} installed`}
        >
          {loading ? (
            <div className="panel-empty">Loading…</div>
          ) : installed.length === 0 ? (
            <div className="panel-empty">No apps installed yet. Browse the catalog to install one.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {installed.map((item) => (
                <div key={item.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '12px 16px', borderBottom: '1px solid var(--line-1)' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <strong style={{ fontSize: 14 }}>{item.app_name ?? item.app?.name ?? 'Unknown'}</strong>
                      <span className="mono muted" style={{ fontSize: 11 }}>v{item.app_version ?? item.app?.version}</span>
                      <span className={`status-pill ${item.enabled ? 'status-online' : 'status-offline'}`}>
                        {item.enabled ? 'enabled' : 'disabled'}
                      </span>
                    </div>
                    <span className="muted" style={{ fontSize: 12 }}>
                      Installed {new Date(item.installed_at).toLocaleDateString()}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    {canManage && (
                      <button
                        className="btn btn-ghost btn-sm"
                        disabled={busyId === item.app_id}
                        onClick={() => handleToggle(item.app_id, !item.enabled)}
                      >
                        {item.enabled ? 'Disable' : 'Enable'}
                      </button>
                    )}
                    {canManage && (
                      <button
                        className="btn btn-ghost btn-sm"
                        disabled={busyId === item.app_id}
                        onClick={() => handleUninstall(item.app_id)}
                        style={{ color: 'var(--crit)' }}
                      >
                        Uninstall
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>
      )}

      {showCreate && (
        <Modal open={showCreate} onClose={() => setShowCreate(false)} title="Register app">

          <div className="modal-body">
            <div className="field">
              <label className="field-label">App name *</label>
              <input className="field-input" value={newApp.name} onChange={(e) => setNewApp({ ...newApp, name: e.target.value })} placeholder="My integration" />
            </div>
            <div className="field">
              <label className="field-label">Slug * (lowercase, hyphens)</label>
              <input className="field-input" value={newApp.slug} onChange={(e) => setNewApp({ ...newApp, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })} placeholder="my-integration" />
            </div>
            <div className="field">
              <label className="field-label">Description</label>
              <input className="field-input" value={newApp.description} onChange={(e) => setNewApp({ ...newApp, description: e.target.value })} placeholder="What does this app do?" />
            </div>
            <div className="form-row">
              <div className="field">
                <label className="field-label">Developer</label>
                <input className="field-input" value={newApp.developer} onChange={(e) => setNewApp({ ...newApp, developer: e.target.value })} placeholder="Your name or org" />
              </div>
              <div className="field">
                <label className="field-label">Version</label>
                <input className="field-input" value={newApp.version} onChange={(e) => setNewApp({ ...newApp, version: e.target.value })} placeholder="1.0.0" />
              </div>
            </div>
          </div>
          <div className="modal-foot">
            <button className="btn btn-ghost" onClick={() => setShowCreate(false)}>Cancel</button>
            <button className="btn btn-primary" disabled={creating || !newApp.name || !newApp.slug} onClick={handleCreate}>
              {creating ? 'Creating…' : 'Create'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}
