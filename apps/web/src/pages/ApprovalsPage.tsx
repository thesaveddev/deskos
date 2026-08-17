import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Shell } from '../components/Shell.js'
import { Alert } from '../components/ui.js'
import { decideApproval, listMyApprovals, type Approval } from '../lib/catalogue.js'

export default function ApprovalsPage() {
  const [items, setItems] = useState<Approval[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setItems((await listMyApprovals()).approvals)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load approvals')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function decide(item: Approval, decision: 'approved' | 'rejected') {
    setBusyId(item.id)
    setError(null)
    setNotice(null)
    try {
      await decideApproval(item.ticket_id, item.id, decision)
      setNotice(`Request #${item.number} ${decision}.`)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Decision failed')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Shell>
      <div className="page-head">
        <h1 className="page-title">Approvals</h1>
      </div>

      {error ? <Alert kind="error">{error}</Alert> : null}
      {notice ? <Alert kind="info">{notice}</Alert> : null}

      <section className="form-panel" style={{ maxWidth: 720 }}>
        {items === null ? (
          <span className="etch">Loading approvals…</span>
        ) : items.length === 0 ? (
          <p className="muted">Nothing awaiting your approval.</p>
        ) : (
          <ul className="channel-list">
            {items.map((a) => (
              <li key={a.id} className="channel-card">
                <div className="channel-main">
                  <span className="channel-name">
                    #{a.number} — {a.subject}
                  </span>
                  <span className="channel-meta mono">
                    {a.type} · requested by {a.requested_by_name ?? '—'}
                  </span>
                </div>
                <div className="channel-actions">
                  <Link className="btn btn-ghost btn-sm" to={`/tickets/${a.ticket_id}`}>View</Link>
                  <button className="btn btn-primary btn-sm" disabled={busyId === a.id} onClick={() => void decide(a, 'approved')}>Approve</button>
                  <button className="btn btn-ghost btn-sm" disabled={busyId === a.id} onClick={() => void decide(a, 'rejected')}>Reject</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </Shell>
  )
}
