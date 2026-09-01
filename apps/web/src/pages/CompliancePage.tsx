import { useCallback, useEffect, useState } from 'react'
import { Shell } from '../components/Shell.js'
import { Alert, PageHeader } from '../components/ui.js'
import { Icon } from '../components/Icons.js'
import { getAccessToken, getActiveTenant } from '../lib/api.js'
import { auditExportUrl, getComplianceReport, listAudit, verifyAudit, type AuditEntry, type ComplianceReport } from '../lib/audit.js'

function Kpi({ icon, tone, label, value, sub }: { icon: 'book' | 'clock' | 'shield' | 'key' | 'monitor'; tone?: string; label: string; value: string | number; sub?: string }) {
  return (
    <div className="ops-kpi">
      <div className="ops-kpi-head">
        <span className={`ops-kpi-icon${tone ? ` ${tone}` : ''}`}><Icon name={icon} size={16} /></span>
      </div>
      <span className={`ops-kpi-value${tone === 'tone-ok' ? ' tone-ok' : tone === 'tone-crit' ? ' tone-crit' : tone === 'tone-warn' ? ' tone-warn' : ''}`}>{value}</span>
      <span className="ops-kpi-label">{label}</span>
      {sub ? <span className="ops-kpi-sub">{sub}</span> : null}
    </div>
  )
}

export default function CompliancePage() {
  const [tab, setTab] = useState<'overview' | 'audit'>('overview')
  const [report, setReport] = useState<ComplianceReport | null>(null)
  const [entries, setEntries] = useState<AuditEntry[] | null>(null)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [action, setAction] = useState('')
  const [objectType, setObjectType] = useState('')
  const [verified, setVerified] = useState<{ ok: boolean; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const loadEntries = useCallback(async (before?: string) => {
    try {
      const data = await listAudit({ action: action || undefined, objectType: objectType || undefined, before, limit: 100 })
      setEntries((prev) => (before && prev ? [...prev, ...data.entries] : data.entries))
      setNextCursor(data.nextCursor)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load audit log')
    }
  }, [action, objectType])

  useEffect(() => {
    void getComplianceReport().then(setReport).catch((e) => setError(e instanceof Error ? e.message : 'Failed to load compliance'))
    void loadEntries()
  }, [loadEntries])

  const runVerify = async () => {
    setBusy(true)
    setError(null)
    try {
      setVerified(await verifyAudit())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification failed')
    } finally {
      setBusy(false)
    }
  }

  const doExport = async () => {
    setBusy(true)
    setError(null)
    try {
      const headers: Record<string, string> = {}
      const token = getAccessToken()
      if (token) headers.authorization = `Bearer ${token}`
      const tenant = getActiveTenant()
      if (tenant) headers['x-reydesk-tenant'] = tenant
      const res = await fetch(auditExportUrl({ action: action || undefined }), { headers })
      if (!res.ok) throw new Error(`Export failed (${res.status})`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'reydesk-audit.csv'
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Shell>
      <PageHeader
        title="Compliance"
        subtitle="Hash-chained audit trail, privileged access, and session evidence."
      />

      {error ? <Alert kind="error">{error}</Alert> : null}

      {report ? (
        <div className="ops-kpi-row">
          <Kpi icon="book" label="Audit entries" value={report.audit.total.toLocaleString()} />
          <Kpi icon="clock" tone="tone-info" label="Audit (24h)" value={report.audit.last24h} />
          <Kpi icon="shield" tone={report.audit.integrityOk ? 'tone-ok' : 'tone-crit'} label="Integrity" value={report.audit.integrityOk ? 'Intact' : 'Broken'} />
          <Kpi icon="key" tone="tone-warn" label="JIT active" value={report.jit.active} sub={`${report.jit.total} total grants`} />
          <Kpi icon="monitor" label="Video recordings" value={report.recordings.video} sub={`${report.recordings.sessions} sessions`} />
        </div>
      ) : null}

      <div className="tabs">
        <button type="button" className={`tab ${tab === 'overview' ? 'active' : ''}`} onClick={() => setTab('overview')}>Overview</button>
        <button type="button" className={`tab ${tab === 'audit' ? 'active' : ''}`} onClick={() => setTab('audit')}>
          Audit log {entries ? <span className="tab-count">{entries.length}</span> : null}
        </button>
      </div>

      {tab === 'overview' ? (
        report ? (
          <>
            <div className={`ops-integrity ${report.audit.integrityOk ? 'ok' : 'bad'}`}>
              <span className={`ops-kpi-icon ${report.audit.integrityOk ? 'tone-ok' : 'tone-crit'}`} style={{ width: 40, height: 40 }}><Icon name="shield" size={20} /></span>
              <div>
                <strong>{report.audit.integrityOk ? 'Audit chain verified' : 'Audit chain integrity broken'}</strong>
                <small>
                  {report.audit.integrityOk
                    ? `Every entry in the hash chain links correctly across ${report.audit.total.toLocaleString()} records.`
                    : report.audit.brokenAtId
                      ? `The chain breaks at entry #${report.audit.brokenAtId}. Investigate immediately.`
                      : 'Run verification to locate the break.'}
                </small>
              </div>
              <button type="button" className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }} disabled={busy} onClick={() => void runVerify()}>
                <Icon name="refresh" size={14} />{busy ? 'Verifying…' : 'Verify chain'}
              </button>
            </div>

            {verified ? (
              <Alert kind={verified.ok ? 'info' : 'error'}>
                {verified.ok ? `Hash chain verified across ${verified.total} entries.` : `Chain integrity broken — ${verified.total} entries present.`}
              </Alert>
            ) : null}

            <div className="ops-kpi-row" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
              <div className="ops-kpi">
                <div className="ops-kpi-head"><span className="ops-kpi-icon tone-warn"><Icon name="key" size={16} /></span></div>
                <span className="ops-kpi-value">{report.jit.active}<span className="ops-kpi-sub" style={{ display: 'inline', marginLeft: 8, fontSize: 12 }}>active</span></span>
                <span className="ops-kpi-label">Privileged access grants</span>
                <span className="ops-kpi-sub">{report.jit.approved} approved · {report.jit.revoked} revoked</span>
              </div>
              <div className="ops-kpi">
                <div className="ops-kpi-head"><span className="ops-kpi-icon tone-info"><Icon name="monitor" size={16} /></span></div>
                <span className="ops-kpi-value">{report.recordings.video}</span>
                <span className="ops-kpi-label">Session recordings</span>
                <span className="ops-kpi-sub">{report.recordings.metadata} metadata-only</span>
              </div>
            </div>
          </>
        ) : (
          <div className="etch" style={{ padding: 24 }}>Loading compliance overview…</div>
        )
      ) : (
        <>
          <div className="ops-toolbar">
            <input className="field-input mono" placeholder="Action prefix (e.g. ticket.)" value={action} onChange={(e) => setAction(e.target.value)} aria-label="Filter by action" />
            <input className="field-input mono" placeholder="Object type (e.g. ticket)" value={objectType} onChange={(e) => setObjectType(e.target.value)} aria-label="Filter by object type" />
            <span className="spacer" />
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void runVerify()}><Icon name="shield" size={14} />Verify chain</button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void doExport()}><Icon name="download" size={14} />Export CSV</button>
          </div>

          {entries === null ? (
            <span className="etch">Loading audit log…</span>
          ) : entries.length === 0 ? (
            <div className="ops-empty"><strong>No audit entries</strong><span>No entries match the current filters.</span></div>
          ) : (
            <div className="ops-table-wrap">
              <table className="ops-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Actor</th>
                    <th>Action</th>
                    <th>Object</th>
                    <th>IP</th>
                    <th>Hash</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e) => (
                    <tr key={e.id}>
                      <td className="mono muted" style={{ whiteSpace: 'nowrap' }}>{new Date(e.created_at).toLocaleString()}</td>
                      <td>{e.actor_name ?? e.actor_type}</td>
                      <td><span className="mono">{e.action}</span></td>
                      <td className="mono muted">{e.object_type ? `${e.object_type}${e.object_id ? `:${String(e.object_id).slice(0, 8)}` : ''}` : '—'}</td>
                      <td className="mono muted">{e.ip ?? '—'}</td>
                      <td className="mono muted">{e.entry_hash.slice(0, 12)}…</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {nextCursor ? (
                <div className="form-actions">
                  <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void loadEntries(nextCursor)}>Load older</button>
                </div>
              ) : null}
            </div>
          )}
        </>
      )}
    </Shell>
  )
}
