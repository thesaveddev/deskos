import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Shell } from '../components/Shell.js'
import { Pagination, useOffsetPagination } from '../components/Pagination.js'
import { Alert } from '../components/ui.js'
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

function serverApiUrl(): string {
  return `${window.location.protocol}//${window.location.hostname}:4000`
}

function serverRelayUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${protocol}://${window.location.hostname}:4100/ws`
}

export default function DevicesPage() {
  const [devices, setDevices] = useState<Device[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const pagination = useOffsetPagination(20)
  const [groups, setGroups] = useState<DeviceGroup[]>([])
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<'' | DeviceStatus>('')
  const [groupId, setGroupId] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [groupsError, setGroupsError] = useState<string | null>(null)
  const [showDeploy, setShowDeploy] = useState(false)
  const [enrolCode, setEnrolCode] = useState<string | null>(null)
  const [fleetToken, setFleetToken] = useState<string | null>(null)
  const [tokenCreatedAt, setTokenCreatedAt] = useState<string | null>(null)
  const [codeExpiresAt, setCodeExpiresAt] = useState<string | null>(null)
  const [tokenBusy, setTokenBusy] = useState(false)
  const [tokenNotice, setTokenNotice] = useState<string | null>(null)
  const [copyNotice, setCopyNotice] = useState<string | null>(null)
  const [fleetNotice, setFleetNotice] = useState<string | null>(null)
  const canManage = useAuth((state) => state.memberships.some((membership) => membership.permissions.includes('device.manage')))

  const loadDevices = useCallback(async () => {
    setError(null)
    setLoading(true)
    try {
      const response = await listDevices({
        q: query.trim() || undefined,
        status: status || undefined,
        groupId: groupId || undefined,
        limit: pagination.pageSize,
        offset: pagination.offset,
      })
      setDevices(response.devices)
      setTotal(response.total ?? response.devices.length)
    } catch (err) {
      setDevices([])
      setError(err instanceof Error ? err.message : 'Failed to load devices')
    }
    setLoading(false)
  }, [groupId, query, status, pagination.page, pagination.pageSize])

  useEffect(() => {
    void loadDevices()
  }, [loadDevices])

  useEffect(() => {
    void listDeviceGroups()
      .then((response) => setGroups(response.groups))
      .catch((err) => setGroupsError(err instanceof Error ? err.message : 'Groups unavailable'))
    if (canManage) {
      void getEnrolToken()
        .then((response) => {
          setTokenCreatedAt(response.activeCode?.createdAt ?? response.activeToken?.createdAt ?? null)
          setCodeExpiresAt(response.activeCode?.expiresAt ?? null)
        })
        .catch(() => {})
    }
  }, [canManage])

  const handleRotateToken = async () => {
    if (!canManage || tokenBusy) return
    setTokenBusy(true)
    setTokenNotice(null)
    try {
      const result = await rotateEnrolToken()
      setEnrolCode(result.code || null)
      setFleetToken(result.token || null)
      setCodeExpiresAt(result.codeExpiresAt || null)
      setTokenNotice('Enrollment credential rotated.')
    } catch (err) {
      setTokenNotice(err instanceof Error ? err.message : 'Rotation failed')
    }
    setTokenBusy(false)
  }

  const handleCopy = async (text: string, which: 'code' | 'fleet') => {
    try {
      await navigator.clipboard.writeText(text)
      setCopyNotice(which === 'code' ? 'Enrollment code copied.' : 'Fleet token copied.')
      setTimeout(() => setCopyNotice(null), 2000)
    } catch {
      setCopyNotice('Copy failed — select and copy manually.')
    }
  }

  return (
    <Shell>
      <div className="page-head">
        <h1 className="page-title">Devices</h1>
        {canManage && (
          <button className="btn btn-ghost btn-sm" onClick={() => setShowDeploy((open) => !open)}>
            {showDeploy ? 'Hide deploy info' : 'Deploy / enrol'}
          </button>
        )}
      </div>

      {showDeploy && (
        <section className="panel deploy-panel">
          <h2 className="channel-form-title">Enrol a device</h2>
          <p className="muted" style={{ marginBottom: 12 }}>
            Run the agent installer on the target machine, then paste the enrollment code or fleet token below.
          </p>

          <div className="deploy-row">
            <div>
              <span className="etch">Current enrollment code</span>
              {enrolCode ? (
                <div className="deploy-code-row">
                  <code className="deploy-code">{enrolCode}</code>
                  <button className="btn btn-ghost btn-sm" onClick={() => void handleCopy(enrolCode, 'code')}>Copy</button>
                </div>
              ) : (
                <div className="deploy-code-row">
                  <span className="muted">No active code — rotate to generate one.</span>
                </div>
              )}
              {copyNotice && <span className="muted" style={{ display: 'block', marginTop: 4 }}>{copyNotice}</span>}
              {tokenNotice && <span className="muted" style={{ display: 'block', marginTop: 4 }}>{tokenNotice}</span>}
              <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
                {tokenCreatedAt ? `Created ${new Date(tokenCreatedAt).toLocaleString()}` : ''}
                {codeExpiresAt ? ` · Expires ${new Date(codeExpiresAt).toLocaleString()}` : ''}
              </div>
              <button className="btn btn-ghost btn-sm" style={{ marginTop: 8 }} onClick={() => void handleRotateToken()} disabled={tokenBusy}>
                {tokenBusy ? 'Rotating…' : 'Rotate enrollment code'}
              </button>
            </div>

            <div>
              <span className="etch">Fleet token</span>
              {fleetToken ? (
                <div className="deploy-code-row">
                  <code className="deploy-code" style={{ maxWidth: 320, wordBreak: 'break-all' }}>{fleetToken}</code>
                  <button className="btn btn-ghost btn-sm" onClick={() => handleCopy(fleetToken, 'fleet')}>Copy</button>
                </div>
              ) : (
                <div className="deploy-code-row">
                  <span className="muted">No fleet token — rotate to generate one.</span>
                </div>
              )}
              {fleetNotice && <span className="muted" style={{ display: 'block', marginTop: 4 }}>{fleetNotice}</span>}
            </div>
          </div>

          <div style={{ marginTop: 12 }}>
            <span className="etch">Server endpoints (read-only)</span>
            <div className="deploy-code-row" style={{ marginTop: 4 }}>
              <span className="muted">API</span>
              <code className="deploy-code" style={{ fontSize: 12 }}>{serverApiUrl()}</code>
            </div>
            <div className="deploy-code-row" style={{ marginTop: 4 }}>
              <span className="muted">Relay</span>
              <code className="deploy-code" style={{ fontSize: 12 }}>{serverRelayUrl()}</code>
            </div>
          </div>
        </section>
      )}

      {error ? <Alert kind="error">{error}</Alert> : null}

      <div className="filter-bar">
        <input
          className="field-input"
          placeholder="Search devices…"
          value={query}
          onChange={(e) => { setQuery(e.target.value); pagination.goToPage(0) }}
          onKeyDown={(e) => e.key === 'Enter' && void loadDevices()}
          style={{ maxWidth: 240 }}
        />
        <select
          className="field-input"
          value={status}
          onChange={(e) => { setStatus(e.target.value as '' | DeviceStatus); pagination.goToPage(0) }}
        >
          {STATUS_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        <select
          className="field-input"
          value={groupId}
          onChange={(e) => { setGroupId(e.target.value); pagination.goToPage(0) }}
        >
          <option value="">All groups</option>
          {groups.map((group) => (
            <option key={group.id} value={group.id}>{group.name}</option>
          ))}
        </select>
        {groupsError && <span className="muted" style={{ fontSize: 12 }}>{groupsError}</span>}
      </div>

      {loading ? (
        <div className="etch" style={{ padding: 24 }}>Loading devices…</div>
      ) : devices.length === 0 ? (
        <div className="empty-state">No devices found.</div>
      ) : (
        <table className="queue-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Hostname</th>
              <th>OS</th>
              <th>Status</th>
              <th>Group</th>
              <th className="col-updated">Last seen</th>
            </tr>
          </thead>
          <tbody>
            {devices.map((device) => (
              <tr key={device.id} onClick={() => window.location.assign(`/devices/${device.id}`)} style={{ cursor: 'pointer' }}>
                <td>{device.name}</td>
                <td className="mono">{device.hostname}</td>
                <td>{platformLabel(device)}</td>
                <td>
                  <span className={`status-pill status-${device.status}`}>{statusLabel(device.status)}</span>
                </td>
                <td>{device.group_name ?? '—'}</td>
                <td className="col-updated mono">{device.last_seen_at ? formatWhen(device.last_seen_at) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {devices.length > 0 && (
        <Pagination
          page={pagination.page}
          pageSize={pagination.pageSize}
          totalItems={total}
          loading={loading}
          onPageChange={pagination.goToPage}
          onPageSizeChange={pagination.changeSize}
        />
      )}
    </Shell>
  )
}
