import { useCallback, useEffect, useState } from 'react'
import { Shell } from '../components/Shell.js'
import { Alert } from '../components/ui.js'
import { useAuth } from '../lib/auth.js'
import { fleetDex, type FleetDex } from '../lib/dex.js'
import {
  createPolicy,
  deletePolicy,
  getDeviceInventory,
  listDeviceActions,
  listPolicies,
  queueDeviceActions,
  type DeviceActionKind,
  type DeviceInventory,
  type EndpointPolicy,
} from '../lib/rmm.js'

const ACTION_KINDS: DeviceActionKind[] = ['restart', 'run_script', 'collect_inventory']

export default function RmmPage() {
  const auth = useAuth()
  const perms = new Set(auth.memberships.flatMap((m) => m.permissions))
  const canManage = perms.has('rmm.manage')

  const [policies, setPolicies] = useState<EndpointPolicy[] | null>(null)
  const [actions, setActions] = useState<Awaited<ReturnType<typeof listDeviceActions>>['actions'] | null>(null)
  const [policyName, setPolicyName] = useState('')
  const [policyGroup, setPolicyGroup] = useState('')
  const [actionKind, setActionKind] = useState<DeviceActionKind>('collect_inventory')
  const [targetDeviceIds, setTargetDeviceIds] = useState('')
  const [inventoryDeviceId, setInventoryDeviceId] = useState('')
  const [inventory, setInventory] = useState<DeviceInventory | null>(null)
  const [dex, setDex] = useState<FleetDex | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setPolicies((await listPolicies()).policies)
      setActions((await listDeviceActions()).actions)
      setDex(await fleetDex())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load endpoint data')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const addPolicy = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await createPolicy({ name: policyName, groupId: policyGroup || null })
      setPolicyName('')
      setPolicyGroup('')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create policy')
    } finally {
      setBusy(false)
    }
  }

  const removePolicy = async (id: string) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await deletePolicy(id)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete policy')
    } finally {
      setBusy(false)
    }
  }

  const queue = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const deviceIds = targetDeviceIds.split(',').map((s) => s.trim()).filter(Boolean)
      const result = await queueDeviceActions({ action: actionKind, deviceIds: deviceIds.length ? deviceIds : undefined })
      setNotice(`${result.created} action(s) queued.`)
      setTargetDeviceIds('')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not queue actions')
    } finally {
      setBusy(false)
    }
  }

  const showInventory = async () => {
    if (!inventoryDeviceId.trim()) return
    setBusy(true)
    setError(null)
    try {
      setInventory((await getDeviceInventory(inventoryDeviceId.trim())).inventory)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load inventory')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Shell>
      <div className="page-head">
        <h1 className="page-title">Endpoint management</h1>
      </div>

      {error ? <Alert kind="error">{error}</Alert> : null}
      {notice ? <Alert kind="info">{notice}</Alert> : null}

      {dex ? (
        <div className="stat-row">
          <div className="stat-card"><span className="stat-value mono">{dex.avg_score}</span><span className="stat-label">Avg DEX score</span></div>
          <div className="stat-card"><span className="stat-value mono">{dex.healthy}</span><span className="stat-label">Healthy (≥80)</span></div>
          <div className="stat-card"><span className="stat-value mono">{dex.poor}</span><span className="stat-label">Poor (&lt;60)</span></div>
          <div className="stat-card"><span className="stat-value mono">{dex.openPostureAlerts}</span><span className="stat-label">Open posture alerts</span></div>
        </div>
      ) : null}

      <div className="kb-layout">
        <section className="form-panel">
          <h2 className="channel-form-title">Bulk action</h2>
          <div className="form-row">
            <select className="field-input" value={actionKind} onChange={(e) => setActionKind(e.target.value as DeviceActionKind)} aria-label="Action">
              {ACTION_KINDS.map((a) => <option key={a} value={a}>{a.replace('_', ' ')}</option>)}
            </select>
          </div>
          <div className="form-row">
            <input className="field-input mono" placeholder="Device ids (comma-separated; empty = whole tenant)" value={targetDeviceIds} onChange={(e) => setTargetDeviceIds(e.target.value)} />
          </div>
          <div className="form-actions">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void queue()}>Queue actions</button>
          </div>

          <h3 className="channel-title">Action queue</h3>
          {actions === null ? <span className="etch">Loading…</span> : actions.length === 0 ? <p className="muted">No queued actions.</p> : (
            <ul className="channel-list">
              {actions.map((a) => (
                <li key={a.id} className="channel-card">
                  <div className="channel-main">
                    <span className="channel-name mono">{a.action.replace('_', ' ')} · {a.device_name}</span>
                    <span className="channel-meta mono">{a.status} · {a.requested_by_name ?? '—'}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="form-panel">
          {canManage ? (
            <>
              <h2 className="channel-form-title">New policy</h2>
              <form onSubmit={(e) => void addPolicy(e)}>
                <div className="form-row">
                  <input className="field-input" placeholder="Policy name" value={policyName} onChange={(e) => setPolicyName(e.target.value)} required />
                  <input className="field-input mono" placeholder="Group id (optional)" value={policyGroup} onChange={(e) => setPolicyGroup(e.target.value)} />
                </div>
                <div className="form-actions">
                  <button type="submit" className="btn btn-primary" disabled={busy || !policyName.trim()}>{busy ? 'Creating…' : 'Create'}</button>
                </div>
              </form>
            </>
          ) : null}

          <h3 className="channel-title">Policies</h3>
          {policies === null ? <span className="etch">Loading…</span> : policies.length === 0 ? <p className="muted">No policies.</p> : (
            <ul className="channel-list">
              {policies.map((p) => (
                <li key={p.id} className="channel-card">
                  <div className="channel-main">
                    <span className="channel-name">{p.name}</span>
                    <span className="channel-meta mono">{p.group_name ?? 'all devices'} · {p.enabled ? 'enabled' : 'disabled'}</span>
                  </div>
                  <div className="channel-actions">
                    {canManage ? <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void removePolicy(p.id)}>Delete</button> : null}
                  </div>
                </li>
              ))}
            </ul>
          )}

          <h3 className="channel-title">Inventory</h3>
          <div className="form-row">
            <input className="field-input mono" placeholder="Device id" value={inventoryDeviceId} onChange={(e) => setInventoryDeviceId(e.target.value)} />
            <button type="button" className="btn btn-ghost" disabled={busy || !inventoryDeviceId.trim()} onClick={() => void showInventory()}>View</button>
          </div>
          {inventory ? (
            <pre className="mono" style={{ fontSize: 11, overflow: 'auto', maxHeight: 220 }}>{JSON.stringify({ hardware: inventory.hardware, os: inventory.os, apps: inventory.apps, security_posture: inventory.security_posture }, null, 2)}</pre>
          ) : null}
        </section>
      </div>
    </Shell>
  )
}
