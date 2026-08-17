import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Shell } from '../components/Shell.js'
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
  const [devices, setDevices] = useState<Device[] | null>(null)
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
    try {
      const response = await listDevices({ q: query.trim() || undefined, status: status || undefined, groupId: groupId || undefined })
      setDevices(response.devices)
    } catch (err) {
      setDevices([])
      setError(err instanceof Error ? err.message : 'Failed to load devices')
    }
  }, [groupId, query, status])

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
        .catch(() => {
          // Reading the token requires device management permission. The page remains useful without it.
        })
    }
  }, [canManage])

  const handleRotateToken = async () => {
    if (tokenBusy) return
    setTokenBusy(true)
    setTokenNotice(null)
    setCopyNotice(null)
    try {
      const response = await rotateEnrolToken()
      setEnrolCode(response.code)
      setFleetToken(response.token)
      setTokenCreatedAt(new Date().toISOString())
      setCodeExpiresAt(response.codeExpiresAt)
      setTokenNotice('Read this code to the endpoint user before it expires. It can be used only once.')
    } catch (err) {
      setTokenNotice(err instanceof Error ? err.message : 'Could not generate the enrollment code')
    } finally {
      setTokenBusy(false)
    }
  }

  const copyToken = async () => {
    if (!enrolCode) return
    try {
      await navigator.clipboard.writeText(enrolCode)
      setCopyNotice('Copied to clipboard.')
    } catch {
      setCopyNotice('Copy failed — select the code manually.')
    }
  }

  const fleetCommand = fleetToken
    ? `msiexec /i DeskOSAgent.msi /qn DESKOS_API_URL="${serverApiUrl()}" DESKOS_RELAY_URL="${serverRelayUrl()}" DESKOS_ENROLL_TOKEN="${fleetToken}"`
    : ''

  const copyFleetCommand = async () => {
    if (!fleetCommand) return
    try {
      await navigator.clipboard.writeText(fleetCommand)
      setFleetNotice('Fleet deployment command copied.')
    } catch {
      setFleetNotice('Copy failed — select the command manually.')
    }
  }

  const clearFilters = () => {
    setQuery('')
    setStatus('')
    setGroupId('')
  }

  return (
    <Shell>
      <div className="page-head">
        <div>
          <h1 className="page-title">Devices</h1>
          <p className="page-subtitle">Endpoint health, inventory, alerts, and linked tickets.</p>
        </div>
        <div className="page-actions">
          <Link to="/devices/groups" className="btn btn-ghost btn-sm">Manage groups</Link>
          {canManage ? (
            <button className="btn btn-primary btn-sm" onClick={() => setShowDeploy((visible) => !visible)}>
              {showDeploy ? 'Hide deployment' : 'Deploy agent'}
            </button>
          ) : null}
        </div>
      </div>

      {error ? <Alert kind="error">{error}</Alert> : null}

      {showDeploy && canManage ? (
        <section className="deploy-panel">
          <div className="deploy-panel-head">
            <div>
              <span className="etch">Device enrolment</span>
              <h2>Connect an endpoint</h2>
            </div>
            {tokenCreatedAt ? <span className="muted mono">rotated {formatWhen(tokenCreatedAt)}</span> : null}
          </div>
          <p className="muted deploy-copy">
            Generate an eight-digit enrollment code, then read it to the endpoint user. It expires after 15 minutes and is consumed by the first successful enrollment. Fleet deployments use a separate opaque token generated at the same time.
          </p>
          {enrolCode ? (
            <div className="token-reveal">
              <code aria-label="Eight-digit enrollment code">{enrolCode}</code>
              <button className="btn btn-ghost btn-sm" onClick={() => void copyToken()}>Copy code</button>
              {codeExpiresAt ? <span className="field-hint">expires {formatWhen(codeExpiresAt)}</span> : null}
            </div>
          ) : null}
          {copyNotice ? <div className="field-hint">{copyNotice}</div> : null}
          {tokenNotice ? <Alert kind={enrolCode ? 'info' : 'error'}>{tokenNotice}</Alert> : null}
          <div className="deploy-actions">
            <button className="btn btn-primary btn-sm" onClick={() => void handleRotateToken()} disabled={tokenBusy}>
              {tokenBusy ? 'Generating…' : enrolCode ? 'Generate another code' : 'Generate enrollment code'}
            </button>
            <span className="field-hint">The code is shown once and expires in 15 minutes.</span>
          </div>
          <div className="deploy-modes">
            <article className="deploy-mode-card">
              <span className="etch">Customer-assisted</span>
              <strong>Send the MSI and code</strong>
              <p className="muted">The user installs the MSI, opens <b>Enroll DeskOS Agent</b> from the Start Menu, and enters only this one-time code in the local browser wizard.</p>
            </article>
            <article className="deploy-mode-card">
              <span className="etch">Technician-assisted</span>
              <strong>Guide the user through setup</strong>
              <p className="muted">Share the MSI and code during a support call. The user approves enrollment, then you can request the first attended session.</p>
            </article>
            <article className="deploy-mode-card deploy-mode-fleet">
              <span className="etch">IT fleet deployment</span>
              <strong>Protected MSI bootstrap token</strong>
              <p className="muted">Pass this command through Intune, Group Policy, or your endpoint platform. It uses the opaque fleet token returned with the phone-friendly code.</p>
              {fleetCommand ? <code className="fleet-command">{fleetCommand}</code> : <span className="field-hint">Generate a token to create the fleet command.</span>}
              <button className="btn btn-ghost btn-sm" onClick={() => void copyFleetCommand()} disabled={!fleetCommand}>Copy fleet command</button>
              {fleetNotice ? <span className="field-hint">{fleetNotice}</span> : null}
            </article>
          </div>
        </section>
      ) : null}

      <div className="device-filters">
        <input
          className="field-input device-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search by name, hostname, or OS…"
          aria-label="Search devices"
        />
        <select className="field-input device-filter" value={status} onChange={(event) => setStatus(event.target.value as '' | DeviceStatus)} aria-label="Filter by status">
          {STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <select className="field-input device-filter" value={groupId} onChange={(event) => setGroupId(event.target.value)} aria-label="Filter by group">
          <option value="">All groups</option>
          {groups.map((group) => <option key={group.id} value={group.id}>{group.name} ({group.device_count})</option>)}
        </select>
        {(query || status || groupId) ? <button className="btn btn-ghost btn-sm" onClick={clearFilters}>Clear</button> : null}
      </div>

      {groupsError ? <div className="field-hint device-inline-note">{groupsError}</div> : null}
      {devices === null ? <div className="etch" style={{ padding: 24 }}>Loading devices…</div> : null}
      {devices && devices.length === 0 ? (
        <div className="empty-state">
          <p>{query || status || groupId ? 'No devices match these filters.' : 'No devices have enrolled yet.'}</p>
          {query || status || groupId ? (
            <button className="btn btn-ghost" onClick={clearFilters}>Clear filters</button>
          ) : canManage ? (
            <button className="btn btn-primary" onClick={() => setShowDeploy(true)}>Deploy your first agent</button>
          ) : null}
        </div>
      ) : null}

      {devices && devices.length > 0 ? (
        <div className="device-table-wrap">
          <table className="device-table">
            <thead>
              <tr>
                <th>Device</th>
                <th>Status</th>
                <th>Platform</th>
                <th>Group</th>
                <th>Last seen</th>
                <th className="device-ip">IP address</th>
              </tr>
            </thead>
            <tbody>
              {devices.map((device) => (
                <tr key={device.id}>
                  <td>
                    <Link to={`/devices/${device.id}`} className="device-name-link">
                      <span className="device-avatar">{(device.name || '?').slice(0, 1).toUpperCase()}</span>
                      <span>
                        <strong>{device.name}</strong>
                        <small>{device.hostname || 'No hostname reported'}</small>
                      </span>
                    </Link>
                  </td>
                  <td><span className={`status-pill status-${device.status}`}>{statusLabel(device.status)}</span></td>
                  <td>{platformLabel(device)}</td>
                  <td>{device.group_name ?? <span className="muted">Ungrouped</span>}</td>
                  <td className="mono">{device.last_seen_at ? formatWhen(device.last_seen_at) : '—'}</td>
                  <td className="device-ip mono">{device.ip_address || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Shell>
  )
}
