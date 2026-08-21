import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Shell } from '../components/Shell.js'
import { Alert, Field, Modal, PageHeader, Panel, useConfirm } from '../components/ui.js'
import { Icon } from '../components/Icons.js'
import { useAuth } from '../lib/auth.js'
import { fleetDex, type FleetDex } from '../lib/dex.js'
import {
  createPolicy,
  deletePolicy,
  getDeviceInventory,
  listDeviceActions,
  listPolicies,
  queueDeviceActions,
  type DeviceAction,
  type DeviceActionKind,
  type DeviceInventory,
  type EndpointPolicy,
} from '../lib/rmm.js'

const ACTION_KINDS: DeviceActionKind[] = ['restart', 'run_script', 'collect_inventory']
type WorkspaceTab = 'overview' | 'actions' | 'policies' | 'inventory'

function actionLabel(action: DeviceActionKind): string {
  return action.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function actionIcon(action: DeviceActionKind): 'refresh' | 'play' | 'file' {
  if (action === 'restart') return 'refresh'
  if (action === 'run_script') return 'play'
  return 'file'
}

function scoreTone(score: number): 'ok' | 'warn' | 'crit' {
  return score >= 80 ? 'ok' : score < 60 ? 'crit' : 'warn'
}

export default function RmmPage() {
  const auth = useAuth()
  const perms = new Set(auth.memberships.flatMap((m) => m.permissions))
  const canManage = perms.has('rmm.manage')
  const confirm = useConfirm()

  const [tab, setTab] = useState<WorkspaceTab>('overview')
  const [policies, setPolicies] = useState<EndpointPolicy[] | null>(null)
  const [actions, setActions] = useState<DeviceAction[] | null>(null)
  const [actionKind, setActionKind] = useState<DeviceActionKind>('collect_inventory')
  const [targetDeviceIds, setTargetDeviceIds] = useState('')
  const [policyName, setPolicyName] = useState('')
  const [policyGroup, setPolicyGroup] = useState('')
  const [inventoryDeviceId, setInventoryDeviceId] = useState('')
  const [inventory, setInventory] = useState<DeviceInventory | null>(null)
  const [dex, setDex] = useState<FleetDex | null>(null)
  const [showActionModal, setShowActionModal] = useState(false)
  const [showPolicyModal, setShowPolicyModal] = useState(false)
  const [showInventoryModal, setShowInventoryModal] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [policyResponse, actionResponse, dexResponse] = await Promise.all([
        listPolicies(),
        listDeviceActions(),
        fleetDex(),
      ])
      setPolicies(policyResponse.policies)
      setActions(actionResponse.actions)
      setDex(dexResponse)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load endpoint data')
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const addPolicy = async (event: FormEvent) => {
    event.preventDefault()
    if (busy || !policyName.trim()) return
    setBusy(true); setError(null); setNotice(null)
    try {
      await createPolicy({ name: policyName.trim(), groupId: policyGroup.trim() || null })
      setPolicyName(''); setPolicyGroup(''); setShowPolicyModal(false)
      setNotice('Endpoint policy created.')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create policy')
    } finally { setBusy(false) }
  }

  const removePolicy = async (policy: EndpointPolicy) => {
    if (busy || !await confirm(`Delete “${policy.name}”? This removes the policy from the endpoint management workspace.`, { title: 'Delete endpoint policy', confirmLabel: 'Delete policy', destructive: true })) return
    setBusy(true); setError(null); setNotice(null)
    try {
      await deletePolicy(policy.id)
      setNotice('Endpoint policy deleted.')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete policy')
    } finally { setBusy(false) }
  }

  const queue = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    setBusy(true); setError(null); setNotice(null)
    try {
      const deviceIds = targetDeviceIds.split(',').map((value) => value.trim()).filter(Boolean)
      const result = await queueDeviceActions({ action: actionKind, deviceIds: deviceIds.length ? deviceIds : undefined })
      setNotice(`${result.created} action${result.created === 1 ? '' : 's'} queued for the endpoint agent.`)
      setTargetDeviceIds(''); setShowActionModal(false); setTab('actions'); await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not queue actions')
    } finally { setBusy(false) }
  }

  const showInventory = async (event: FormEvent) => {
    event.preventDefault()
    if (busy || !inventoryDeviceId.trim()) return
    setBusy(true); setError(null)
    try {
      setInventory((await getDeviceInventory(inventoryDeviceId.trim())).inventory)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load inventory')
    } finally { setBusy(false) }
  }

  const openInventory = () => {
    setTab('inventory')
    setShowInventoryModal(true)
  }

  const tabs: Array<{ id: WorkspaceTab; label: string; count?: number; icon: 'monitor' | 'play' | 'shield' | 'file' }> = [
    { id: 'overview', label: 'Overview', icon: 'monitor' },
    { id: 'actions', label: 'Action queue', count: actions?.length, icon: 'play' },
    { id: 'policies', label: 'Policies', count: policies?.length, icon: 'shield' },
    { id: 'inventory', label: 'Inventory', icon: 'file' },
  ]

  const score = dex?.avg_score ?? 0
  const tone = scoreTone(score)

  return (
    <Shell>
      <div className="rmm-page">
        <PageHeader
          title="Endpoint management"
          subtitle="Keep fleet operations, device actions, posture, and experience health in one focused workspace."
          actions={canManage ? <div className="page-actions"><button className="btn btn-ghost btn-sm" onClick={openInventory}><Icon name="file" size={14} />Inspect inventory</button><button className="btn btn-ghost btn-sm" onClick={() => setShowPolicyModal(true)}><Icon name="shield" size={14} />New policy</button><button className="btn btn-primary btn-sm" onClick={() => setShowActionModal(true)}><Icon name="play" size={14} />Queue action</button></div> : undefined}
        />

        {error ? <Alert kind="error">{error}</Alert> : null}
        {notice ? <Alert kind="info">{notice}</Alert> : null}

        <section className="rmm-hero" aria-label="Endpoint management summary">
          <div className="rmm-hero-copy">
            <span className="settings-eyebrow">Fleet operations</span>
            <h2>Know what needs attention before users report it.</h2>
            <p>Use DEX scores to prioritize work, policies to keep baselines consistent, and audited actions to make changes safely.</p>
            <div className="rmm-hero-actions"><button className="btn btn-primary btn-sm" onClick={() => setTab('overview')}><Icon name="monitor" size={14} />View health overview</button><button className="btn btn-ghost btn-sm" onClick={() => setTab('actions')}><Icon name="play" size={14} />Review action queue</button></div>
          </div>
          <div className={`rmm-score-card rmm-score-${tone}`}>
            <span className="rmm-score-label">Fleet DEX score</span>
            <strong>{dex ? dex.avg_score : '—'}</strong>
            <span>{dex ? `${dex.devices} managed endpoint${dex.devices === 1 ? '' : 's'}` : 'Loading fleet health…'}</span>
          </div>
        </section>

        <div className="rmm-summary-grid">
          <div className="rmm-summary-card"><span className="rmm-summary-icon"><Icon name="monitor" size={17} /></span><div><strong>{dex?.devices ?? '—'}</strong><span>Managed endpoints</span><small>Reporting into ReyDesk</small></div></div>
          <div className="rmm-summary-card"><span className="rmm-summary-icon rmm-summary-icon-ok"><Icon name="check" size={17} /></span><div><strong>{dex?.healthy ?? '—'}</strong><span>Healthy endpoints</span><small>DEX score of 80 or higher</small></div></div>
          <div className="rmm-summary-card"><span className="rmm-summary-icon rmm-summary-icon-warn"><Icon name="alert" size={17} /></span><div><strong>{dex?.poor ?? '—'}</strong><span>Need attention</span><small>Persistent issues are ticketed only after three poor samples</small></div></div>
          <div className="rmm-summary-card"><span className="rmm-summary-icon rmm-summary-icon-crit"><Icon name="shield" size={17} /></span><div><strong>{dex?.openPostureAlerts ?? '—'}</strong><span>Open posture alerts</span><small>Policy checks failing</small></div></div>
        </div>

        {dex ? <section className="dex-workspace" aria-label="Digital employee experience overview">
          <div className="dex-component-grid">
            {([['performance', 'Performance experience', 'CPU, memory, disk, startup, and application stability'], ['availability', 'Availability experience', 'Heartbeat and service availability'], ['security', 'Security posture', 'Endpoint policy compliance'], ['userImpact', 'User-impact signals', 'Surveys and user-facing application friction']] as const).map(([key, label, detail]) => {
              const value = dex.componentScores?.[key]
              return <article className="dex-component-card" key={key}><div className="dex-component-head"><span>{label}</span><strong>{value ?? '—'}</strong></div><div className="metric-track"><div className={`metric-fill ${value >= 80 ? 'metric-fill-ok' : value < 60 ? 'metric-fill-crit' : 'metric-fill-warn'}`} style={{ width: `${Math.max(0, Math.min(100, value ?? 0))}%` }} /></div><small>{detail}</small></article>
            })}
          </div>
          <div className="dex-insight-grid">
            <section className="detail-card"><div className="detail-card-head"><div><h2>Experience trend</h2><span className="muted">Historical daily score and component baselines</span></div><span className="mono muted">{dex.trends.length} days</span></div>{dex.trends.length < 2 ? <div className="detail-empty">More telemetry is needed to show a trend.</div> : <div className="dex-trend-list">{dex.trends.slice(-14).map((point) => <div className="dex-trend-row" key={point.day}><span className="mono">{new Date(point.day).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span><div className="metric-track"><div className="metric-fill metric-fill-ok" style={{ width: `${point.score}%` }} /></div><strong>{point.score}</strong></div>)}</div>}</section>
            <section className="detail-card"><div className="detail-card-head"><div><h2>Recommended next actions</h2><span className="muted">Prioritized from observed evidence</span></div></div>{dex.recommendations.length === 0 ? <div className="detail-empty"><Icon name="check" size={18} />No recommendations right now.</div> : <div className="dex-recommendations">{dex.recommendations.slice(0, 5).map((item, index) => <div className="dex-recommendation" key={`${item.code}-${item.deviceId ?? index}`}><span className={`status-pill status-${item.priority === 'high' ? 'critical' : item.priority}`}>{item.priority}</span><div><strong>{item.title}</strong><small>{item.deviceName ? `${item.deviceName} · ` : ''}{item.detail}</small></div></div>)}</div>}</section>
          </div>
          <section className="detail-card"><div className="detail-card-head"><div><h2>Experience comparison</h2><span className="muted">Department-level view of where users are affected</span></div></div>{dex.comparisons.length === 0 ? <div className="detail-empty">Assign devices to users, teams, or departments to compare experience.</div> : <div className="dex-comparison-list">{dex.comparisons.slice(0, 8).map((item) => <div className="dex-comparison-row" key={item.segment}><span>{item.segment}</span><strong>{item.score}</strong><div className="metric-track"><div className={`metric-fill ${item.score >= 80 ? 'metric-fill-ok' : item.score < 60 ? 'metric-fill-crit' : 'metric-fill-warn'}`} style={{ width: `${item.score}%` }} /></div><small>{item.devices} device{item.devices === 1 ? '' : 's'}</small></div>)}</div>}</section>
        </section> : null}

        <nav className="rmm-tabs" role="tablist" aria-label="Endpoint management sections">
          {tabs.map((item) => <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} className={`rmm-tab${tab === item.id ? ' active' : ''}`} onClick={() => setTab(item.id)}><Icon name={item.icon} size={15} /><span>{item.label}</span>{item.count !== undefined ? <b>{item.count}</b> : null}</button>)}
        </nav>

        {tab === 'overview' ? <div className="rmm-overview-content">
          {dex ? <div className="rmm-compliance-grid"><section className="detail-card rmm-compliance-card"><div className="detail-card-head"><div><h2>Posture compliance</h2><span className="muted">Current endpoint policy results</span></div><strong className={dex.postureCompliance.percentage >= 80 ? 'metric-ok' : 'metric-warn'}>{dex.postureCompliance.percentage}%</strong></div><div className="metric-track"><div className={`metric-fill ${dex.postureCompliance.percentage >= 80 ? 'metric-fill-ok' : 'metric-fill-warn'}`} style={{ width: `${dex.postureCompliance.percentage}%` }} /></div><div className="rmm-compliance-meta"><span><strong>{dex.postureCompliance.compliantDevices}</strong> compliant</span><span><strong>{dex.postureCompliance.failingDevices}</strong> need attention</span><span><strong>{dex.postureCompliance.totalDevices}</strong> total</span></div></section><section className="detail-card"><div className="detail-card-head"><div><h2>Open posture checks</h2><span className="muted">Most common policy failures</span></div><button className="btn btn-ghost btn-xs" onClick={() => setTab('policies')}>View policies <Icon name="forward" size={13} /></button></div>{dex.postureChecks.length === 0 ? <div className="detail-empty"><Icon name="check" size={20} /><span>No open posture failures.</span></div> : <div className="rmm-posture-checks">{dex.postureChecks.map((check) => <div key={check.check_path}><span className="mono">{check.check_path}</span><strong>{check.open_count}</strong></div>)}</div>}</section></div> : <div className="rmm-loading-card">Loading endpoint health…</div>}
          <div className="rmm-overview-lower"><Panel title="What you can do here" subtitle="A practical workflow for endpoint operations."><div className="rmm-workflow-grid"><button onClick={() => setTab('actions')}><span><Icon name="play" size={17} /></span><strong>Run an audited action</strong><small>Restart devices, run approved scripts, or collect inventory.</small></button><button onClick={() => setTab('policies')}><span><Icon name="shield" size={17} /></span><strong>Maintain a baseline</strong><small>Apply posture expectations to groups of endpoints.</small></button><button onClick={openInventory}><span><Icon name="file" size={17} /></span><strong>Inspect inventory</strong><small>Review hardware, software, OS, and security facts.</small></button></div></Panel><Panel title="Operational guidance" subtitle="Use endpoint controls deliberately."><ul className="rmm-guidance-list"><li><Icon name="check" size={14} /><span>Prefer policies for repeatable standards instead of one-off changes.</span></li><li><Icon name="clock" size={14} /><span>Queue actions during maintenance windows and review the result in the queue.</span></li><li><Icon name="shield" size={14} /><span>Every action is scoped to your organization and recorded for audit.</span></li></ul></Panel></div>
        </div> : null}

        {tab === 'actions' ? <Panel title="Action queue" subtitle="Commands waiting for endpoint agents or recently completed." actions={canManage ? <button className="btn btn-primary btn-sm" onClick={() => setShowActionModal(true)}><Icon name="play" size={14} />Queue action</button> : undefined}>
          {actions === null ? <div className="rmm-loading-card">Loading actions…</div> : actions.length === 0 ? <div className="empty-state compact-empty"><Icon name="play" size={20} /><strong>No endpoint actions</strong><span>Queue a restart, inventory collection, or scripted action when needed.</span>{canManage ? <button className="btn btn-primary btn-sm" onClick={() => setShowActionModal(true)}><Icon name="add" size={14} />Queue first action</button> : null}</div> : <div className="rmm-action-list">{actions.map((action) => <article className="rmm-action-card" key={action.id}><span className="rmm-action-icon"><Icon name={actionIcon(action.action)} size={17} /></span><div className="rmm-action-main"><div><strong>{actionLabel(action.action)}</strong><span className={`status-pill status-${action.status}`}>{action.status}</span></div><p>{action.device_name}</p><small>{action.requested_by_name ?? 'Unknown requester'} · {new Date(action.created_at).toLocaleString()}</small></div><span className="rmm-action-result">{action.completed_at ? `Completed ${new Date(action.completed_at).toLocaleString()}` : action.status === 'pending' ? 'Waiting for agent' : 'In progress'}</span></article>)}</div>}
        </Panel> : null}

        {tab === 'policies' ? <Panel title="Endpoint policies" subtitle="Baseline posture and maintenance policies applied to device groups." actions={canManage ? <button className="btn btn-primary btn-sm" onClick={() => setShowPolicyModal(true)}><Icon name="add" size={14} />New policy</button> : undefined}>
          {policies === null ? <div className="rmm-loading-card">Loading policies…</div> : policies.length === 0 ? <div className="empty-state compact-empty"><Icon name="shield" size={20} /><strong>No policies configured</strong><span>Create a policy to define the baseline for your estate.</span>{canManage ? <button className="btn btn-primary btn-sm" onClick={() => setShowPolicyModal(true)}><Icon name="add" size={14} />Create first policy</button> : null}</div> : <div className="rmm-policy-grid">{policies.map((policy) => <article className="rmm-policy-card" key={policy.id}><div className="rmm-policy-card-head"><span className="rmm-policy-icon"><Icon name="shield" size={17} /></span><span className={`status-pill ${policy.enabled ? 'status-open' : 'status-resolved'}`}>{policy.enabled ? 'Enabled' : 'Disabled'}</span></div><h3>{policy.name}</h3><p>{policy.group_name ?? 'All managed endpoints'}</p><div className="rmm-policy-meta"><span>{policy.posture_checks.length} posture checks</span><span>Created {new Date(policy.created_at).toLocaleDateString()}</span></div>{canManage ? <button type="button" className="btn btn-ghost btn-sm rmm-policy-delete" disabled={busy} onClick={() => void removePolicy(policy)}><Icon name="delete" size={14} />Delete policy</button> : null}</article>)}</div>}
        </Panel> : null}

        {tab === 'inventory' ? <Panel title="Endpoint inventory" subtitle="Inspect a device's reported hardware, operating system, applications, and security posture." actions={canManage ? <button className="btn btn-primary btn-sm" onClick={() => setShowInventoryModal(true)}><Icon name="search" size={14} />Inspect device</button> : undefined}>
          <div className="rmm-inventory-intro"><span className="rmm-inventory-intro-icon"><Icon name="file" size={20} /></span><div><h3>On-demand inventory</h3><p>Enter a device ID to request the latest inventory snapshot. The result is read-only and remains inside this organization.</p></div></div>{inventory ? <div className="rmm-inventory-preview"><div className="rmm-inventory-preview-head"><div><strong>Latest snapshot</strong><span className="muted mono">{inventory.device_id} · {new Date(inventory.collected_at).toLocaleString()}</span></div><button className="btn btn-ghost btn-sm" onClick={() => setShowInventoryModal(true)}><Icon name="refresh" size={14} />Inspect another</button></div><pre className="inventory-preview mono">{JSON.stringify({ hardware: inventory.hardware, os: inventory.os, apps: inventory.apps, security_posture: inventory.security_posture }, null, 2)}</pre></div> : <div className="rmm-inventory-empty"><Icon name="file" size={24} /><strong>No inventory snapshot loaded</strong><span>Use Inspect device to retrieve an endpoint snapshot.</span></div>}
        </Panel> : null}
      </div>

      <Modal open={showActionModal} onClose={() => { if (!busy) setShowActionModal(false) }} title="Queue an endpoint action" width={560} footer={<><button className="btn btn-ghost" onClick={() => setShowActionModal(false)} disabled={busy}>Cancel</button><button className="btn btn-primary" form="rmm-action-form" type="submit" disabled={busy}>{busy ? 'Queueing…' : 'Queue action'}</button></>}>
        <form id="rmm-action-form" onSubmit={(event) => void queue(event)}><p className="modal-description">Commands are delivered only to online agents and remain auditable in the action queue.</p><Field label="Action"><select className="field-input" value={actionKind} onChange={(event) => setActionKind(event.target.value as DeviceActionKind)}>{ACTION_KINDS.map((action) => <option key={action} value={action}>{actionLabel(action)}</option>)}</select></Field><Field label="Target devices" hint="Optional. Leave blank for all devices, or paste comma-separated device IDs."><textarea className="field-input" rows={4} value={targetDeviceIds} onChange={(event) => setTargetDeviceIds(event.target.value)} placeholder="device-id, device-id" /></Field></form>
      </Modal>

      <Modal open={showPolicyModal} onClose={() => { if (!busy) setShowPolicyModal(false) }} title="Create endpoint policy" footer={<><button className="btn btn-ghost" onClick={() => setShowPolicyModal(false)} disabled={busy}>Cancel</button><button className="btn btn-primary" form="rmm-policy-form" type="submit" disabled={busy || !policyName.trim()}>{busy ? 'Creating…' : 'Create policy'}</button></>}>
        <form id="rmm-policy-form" onSubmit={(event) => void addPolicy(event)}><p className="modal-description">Start with a named baseline. Detailed posture checks and maintenance windows can be expanded as the policy matures.</p><Field label="Policy name"><input className="field-input" value={policyName} onChange={(event) => setPolicyName(event.target.value)} placeholder="Standard workstation baseline" required autoFocus /></Field><Field label="Device group ID" hint="Optional. Leave blank to apply this policy to the whole organization."><input className="field-input mono" value={policyGroup} onChange={(event) => setPolicyGroup(event.target.value)} placeholder="Group UUID" /></Field></form>
      </Modal>

      <Modal open={showInventoryModal} onClose={() => { if (!busy) setShowInventoryModal(false) }} title="Inspect endpoint inventory" width={700} footer={<button className="btn btn-ghost" onClick={() => setShowInventoryModal(false)}>Close</button>}>
        <form onSubmit={(event) => void showInventory(event)}><Field label="Device ID" hint="Enter the endpoint ID from Devices or the device detail page."><div className="form-row"><input className="field-input mono" value={inventoryDeviceId} onChange={(event) => setInventoryDeviceId(event.target.value)} placeholder="Device UUID" /><button className="btn btn-primary" type="submit" disabled={busy || !inventoryDeviceId.trim()}>{busy ? 'Loading…' : 'Load inventory'}</button></div></Field></form>
        {inventory ? <pre className="inventory-preview mono">{JSON.stringify({ hardware: inventory.hardware, os: inventory.os, apps: inventory.apps, security_posture: inventory.security_posture, collected_at: inventory.collected_at }, null, 2)}</pre> : <div className="empty-state compact-empty"><Icon name="file" size={20} /><span>Inventory details will appear here after you load an endpoint.</span></div>}
      </Modal>
    </Shell>
  )
}
