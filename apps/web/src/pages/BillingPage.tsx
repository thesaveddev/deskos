import { useEffect, useMemo, useState } from 'react'
import { Icon } from '../components/Icons.js'
import { Alert, Field, Modal, PageHeader, Panel } from '../components/ui.js'
import { Shell } from '../components/Shell.js'
import { useAuth } from '../lib/auth.js'
import {
  listPlans, getSubscription, changePlan, cancelSubscription,
  listInvoices, listPaymentMethods, removePaymentMethod, setDefaultPaymentMethod,
  formatCents,
  type Plan, type Subscription, type Invoice, type PaymentMethod,
} from '../lib/billing.js'

function StatusBadge({ status }: { status: string }) {
  const cls = status === 'active' ? 'dot-online' : status === 'trialing' ? 'dot-active' : status === 'past_due' ? 'dot-open' : 'dot-closed'
  return <span className={`status-pill status-${status}`}><span className={`status-dot ${cls}`} />{status}</span>
}

function CardBrand({ brand }: { brand: string }) {
  const icons: Record<string, string> = { visa: '💳', mastercard: '💳', amex: '💳', discover: '💳' }
  return <span>{icons[brand.toLowerCase()] || '💳'}</span>
}

export default function BillingPage() {
  const auth = useAuth()
  const isOwner = auth.memberships.some((m) => m.tenant.id === auth.activeTenantId && m.orgRole === 'owner')

  const [plans, setPlans] = useState<Plan[]>([])
  const [sub, setSub] = useState<Subscription | null>(null)
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [methods, setMethods] = useState<PaymentMethod[]>([])
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
      listPlans(),
      getSubscription(),
      listInvoices(),
      listPaymentMethods(),
    ]).then(([p, s, i, pm]) => {
      if (p.status === 'fulfilled') setPlans(p.value.plans)
      if (s.status === 'fulfilled') setSub(s.value.subscription)
      if (i.status === 'fulfilled') setInvoices(i.value.invoices)
      if (pm.status === 'fulfilled') setMethods(pm.value.methods)
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
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not change plan') }
  }

  const handleAddCard = async () => {
    if (!newCard.last4 || newCard.last4.length < 4) return
    const { addPaymentMethod } = await import('../lib/billing.js')
    const { method } = await addPaymentMethod({
      brand: newCard.brand,
      last4: newCard.last4,
      exp_month: newCard.exp_month ? Number(newCard.exp_month) : undefined,
      exp_year: newCard.exp_year ? Number(newCard.exp_year) : undefined,
    })
    setMethods((prev) => [method, ...prev])
    setNewCard({ brand: 'visa', last4: '', exp_month: '', exp_year: '' })
    setShowAddCard(false)
  }

  const handleRemoveCard = async (id: number) => {
    await removePaymentMethod(id)
    setMethods((prev) => prev.filter((m) => m.id !== id))
  }

  const handleSetDefault = async (id: number) => {
    await setDefaultPaymentMethod(id)
    setMethods((prev) => prev.map((m) => ({ ...m, is_default: m.id === id })))
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
      <nav className="workspace-tabs billing-workspace-tabs" aria-label="Billing sections">
        {tabItems.map((tab) => <button key={tab.id} type="button" className={`workspace-tab${activeTab === tab.id ? ' active' : ''}`} onClick={() => setActiveTab(tab.id)}>{tab.label}{'count' in tab && tab.count !== undefined ? <span>{tab.count}</span> : null}</button>)}
      </nav>

      {/* Current plan */}
      <div className="billing-current">
        <div className="billing-current-info">
          <h3 className="billing-current-plan">{currentPlan?.name || 'Free'}</h3>
          {sub && <StatusBadge status={sub.status} />}
          {sub && (
            <p className="billing-current-period">
              Current period: {new Date(sub.current_period_start).toLocaleDateString()} — {new Date(sub.current_period_end).toLocaleDateString()}
            </p>
          )}
          {sub?.trial_ends_at && sub.status === 'trialing' && (
            <p className="billing-current-period">Trial ends: {new Date(sub.trial_ends_at).toLocaleDateString()}</p>
          )}
        </div>
        {sub && sub.status !== 'canceled' && isOwner && (
          <button className="btn btn-ghost btn-danger" onClick={() => setShowCancel(true)}>Cancel subscription</button>
        )}
      </div>

      {activeTab === 'overview' ? <div className="billing-overview-grid"><Panel title="Plan at a glance" subtitle="Your current subscription and included capabilities."><div className="billing-glance"><strong>{currentPlan?.name || 'Free'}</strong><span>{sub?.status ? <StatusBadge status={sub.status} /> : 'No active subscription'}</span><small>{sub ? `Renews ${new Date(sub.current_period_end).toLocaleDateString()}` : 'Choose a plan to unlock team billing features.'}</small></div><div className="billing-feature-list">{usedFeatures.map((feature) => <span key={feature}><Icon name="check" size={13} />{feature}</span>)}</div></Panel><Panel title="Billing actions" subtitle="Common account actions for organization owners."><div className="billing-action-list"><button className="btn btn-ghost btn-sm" onClick={() => setActiveTab('plans')}><Icon name="key" size={14} />Compare plans</button><button className="btn btn-ghost btn-sm" onClick={() => setActiveTab('payment')}><Icon name="key" size={14} />Manage payment methods</button><button className="btn btn-ghost btn-sm" onClick={() => setActiveTab('invoices')}><Icon name="file" size={14} />View invoices</button></div></Panel></div> : null}

      {/* Plan switcher */}
      {activeTab === 'plans' && isOwner && (
        <div className="billing-cycle-toggle">
          <button className={`btn btn-sm ${cycle === 'monthly' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setCycle('monthly')}>Monthly</button>
          <button className={`btn btn-sm ${cycle === 'annual' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setCycle('annual')}>Annual <span className="billing-save">Save 17%</span></button>
        </div>
      )}

      {activeTab === 'plans' ? <div className="billing-plans">
        {plans.filter((p) => p.slug !== 'enterprise').map((plan) => {
          const isCurrent = sub?.plan_slug === plan.slug
          const p = price(plan)
          return (
            <div key={plan.id} className={`billing-plan-card ${isCurrent ? 'current' : ''}`}>
              {isCurrent && <div className="billing-plan-badge">Current plan</div>}
              <h3 className="billing-plan-name">{plan.name}</h3>
              <p className="billing-plan-desc">{plan.description}</p>
              <div className="billing-plan-price">
                {p === 0 ? 'Free' : <>{formatCents(p)}<span className="billing-plan-period">/{cycle === 'annual' ? 'mo' : 'month'}</span></>}
              </div>
              {plan.max_technicians > 0 && (
                <p className="billing-plan-limits">
                  {plan.max_technicians < 0 ? 'Unlimited' : plan.max_technicians} technicians · {plan.max_devices < 0 ? 'Unlimited' : plan.max_devices} devices
                </p>
              )}
              <ul className="billing-plan-features">
                {plan.features.map((f, i) => (
                  <li key={i}>✓ {f}</li>
                ))}
              </ul>
              {isOwner && !isCurrent && (
                <button
                  className="btn btn-primary billing-plan-btn"
                  onClick={() => handleChangePlan(plan.slug)}
                  disabled={changing === plan.slug}
                >
                  {changing === plan.slug ? 'Switching…' : sub ? 'Switch plan' : 'Get started'}
                </button>
              )}
            </div>
          )
        })}
        {/* Enterprise card */}
        <div className="billing-plan-card">
          <h3 className="billing-plan-name">Enterprise</h3>
          <p className="billing-plan-desc">Custom deployment for large organisations.</p>
          <div className="billing-plan-price">Custom</div>
          <p className="billing-plan-limits">Unlimited technicians · Unlimited devices</p>
          <ul className="billing-plan-features">
            <li>✓ Everything in Pro</li>
            <li>✓ SAML SSO + SCIM</li>
            <li>✓ Custom integrations</li>
            <li>✓ Dedicated support</li>
          </ul>
          <a href="/contact" className="btn btn-ghost billing-plan-btn">Contact sales</a>
        </div>
      </div> : null}

      {/* Payment methods */}
      {activeTab === 'payment' ? <div className="billing-section"> 
        <div className="billing-section-header">
          <h2 className="billing-section-title">Payment methods</h2>
          {isOwner && <button className="btn btn-ghost btn-sm" onClick={() => setShowAddCard(!showAddCard)}>{showAddCard ? 'Cancel' : '+ Add card'}</button>}
        </div>

        {showAddCard && (
          <div className="billing-add-card">
            <select className="field-input" value={newCard.brand} onChange={(e) => setNewCard((p) => ({ ...p, brand: e.target.value }))}>
              <option value="visa">Visa</option>
              <option value="mastercard">Mastercard</option>
              <option value="amex">American Express</option>
            </select>
            <input className="field-input" placeholder="Last 4 digits" value={newCard.last4} onChange={(e) => setNewCard((p) => ({ ...p, last4: e.target.value }))} maxLength={4} />
            <input className="field-input" placeholder="MM" value={newCard.exp_month} onChange={(e) => setNewCard((p) => ({ ...p, exp_month: e.target.value }))} maxLength={2} style={{ maxWidth: 60 }} />
            <input className="field-input" placeholder="YY" value={newCard.exp_year} onChange={(e) => setNewCard((p) => ({ ...p, exp_year: e.target.value }))} maxLength={2} style={{ maxWidth: 60 }} />
            <button className="btn btn-primary btn-sm" onClick={handleAddCard}>Save</button>
          </div>
        )}

        {methods.length === 0 ? (
          <p className="dash-empty">No payment methods on file</p>
        ) : (
          <div className="billing-methods-list">
            {methods.map((m) => (
              <div key={m.id} className="billing-method-row">
                <CardBrand brand={m.brand} />
                <span className="billing-method-details">
                  {m.brand.toUpperCase()} •••• {m.last4}
                  {m.exp_month && m.exp_year && <span className="muted"> · Expires {m.exp_month}/{m.exp_year}</span>}
                </span>
                {m.is_default && <span className="status-pill status-active">Default</span>}
                {isOwner && (
                  <div className="billing-method-actions">
                    {!m.is_default && <button className="btn btn-ghost btn-xs" onClick={() => handleSetDefault(m.id)}>Set default</button>}
                    <button className="btn btn-ghost btn-xs btn-danger" onClick={() => handleRemoveCard(m.id)}>Remove</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div> : null}

      {/* Invoices */}
      {activeTab === 'invoices' ? <div className="billing-section">
        <div className="billing-section-header"><div><h2 className="billing-section-title">Invoices</h2><p className="billing-section-subtitle">A record of subscription charges for this organization.</p></div></div>
        {invoices.length === 0 ? (
          <p className="dash-empty">No invoices yet</p>
        ) : (
          <div className="billing-invoices-table">
            <div className="billing-invoices-header">
              <span>Invoice</span>
              <span>Date</span>
              <span>Amount</span>
              <span>Status</span>
            </div>
            {invoices.map((inv) => (
              <div key={inv.id} className="billing-invoice-row">
                <span className="mono">{inv.number}</span>
                <span>{new Date(inv.created_at).toLocaleDateString()}</span>
                <span className="mono">{formatCents(inv.amount_cents)}</span>
                <StatusBadge status={inv.status} />
              </div>
            ))}
          </div>
        )}
      </div> : null}

      {/* Cancel modal */}
      {showCancel && (
        <div className="modal-backdrop" onClick={() => setShowCancel(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Cancel subscription?</h3>
            <p className="modal-desc">
              Your subscription will remain active until the end of the current billing period ({sub ? new Date(sub.current_period_end).toLocaleDateString() : '—'}).
              After that, your account will be downgraded to the Free plan.
            </p>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setShowCancel(false)}>Keep subscription</button>
              <button className="btn btn-danger" onClick={handleCancel}>Cancel subscription</button>
            </div>
          </div>
        </div>
      )}
    </Shell>
  )
}
