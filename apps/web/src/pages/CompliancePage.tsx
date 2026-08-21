import { useCallback, useEffect, useState } from 'react'
import { Shell } from '../components/Shell.js'
import { Alert } from '../components/ui.js'
import { getAccessToken, getActiveTenant } from '../lib/api.js'
import { auditExportUrl, getComplianceReport, listAudit, verifyAudit, type AuditEntry, type ComplianceReport } from '../lib/audit.js'

export default function CompliancePage() {
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
      if (tenant) headers['x-deskos-tenant'] = tenant
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
      <div className="page-head">
        <h1 className="page-title">Compliance</h1>
      </div>

      {error ? <Alert kind="error">{error}</Alert> : null}

      {report ? (
        <div className="stat-row">
          <StatCard label="Audit entries" value={report.audit.total} />
          <StatCard label="Audit (24h)" value={report.audit.last24h} />
          <StatCard label="Integrity" value={report.audit.integrityOk ? 1 : 0} tone={report.audit.integrityOk ? 'ok' : 'crit'} />
          <StatCard label="JIT active" value={report.jit.active} tone={report.jit.active ? 'warn' : 'muted'} />
          <StatCard label="Video recordings" value={report.recordings.video} />
        </div>
      ) : null}

      <div className="kb-toolbar" style={{ marginBottom: 16 }}>
        <input className="field-input mono" placeholder="Action prefix (e.g. ticket.)" value={action} onChange={(e) => setAction(e.target.value)} />
        <input className="field-input mono" placeholder="Object type (e.g. ticket)" value={objectType} onChange={(e) => setObjectType(e.target.value)} />
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void runVerify()}>Verify chain</button>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void doExport()}>Export CSV</button>
      </div>

      {verified ? (
        <Alert kind={verified.ok ? 'info' : 'error'}>
          {verified.ok ? `Hash chain verified across ${verified.total} entries.` : `Chain integrity broken — ${verified.total} entries present.`}
        </Alert>
      ) : null}

      {entries === null ? (
        <span className="etch">Loading audit log…</span>
      ) : entries.length === 0 ? (
        <p className="muted">No audit entries match.</p>
      ) : (
        <div className="queue-table">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Object</th>
                <th>IP</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td className="col-updated muted mono">{new Date(e.created_at).toLocaleString()}</td>
                  <td>{e.actor_name ?? e.actor_type}</td>
                  <td className="mono">{e.action}</td>
                  <td className="mono muted">{e.object_type ? `${e.object_type}${e.object_id ? `:${String(e.object_id).slice(0, 8)}` : ''}` : '—'}</td>
                  <td className="mono muted">{e.ip ?? '—'}</td>
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
    </Shell>
  )
}

function StatCard({ label, value, tone = 'default' }: { label: string; value: number; tone?: 'default' | 'ok' | 'crit' | 'warn' | 'muted' }) {
  const cls = tone === 'crit' ? ' sla-crit' : tone === 'ok' ? ' sla-ok' : tone === 'warn' ? ' sla-warn' : ''
  return (
    <div className="stat-card">
      <span className={`stat-value mono${cls}`}>{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  )
}
