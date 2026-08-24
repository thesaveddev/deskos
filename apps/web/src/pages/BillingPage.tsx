import { useEffect, useMemo, useState } from 'react'
import { Icon } from '../components/Icons.js'
import { Alert, Field, Modal, PageHeader, Panel } from '../components/ui.js'
import { Shell } from '../components/Shell.js'
import { useAuth } from '../lib/auth.js'
import {
  listPlans, getSubscription, changePlan, cancelSubscription,
  listInvoices, listPaymentMethods, removePaymentMethod, setDefaultPaymentMethod,
  addPaymentMethod, formatCents,
  type Plan, type Subscription, type Invoice, type PaymentMethod,
} from '../lib/billing.js'

function StatusBadge({ status }: { status: string }) {
  const cls = status === 'active' ? 'dot-online' : status === 'trialing' ? 'dot-active' : status === 'past_due' ? 'dot-open' : 'dot-closed'
  return <span className={`status-pill status-${status}`}><span className={`status-dot ${cls}`} />{status.replace('_', ' ')}</span>
}

function CardBrand({ brand }: { brand: string }) {
  const icons: Record<string, string> = { visa: 'VISA', mastercard: 'MC', amex: 'AMEX', discover: 'DISC' }
  const cls: Record<string, string> = { visa: 'card-brand visa', mastercard: 'card-brand mc', amex: 'card-brand amex', discover: 'card-brand disc' }
  return <span className={cls[brand.toLowerCase()] || 'card-brand'}>{icons[brand.toLowerCase()] || 'CARD'}</span>
}

/** Simple share-of-limit bar for technician/device caps. */
function LimitBar({ label, used, max }: { label: string; used: number; max: number }) {
  if (max <= 0) return <div className="billing-limit-row"><span className="billing-limit-label">{label}</span><span className="billing-limit-value">Unlimited</span></div>
  const pct = Math.min(100, Math.round((used / max) * 100))
  return (
    <div className="billing-limit-row">
      <span className="billing-limit-label">{label}</span>
      <div className="billing-limit-track"><span className="billing-limit-fill" style={{ width: `${pct}%` }} /></div>
      <span className="billing-limit-value mono">{used} / {max}</span>
    </div>
  )
}

export default function BillingPage() {
  const auth = useAuth()
  const isOwner = auth.memberships.some((m) => m.tenant.id === auth.activeTenantId && m.orgRole === 'owner')

  const [plans, setPlans] = useState<Plan[]>([])
  const [sub, setSub] = useState<Subscription | null>(null)
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [methods, setMethods] = useState<PaymentMethod[]>([])
  const [staffCount, setStaffCount] = useState(0)
  const [deviceCount, setDeviceCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [cycle, setCycle] = useState<'monthly' | 'annual'>('monthly')
  const [changing, setChanging] = useState<string | null>(null)
  const [showCancel, setShowCancel] = useState(false)
  const [showAddCard, setShowAddCard] = useState(false)
  const [newCard, setNewCard] = useState({ brand: 'visa', last4: '', exp_month: '', exp_year: '' })
  const [activeTab, setActiveTab] = useState<'overview' | 'plans' | 'payment' | 'invoices'>('overview')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    Promise.allSettled([
      listPlans(), getSubscription(), listInvoices(), listPaymentMethods(),
      fetch('/api/v1/members').then((r) => r.json() as Promise<{ members?: unknown[] }>),
      fetch('/api/v1/devices?pageSize=1').then((r) => r.json() as Promise<{ total?: number }>),
    ]).then(([p, s, i, pm, m, d]) => {
      if (p.status === 'fulfilled') setPlans(p.value.plans)
      if (s.status === 'fulfilled') setSub(s.value.subscription)
      if (i.status === 'fulfilled') setInvoices(i.value.invoices)
      if (pm.status === 'fulfilled') setMethods(pm.value.methods)
      if (m.status === 'fulfilled') setStaffCount(m.value.members?.length ?? 0)
      if (d.status === 'fulfilled') setDeviceCount(d.value.total ?? 0)
    }).finally(() => setLoading(false))
  }, [])

  const handleChangePlan = async (slug: string) => {
    if (!isOwner) return
    setChanging(slug)
    try {
      if (sub) {
        const { subscription } = await changePlan(slug)
        setSub(subscription)
      } else {
        const { subscription } = await (await import('../lib/billing.js')).createSubscription(slug, cycle)
        setSub(subscription)
      }
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not change plan') }
    setChanging(null)
  }

  const handleCancel = async () => {
    if (!isOwner) return
    try {
      await cancelSubscription()
      setSub((prev) => prev ? { ...prev, status: 'canceled' } : null)
      setShowCancel(false)
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not cancel plan') }
  }

  const handleAddCard = async () => {
    if (!newCard.last4 || newCard.last4.length < 4) return
    try {
      const { method } = await addPaymentMethod({
        brand: newCard.brand,
        last4: newCard.last4,
        exp_month: newCard.exp_month ? Number(newCard.exp_month) : undefined,
        exp_year: newCard.exp_year ? Number(newCard.exp_year) : undefined,
      })
      setMethods((prev) => [method, ...prev])
      setNewCard({ brand: 'visa', last4: '', exp_month: '', exp_year: '' })
      setShowAddCard(false)
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not add payment method') }
  }

  const handleRemoveCard = async (id: number) => {
    try {
      await removePaymentMethod(id)
      setMethods((prev) => prev.filter((m) => m.id !== id))
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not remove payment method') }
  }

  const handleSetDefault = async (id: number) => {
    try {
      await setDefaultPaymentMethod(id)
      setMethods((prev) => prev.map((m) => ({ ...m, is_default: m.id === id })))
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not update default') }
  }

  const currentPlan = plans.find((p) => p.slug === sub?.plan_slug)
  const price = (plan: Plan) => cycle === 'annual' ? plan.price_annual_cents : plan.price_monthly_cents
  const usedFeatures = useMemo(() => currentPlan?.features.slice(0, 4) ?? [], [currentPlan])
  const tabItems = [
    { id: 'overview', label: 'Overview' },
    { id: 'plans', label: 'Plans & usage' },
    { id: 'payment', label: 'Payment methods', count: methods.length },
    { id: 'invoices', label: 'Invoices', count: invoices.length },
  ] as const

  if (loading) {
    return (
      <Shell>
        <div className="page-head"><h1 className="page-title">Billing</h1></div>
        <div className="dash-loading"><div className="loading-spinner" /><p>Loading billing…</p></div>
      </Shell>
    )
  }

  return (
    <Shell>
      <PageHeader title="Billing & subscription" subtitle="Manage your plan, payment methods, and billing history for this organization." actions={isOwner ? <span className="billing-owner-badge"><Icon name="shield" size={13} />Owner access</span> : <span className="muted">Read-only billing view</span>} />
      {error ? <Alert kind="error">{error}</Alert> : null}
      {notice ? <Alert kind="info">{notice}</Alert> : null}

      {/* Current plan hero */}
      <div className="billing-hero">
        <div className="billing-hero-main">
          <span className="settings-eyebrow">Current plan</span>
          <div className="billing-hero-title"><h3>{currentPlan?.name || 'Free'}</h3>{sub ? <StatusBadge status={sub.status} /> : <span className="status-pill status-draft">No subscription</span>}</div>
          <p className="billing-hero-desc">{currentPlan?.description ?? 'Choose a plan to unlock team billing features.'}</p>
          <div className="billing-hero-meta">
            {currentPlan ? <span><Icon name="check" size={13} />{currentPlan.max_technicians < 0 ? 'Unlimited' : `${currentPlan.max_technicians}`} technicians</span> : null}
            {currentPlan ? <span><Icon name="check" size={13} />{currentPlan.max_devices < 0 ? 'Unlimited' : `${currentPlan.max_devices}`} devices</span> : null}
            {sub ? <span><Icon name="clock" size={13} />Renews {new Date(sub.current_period_end).toLocaleDateString()}</span> : null}
            {sub?.trial_ends_at && sub.status === 'trialing' ? <span><Icon name="clock" size={13} />Trial ends {new Date(sub.trial_ends_at).toLocaleDateString()}</span> : null}
          </div>
          <div className="billing-hero-limits">
            <LimitBar label="Technicians" used={staffCount} max={currentPlan?.max_technicians ?? 1} />
            <LimitBar label="Devices" used={deviceCount} max={currentPlan?.max_devices ?? 5} />
          </div>
        </div>
        <div className="billing-hero-actions">
          <button className="btn btn-ghost btn-sm" onClick={() => setActiveTab('plans')}><Icon name="settings" size={14} />Compare plans</button>
          {sub && sub.status !== 'canceled' && isOwner ? <button className="btn btn-ghost btn-sm btn-danger" onClick={() => setShowCancel(true)}>Cancel subscription</button> : null}
        </div>
      </div>

      <nav className="workspace-tabs billing-workspace-tabs" aria-label="Billing sections">
        {tabItems.map((tab) => <button key={tab.id} type="button" className={`workspace-tab${activeTab === tab.id ? ' active' : ''}`} onClick={() => setActiveTab(tab.id)}>{tab.label}{'count' in tab && tab.count !== undefined ? <span>{tab.count}</span> : null}</button>)}
      </nav>

      {activeTab === 'overview' ? <div className="billing-overview-grid">
        <Panel title="Plan at a glance" subtitle="Your current subscription and included capabilities.">
          <div className="billing-glance">
            <strong>{currentPlan?.name || 'Free'}</strong>
            <span>{sub?.status ? <StatusBadge status={sub.status} /> : 'No active subscription'}</span>
            <small>{sub ? `Renews ${new Date(sub.current_period_end).toLocaleDateString()}` : 'Choose a plan to unlock team billing features.'}</small>
          </div>
          <div className="billing-feature-list">{usedFeatures.map((feature) => <span key={feature}><Icon name="check" size={13} />{feature}</span>)}</div>
        </Panel>
        <Panel title="Billing actions" subtitle="Common account actions for organization owners.">
          <div className="billing-action-list">
            <button className="btn btn-ghost btn-sm" onClick={() => setActiveTab('plans')}><Icon name="settings" size={14} />Compare plans</button>
            <button className="btn btn-ghost btn-sm" onClick={() => setActiveTab('payment')}><Icon name="key" size={14} />Manage payment methods</button>
            <button className="btn btn-ghost btn-sm" onClick={() => setActiveTab('invoices')}><Icon name="file" size={14} />View invoices</button>
          </div>
        </Panel>
      </div> : null}

      {activeTab === 'plans' && isOwner ? (
        <div className="billing-cycle-toggle">
          <button className={`btn btn-sm ${cycle === 'monthly' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setCycle('monthly')}>Monthly</button>
          <button className={`btn btn-sm ${cycle === 'annual' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setCycle('annual')}>Annual <span className="billing-save">Save 17%</span></button>
        </div>
      ) : null}

      {activeTab === 'plans' ? <div className="billing-plans">
        {plans.filter((p) => p.slug !== 'enterprise').map((plan) => {
          const isCurrent = sub?.plan_slug === plan.slug
          const p = price(plan)
          const recommended = plan.slug === 'pro'
          return (
            <div key={plan.id} className={`billing-plan-card ${isCurrent ? 'current' : ''}${recommended && !isCurrent ? ' recommended' : ''}`}>
              {isCurrent ? <div className="billing-plan-badge">Current plan</div> : recommended ? <div className="billing-plan-badge billing-plan-badge-recommended">Most popular</div> : null}
              <h3 className="billing-plan-name">{plan.name}</h3>
              <p className="billing-plan-desc">{plan.description}</p>
              <div className="billing-plan-price">
                {p === 0 ? 'Free' : <>{formatCents(p)}<span className="billing-plan-period">/{cycle === 'annual' ? 'mo' : 'month'}</span></>}
                {p !== 0 && cycle === 'annual' ? <span className="billing-plan-annual">billed annually</span> : null}
              </div>
              {plan.max_technicians > 0 ? (
                <p className="billing-plan-limits">{plan.max_technicians < 0 ? 'Unlimited' : plan.max_technicians} technicians · {plan.max_devices < 0 ? 'Unlimited' : plan.max_devices} devices</p>
              ) : null}
              <ul className="billing-plan-features">
                {plan.features.map((f, i) => <li key={i}><Icon name="check" size={13} />{f}</li>)}
              </ul>
              {isOwner && !isCurrent ? (
                <button className="btn btn-primary billing-plan-btn" onClick={() => handleChangePlan(plan.slug)} disabled={changing === plan.slug}>
                  {changing === plan.slug ? 'Switching…' : sub ? 'Switch plan' : 'Get started'}
                </button>
              ) : isCurrent ? <button className="btn btn-ghost billing-plan-btn" disabled>Current plan</button> : null}
            </div>
          )
        })}
        <div className="billing-plan-card">
          <h3 className="billing-plan-name">Enterprise</h3>
          <p className="billing-plan-desc">Custom deployment for large organisations.</p>
          <div className="billing-plan-price">Custom</div>
          <p className="billing-plan-limits">Unlimited technicians · Unlimited devices</p>
          <ul className="billing-plan-features">
            <li><Icon name="check" size={13} />Everything in Pro</li>
            <li><Icon name="check" size={13} />SAML SSO + SCIM</li>
            <li><Icon name="check" size={13} />Custom integrations</li>
            <li><Icon name="check" size={13} />Dedicated support</li>
          </ul>
          <a href="/contact" className="btn btn-ghost billing-plan-btn">Contact sales</a>
        </div>
      </div> : null}

      {/* Payment methods */}
      {activeTab === 'payment' ? <div className="billing-section">
        <div className="billing-section-header">
          <div><h2 className="billing-section-title">Payment methods</h2><p className="billing-section-subtitle">Cards used to pay for subscription charges.</p></div>
          {isOwner && <button className="btn btn-primary btn-sm" onClick={() => setShowAddCard((open) => !open)}><Icon name="add" size={14} />{showAddCard ? 'Cancel' : 'Add card'}</button>}
        </div>
        {showAddCard ? (
          <div className="billing-add-card">
            <select className="field-input" value={newCard.brand} onChange={(e) => setNewCard((p) => ({ ...p, brand: e.target.value }))}>
              <option value="visa">Visa</option>
              <option value="mastercard">Mastercard</option>
              <option value="amex">American Express</option>
            </select>
            <input className="field-input" placeholder="Last 4 digits" value={newCard.last4} onChange={(e) => setNewCard((p) => ({ ...p, last4: e.target.value.replace(/\D/g, '').slice(0, 4) }))} maxLength={4} />
            <input className="field-input" placeholder="MM" value={newCard.exp_month} onChange={(e) => setNewCard((p) => ({ ...p, exp_month: e.target.value.replace(/\D/g, '').slice(0, 2) }))} maxLength={2} style={{ maxWidth: 60 }} />
            <input className="field-input" placeholder="YY" value={newCard.exp_year} onChange={(e) => setNewCard((p) => ({ ...p, exp_year: e.target.value.replace(/\D/g, '').slice(0, 2) }))} maxLength={2} style={{ maxWidth: 60 }} />
            <button className="btn btn-primary btn-sm" onClick={() => void handleAddCard()} disabled={newCard.last4.length < 4}>Add card</button>
          </div>
        ) : null}
        {methods.length === 0 ? (
          <p className="dash-empty">No payment methods on file.</p>
        ) : (
          <div className="billing-methods-list">
            {methods.map((m) => (
              <div key={m.id} className="billing-method-row">
                <CardBrand brand={m.brand} />
                <span className="billing-method-details">
                  {m.brand.toUpperCase()} •••• {m.last4}
                  {m.exp_month && m.exp_year ? <span className="muted"> · Expires {m.exp_month}/{m.exp_year}</span> : null}
                </span>
                {m.is_default && <span className="status-pill status-active">Default</span>}
                {isOwner ? (
                  <div className="billing-method-actions">
                    {!m.is_default && <button className="btn btn-ghost btn-xs" onClick={() => void handleSetDefault(m.id)}>Set default</button>}
                    <button className="btn btn-ghost btn-xs btn-danger" onClick={() => void handleRemoveCard(m.id)}>Remove</button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div> : null}

      {/* Invoices */}
      {activeTab === 'invoices' ? <div className="billing-section">
        <div className="billing-section-header">
          <div><h2 className="billing-section-title">Invoices</h2><p className="billing-section-subtitle">A record of subscription charges for this organization.</p></div>
        </div>
        {invoices.length === 0 ? (
          <p className="dash-empty">No invoices yet.</p>
        ) : (
          <div className="billing-invoices-table">
            <div className="billing-invoices-header">
              <span>Invoice</span><span>Date</span><span>Amount</span><span>Status</span>
            </div>
            {invoices.map((inv) => (
              <div key={inv.id} className="billing-invoice-row">
                <span className="mono">#{inv.number}</span>
                <span>{new Date(inv.created_at).toLocaleDateString()}</span>
                <span className="mono">{formatCents(inv.amount_cents)}</span>
                <StatusBadge status={inv.status} />
              </div>
            ))}
          </div>
        )}
      </div> : null}

      {showCancel ? (
        <div className="modal-backdrop" onClick={() => setShowCancel(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Cancel subscription?</h3>
            <p className="modal-desc">
              Your subscription will remain active until the end of the current billing period ({sub ? new Date(sub.current_period_end).toLocaleDateString() : '—'}).
              After that, your account will be downgraded to the Free plan.
            </p>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setShowCancel(false)}>Keep subscription</button>
              <button className="btn btn-danger" onClick={() => void handleCancel()}>Cancel subscription</button>
            </div>
          </div>
        </div>
      ) : null}
    </Shell>
  )
}