import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Shell } from '../components/Shell.js'
import { Pagination, useOffsetPagination } from '../components/Pagination.js'
import { Alert, Modal } from '../components/ui.js'
import { Icon } from '../components/Icons.js'
import { useAuth } from '../lib/auth.js'
import {
  getEnrolToken,
  listDeviceGroups,
  listDevices,
  rotateEnrolToken,
  type Device,
  type DeviceGroup,
  type DeviceStatus,
} from '../lib/devices.js'
import { formatWhen } from '../lib/tickets.js'

const STATUS_OPTIONS: Array<{ value: '' | DeviceStatus; label: string }> = [
  { value: '', label: 'All statuses' },
  { value: 'online', label: 'Online' },
  { value: 'offline', label: 'Offline' },
  { value: 'never', label: 'Never checked in' },
]

function statusLabel(status: DeviceStatus): string {
  return status === 'never' ? 'Never checked in' : status[0].toUpperCase() + status.slice(1)
}

function platformLabel(device: Device): string {
  const os = device.os || 'Unknown OS'
  return device.os_version ? `${os} ${device.os_version}` : os
}

function directoryLabel(managedBy: string | undefined): string {
  return managedBy === 'intune' ? 'Directory · Intune' : managedBy === 'ad' ? 'Directory · AD' : 'Directory'
}

function serverApiUrl(): string {
  return `${window.location.protocol}//${window.location.hostname}:4000`
}

function serverRelayUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${protocol}://${window.location.hostname}:4100/ws`
}

export default function DevicesPage() {
  const canManage = useAuth((state) => state.memberships.some((membership) => membership.permissions.includes('device.manage')))
  const [devices, setDevices] = useState<Device[]>([])
  const [total, setTotal] = useState(0)
  const [groups, setGroups] = useState<DeviceGroup[]>([])
  const [loading, setLoading] = useState(true)
  const pagination = useOffsetPagination(20)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<'' | DeviceStatus>('')
  const [groupId, setGroupId] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const [enrolOpen, setEnrolOpen] = useState(false)
  const [enrolCode, setEnrolCode] = useState<string | null>(null)
  const [fleetToken, setFleetToken] = useState<string | null>(null)
  const [tokenCreatedAt, setTokenCreatedAt] = useState<string | null>(null)
  const [codeExpiresAt, setCodeExpiresAt] = useState<string | null>(null)
  const [tokenBusy, setTokenBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [groupsError, setGroupsError] = useState<string | null>(null)

  const loadDevices = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await listDevices({ q: query.trim() || undefined, status: status || undefined, groupId: groupId || undefined, limit: pagination.pageSize, offset: pagination.offset })
      setDevices(response.devices)
      setTotal(response.total ?? response.devices.length)
    } catch (err) {
      setDevices([])
      setError(err instanceof Error ? err.message : 'Failed to load devices')
    } finally {
      setLoading(false)
    }
  }, [groupId, pagination.offset, pagination.pageSize, query, status])

  useEffect(() => { void loadDevices() }, [loadDevices])

  useEffect(() => {
    void listDeviceGroups().then((response) => setGroups(response.groups)).catch((err) => setGroupsError(err instanceof Error ? err.message : 'Groups unavailable'))
    if (canManage) {
      void getEnrolToken().then((response) => {
        setTokenCreatedAt(response.activeCode?.createdAt ?? response.activeToken?.createdAt ?? null)
        setCodeExpiresAt(response.activeCode?.expiresAt ?? null)
      }).catch(() => {})
    }
  }, [canManage])

  const rotate = async () => {
    if (!canManage || tokenBusy) return
    setTokenBusy(true)
    setMessage(null)
    try {
      const result = await rotateEnrolToken()
      setEnrolCode(result.code || null)
      setFleetToken(result.token || null)
      setCodeExpiresAt(result.codeExpiresAt || null)
      setTokenCreatedAt(new Date().toISOString())
      setMessage('Enrollment credentials rotated. The code is single-use and expires automatically.')
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Could not rotate enrollment credentials')
    } finally {
      setTokenBusy(false)
    }
  }

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setMessage(`${label} copied to clipboard.`)
      window.setTimeout(() => setMessage(null), 2200)
    } catch {
      setMessage('Copy failed. Select the value and copy it manually.')
    }
  }

  const clearFilters = () => {
    setQuery('')
    setStatus('')
    setGroupId('')
    pagination.reset()
  }

  const onlineOnPage = useMemo(() => devices.filter((device) => device.status === 'online').length, [devices])
  const offlineOnPage = useMemo(() => devices.filter((device) => device.status === 'offline').length, [devices])
  const activeFilters = Boolean(query || status || groupId)
  const deviceTabs = [
    { label: 'All endpoints', count: total, active: !status },
    { label: 'Online', count: status === 'online' ? total : undefined, active: status === 'online' },
    { label: 'Offline', count: status === 'offline' ? total : undefined, active: status === 'offline' },
    { label: 'Never checked in', count: status === 'never' ? total : undefined, active: status === 'never' },
  ] as const

  return (
    <Shell>
      <div className="page-head devices-page-head">
        <div className="page-head-main"><span className="settings-eyebrow">Endpoint estate</span><h1 className="page-title">Devices</h1><p className="page-subtitle">Monitor enrolled endpoints, health, ownership, and agent connectivity from one place.</p></div>
        {canManage ? <button className="btn btn-primary btn-sm" onClick={() => { setMessage(null); setEnrolOpen(true) }}><Icon name="upload" size={14} />Deploy / enrol</button> : null}
      </div>

      {error ? <Alert kind="error">{error}</Alert> : null}

      <div className="device-summary-grid">
        <div className="device-summary-card"><span className="device-summary-label">Total endpoints</span><strong>{total}</strong><small>{activeFilters ? 'Matching filters' : 'Organization-wide'}</small></div>
        <div className="device-summary-card device-summary-online"><span className="device-summary-label">Online now</span><strong>{onlineOnPage}</strong><small>On this page</small></div>
        <div className="device-summary-card device-summary-offline"><span className="device-summary-label">Needs attention</span><strong>{offlineOnPage}</strong><small>On this page</small></div>
        <div className="device-summary-card"><span className="device-summary-label">Device groups</span><strong>{groups.length}</strong><small>For filtering</small></div>
      </div>

      <nav className="workspace-tabs device-workspace-tabs" aria-label="Endpoint views">
        {deviceTabs.map((tab) => <button key={tab.label} type="button" className={`workspace-tab${tab.active ? ' active' : ''}`} onClick={() => { setStatus(tab.label === 'All endpoints' ? '' : tab.label === 'Online' ? 'online' : tab.label === 'Offline' ? 'offline' : 'never'); pagination.goToPage(0) }}>{tab.label}{tab.count !== undefined ? <span>{tab.count}</span> : null}</button>)}
        <Link className="workspace-tab-link" to="/devices/groups"><Icon name="folder" size={14} />Groups</Link>
      </nav>
      <div className="device-toolbar">
        <div className="device-toolbar-main">
          <div className="device-search-wrap"><Icon name="search" size={15} /><input className="field-input" placeholder="Search name, hostname, or operating system…" value={query} onChange={(event) => { setQuery(event.target.value); pagination.goToPage(0) }} /></div>
          <button type="button" className={`btn btn-ghost btn-sm${showFilters ? ' active' : ''}`} onClick={() => setShowFilters((open) => !open)}><Icon name="filter" size={14} />Filters{activeFilters ? ' · active' : ''}</button>
        </div>
        {activeFilters ? <button type="button" className="btn btn-link btn-sm" onClick={clearFilters}>Clear filters</button> : null}
      </div>

      {showFilters ? <div className="device-filter-panel"><div className="device-filter-field"><label className="tickets-filter-label" htmlFor="device-status">Status</label><select id="device-status" className="field-input" value={status} onChange={(event) => { setStatus(event.target.value as '' | DeviceStatus); pagination.goToPage(0) }}>{STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></div><div className="device-filter-field"><label className="tickets-filter-label" htmlFor="device-group">Device group</label><select id="device-group" className="field-input" value={groupId} onChange={(event) => { setGroupId(event.target.value); pagination.goToPage(0) }}><option value="">All groups</option>{groups.map((group) => <option key={group.id} value={group.id}>{group.name} · {group.device_count}</option>)}</select></div>{groupsError ? <span className="muted device-filter-error">{groupsError}</span> : null}</div> : null}

      <div className="device-list-head"><div><h2>Endpoint inventory</h2><p>{loading ? 'Refreshing device inventory…' : `${devices.length} shown${total !== devices.length ? ` of ${total}` : ''}`}</p></div><span className="device-list-context">{activeFilters ? 'Filtered inventory' : 'Live inventory'}</span></div>

      {loading ? <div className="device-loading"><span className="etch">Loading devices…</span></div> : devices.length === 0 ? <div className="empty-state"><Icon name="monitor" size={24} /><strong>No devices found</strong><span>{activeFilters ? 'Try changing or clearing your filters.' : 'Enroll your first endpoint to start managing your estate.'}</span>{canManage && !activeFilters ? <button className="btn btn-primary btn-sm" onClick={() => setEnrolOpen(true)}><Icon name="upload" size={14} />Deploy / enrol device</button> : null}</div> : <div className="device-table-wrap"><table className="device-table"><thead><tr><th>Endpoint</th><th>Platform</th><th>Asset tag</th><th>Assigned to</th><th>IP address</th><th>Status</th><th>Group</th><th>Agent</th><th>Last seen</th></tr></thead><tbody>{devices.map((device) => <tr key={device.id}><td><Link to={`/devices/${device.id}`} className="device-name-link"><span className="device-avatar">{device.name.slice(0, 1).toUpperCase()}</span><span><strong>{device.name}</strong><small>{device.hostname || 'No hostname'}</small></span></Link></td><td>{platformLabel(device)}<span className="device-ip">{device.arch || '—'}</span></td><td className="mono">{device.asset_tag || '—'}</td><td>{device.assigned_user_name || (device.assignment_status === 'shared' ? 'Shared device' : <span className="muted">Unassigned</span>)}</td><td className="mono device-ip-cell">{device.ip_address || '—'}</td><td><span className={`status-pill status-${device.status}`}>{statusLabel(device.status)}</span></td><td>{device.group_name ?? <span className="muted">Unassigned</span>}</td><td className="mono">{device.source === 'directory' ? <span className="device-badges"><span className="directory-device-badge">{directoryLabel(device.managed_by)}</span>{device.agent_device_id ? <span className="directory-device-badge directory-device-matched" title={`Linked to ${device.linked_agent_name || 'enrolled agent'}`}>Agent-linked</span> : null}</span> : device.agent_version || '—'}</td><td className="mono">{device.last_seen_at ? formatWhen(device.last_seen_at) : 'Never'}</td></tr>)}</tbody></table></div>}

      {devices.length > 0 ? <Pagination page={pagination.page} pageSize={pagination.pageSize} totalItems={total} loading={loading} onPageChange={pagination.goToPage} onPageSizeChange={pagination.changeSize} /> : null}

      <Modal open={enrolOpen} onClose={() => { if (!tokenBusy) setEnrolOpen(false) }} title="Deploy or enrol a device" width={700}>
        <div className="enrol-modal-content"><p className="enrol-modal-intro">Choose the enrollment method that matches the device. The installer runs on the target machine; the code is read aloud or pasted by the user.</p><div className="enrol-method-grid"><article><span className="enrol-method-icon"><Icon name="key" size={18} /></span><h3>Customer-assisted install</h3><p>Generate an eight-digit, single-use code. The user opens the ReyDesk agent and enters it.</p><button className="btn btn-primary btn-sm" onClick={() => void rotate()} disabled={tokenBusy}><Icon name="refresh" size={14} />{tokenBusy ? 'Generating…' : 'Generate enrollment code'}</button>{enrolCode ? <div className="enrol-secret"><code>{enrolCode}</code><button className="btn btn-ghost btn-xs" onClick={() => void copy(enrolCode, 'Enrollment code')}><Icon name="copy" size={13} />Copy</button></div> : null}<small>{codeExpiresAt ? `Expires ${new Date(codeExpiresAt).toLocaleString()}` : 'Code is shown only after generation.'}</small></article><article><span className="enrol-method-icon"><Icon name="settings" size={18} /></span><h3>IT fleet deployment</h3><p>Use the opaque fleet token with Intune, Group Policy, or your endpoint management platform.</p>{fleetToken ? <div className="enrol-secret"><code>{fleetToken}</code><button className="btn btn-ghost btn-xs" onClick={() => void copy(fleetToken, 'Fleet token')}><Icon name="copy" size={13} />Copy</button></div> : <span className="muted">Rotate credentials to create a fleet token.</span>}<small>Never expose the fleet token in client-side scripts or tickets.</small></article></div>{message ? <Alert kind="info">{message}</Alert> : null}<div className="enrol-endpoints"><span className="etch">Server endpoints</span><div><span>API</span><code>{serverApiUrl()}</code></div><div><span>Relay</span><code>{serverRelayUrl()}</code></div></div><div className="enrol-modal-note"><Icon name="shield" size={15} /><span>Credentials are tenant-scoped. Rotate them if they are exposed, and remove a device from the inventory when it should no longer connect.</span></div></div>
      </Modal>
    </Shell>
  )
}
