import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Shell } from '../components/Shell.js'
import { Alert, PageHeader, useConfirm } from '../components/ui.js'
import { Icon } from '../components/Icons.js'
import { decideApproval, listMyApprovals, type Approval } from '../lib/catalogue.js'

export default function ApprovalsPage() {
  const [items, setItems] = useState<Approval[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const confirm = useConfirm()

  const load = useCallback(async () => {
    setRefreshing(true)
    try { setItems((await listMyApprovals()).approvals); setError(null) }
    catch (err) { setError(err instanceof Error ? err.message : 'Failed to load approvals') }
    finally { setRefreshing(false) }
  }, [])

  useEffect(() => { void load() }, [load])

  async function decide(item: Approval, decision: 'approved' | 'rejected') {
    if (decision === 'rejected' && !await confirm(`Reject request #${item.number}?`, { title: 'Reject approval request', confirmLabel: 'Reject', destructive: true })) return
    setBusyId(item.id); setError(null); setNotice(null)
    try {
      await decideApproval(item.ticket_id, item.id, decision)
      setNotice(`Request #${item.number} ${decision}.`)
      await load()
    } catch (err) { setError(err instanceof Error ? err.message : 'Decision failed') }
    finally { setBusyId(null) }
  }

  const count = items?.length ?? 0
  return <Shell>
    <PageHeader title="Approvals" subtitle="Review service, change, and access requests that need your decision." actions={<button className="btn btn-ghost btn-sm" onClick={() => void load()} disabled={refreshing}><Icon name="refresh" size={14} />{refreshing ? 'Refreshing…' : 'Refresh'}</button>} />
    {error ? <Alert kind="error">{error}</Alert> : null}
    {notice ? <Alert kind="info">{notice}</Alert> : null}
    <div className="approval-summary"><div><strong>{count}</strong><span>Awaiting your decision</span></div><div><strong>{items?.filter((item) => item.type === 'change').length ?? 0}</strong><span>Change requests</span></div><div><strong>{items?.filter((item) => item.type !== 'change').length ?? 0}</strong><span>Service / access requests</span></div></div>
    <section className="panel approval-panel">
      <div className="panel-head"><div><h2 className="panel-title">Decision queue</h2><p className="panel-sub">Approvals are recorded in the ticket audit trail and notify the requester.</p></div></div>
      <div className="panel-body">{items === null ? <span className="etch">Loading approvals…</span> : items.length === 0 ? <div className="empty-state"><Icon name="check" size={24} /><strong>All caught up</strong><span>Nothing is awaiting your approval.</span></div> : <ul className="channel-list">{items.map((item) => <li key={item.id} className="channel-card approval-card"><div className="channel-main"><span className="channel-name">#{item.number} — {item.subject}</span><span className="channel-meta mono">{item.type} · requested by {item.requested_by_name ?? '—'}</span></div><div className="channel-actions"><Link className="btn btn-ghost btn-sm" to={`/tickets/${item.ticket_id}`}><Icon name="eye" size={14} />View ticket</Link><button className="btn btn-primary btn-sm" disabled={busyId === item.id} onClick={() => void decide(item, 'approved')}><Icon name="check" size={14} />Approve</button><button className="btn btn-ghost btn-sm" disabled={busyId === item.id} onClick={() => void decide(item, 'rejected')}><Icon name="close" size={14} />Reject</button></div></li>)}</ul>}</div>
    </section>
  </Shell>
}
