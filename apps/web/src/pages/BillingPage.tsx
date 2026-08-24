import { useCallback, useEffect, useMemo, useState } from 'react'
import { Icon } from '../components/Icons.js'
import { Alert, PageHeader, Panel } from '../components/ui.js'
import { Shell } from '../components/Shell.js'
import { useAuth } from '../lib/auth.js'
import {
  listPlans, getSubscription, createSubscription, changePlan, cancelSubscription,
  listInvoices, listPaymentMethods, removePaymentMethod, setDefaultPaymentMethod,
  addPaymentMethod, getBillingMeta, setBillingCountry, startCheckout, checkoutStatus,
  formatCents,
  type Plan, type Subscription, type Invoice, type PaymentMethod,
  type GatewayInfo,
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

function GatewayBadge({ slug }: { slug: string }) {
  return <span className={`gateway-badge gateway-${slug}`}>{slug === 'paystack' ? 'Paystack' : slug === 'stripe' ? 'Stripe' : 'Invoice'}</span>
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

  // ── Region-aware billing ───────────────────────────────────
  const [meta, setMeta] = useState<{ country: string; detectedCountry: string; currency: string | null; gateways: GatewayInfo[]; countries: Array<{ code: string; name: string; gateway: string }>; paystackPublicKey: string } | null>(null)
  const [regionDraft, setRegionDraft] = useState('')
  const [savingRegion, setSavingRegion] = useState(false)
  // Checkout modal state
  const [checkoutPlan, setCheckoutPlan] = useState<Plan | null>(null)
  const [checkoutGateway, setCheckoutGateway] = useState<string>('auto')
  const [checkoutMethod, setCheckoutMethod] = useState<string>('')
  const [startingCheckout, setStartingCheckout] = useState(false)

  const refreshBilling = useCallback(async () => {
    const [s, i, pm] = await Promise.allSettled([getSubscription(), listInvoices(), listPaymentMethods()])
    if (s.status === 'fulfilled') setSub(s.value.subscription)
    if (i.status === 'fulfilled') setInvoices(i.value.invoices)
    if (pm.status === 'fulfilled') setMethods(pm.value.methods)
  }, [])

  useEffect(() => {
    Promise.allSettled([
      listPlans(), getSubscription(), listInvoices(), listPaymentMethods(), getBillingMeta(),
      fetch('/api/v1/members').then((r) => r.json() as Promise<{ members?: unknown[] }>),
      fetch('/api/v1/devices?pageSize=1').then((r) => r.json() as Promise<{ total?: number }>),
    ]).then(([p, s, i, pm, m, mem, d]) => {
      if (p.status === 'fulfilled') setPlans(p.value.plans)
      if (s.status === 'fulfilled') setSub(s.value.subscription)
      if (i.status === 'fulfilled') setInvoices(i.value.invoices)
      if (pm.status === 'fulfilled') setMethods(pm.value.methods)
      if (m.status === 'fulfilled') { setMeta(m.value); setRegionDraft(m.value.country || m.value.detectedCountry || 'US') }
      if (mem.status === 'fulfilled') setStaffCount(mem.value.members?.length ?? 0)
      if (d.status === 'fulfilled') setDeviceCount(d.value.total ?? 0)
    }).finally(() => setLoading(false))

    // Handle the return from a hosted gateway checkout (?checkout=paystack&reference=…).
    const params = new URLSearchParams(window.location.search)
    const reference = params.get('reference')
    if (params.get('checkout') && reference) {
      checkoutStatus(reference).then((res) => {
        if (res.ok && res.paid) {
          setNotice('Payment successful — your subscription is now active. Thank you!')
          void refreshBilling()
        } else if (res.ok && res.status === 'incomplete') {
          setNotice('Checkout was not completed. No payment was taken.')
        }
      }).catch(() => setNotice('We could not confirm your payment yet. Check your invoices shortly.'))
      window.history.replaceState({}, '', window.location.pathname)
    }
  }, [refreshBilling])

  const handleChangePlan = async (slug: string) => {
    if (!isOwner) return
    setChanging(slug)
    try {
      if (sub) {
        const { subscription } = await changePlan(slug)
        setSub(subscription)
      } else {
        const { subscription } = await createSubscription(slug, cycle)
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

  const saveRegion = async () => {
    if (!regionDraft || regionDraft === meta?.country) return
    setSavingRegion(true)
    try {
      const res = await setBillingCountry(regionDraft)
      setMeta((prev) => prev ? { ...prev, country: res.billing.country, currency: res.billing.currency || prev.currency, gateways: res.gateways } : prev)
      setNotice(`Payment region set to ${regionDraft.toUpperCase()}.`)
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not update payment region') }
    setSavingRegion(false)
  }

  const openCheckout = (plan: Plan) => {
    setCheckoutPlan(plan)
    setCheckoutGateway('auto')
    setCheckoutMethod('')
  }

  const beginCheckout = async () => {
    if (!checkoutPlan) return
    setStartingCheckout(true)
    try {
      const res = await startCheckout(checkoutPlan.slug, cycle)
      if (res.gateway === 'manual') {
        // Offline invoice: activated immediately, no gateway redirect.
        setCheckoutPlan(null)
        setNotice(`You're on the ${checkoutPlan.name} plan — we've raised an offline invoice you can settle by bank transfer.`)
        void refreshBilling()
      } else {
        window.location.href = res.url
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start checkout')
      setStartingCheckout(false)
    }
  }

  const currentPlan = plans.find((p) => p.slug === sub?.plan_slug)
  const price = (plan: Plan) => cycle === 'annual' ? plan.price_annual_cents : plan.price_monthly_cents
  const currency = meta?.currency ?? 'USD'
  const usedFeatures = useMemo(() => currentPlan?.features.slice(0, 4) ?? [], [currentPlan])
  const tabItems = [
    { id: 'overview', label: 'Overview' },
    { id: 'plans', label: 'Plans & usage' },
    { id: 'payment', label: 'Payment methods', count: methods.length },
    { id: 'invoices', label: 'Invoices', count: invoices.length },
  ] as const

  // Gateways offered for the selected region (auto = best available).
  const gatewaysForRegion = meta?.gateways ?? []
  const autoGateway = gatewaysForRegion.find((g) => g.enabled && g.slug !== 'manual') ?? gatewaysForRegion.find((g) => g.enabled)
  const activeGateway = checkoutGateway === 'auto'
    ? autoGateway
    : gatewaysForRegion.find((g) => g.slug === checkoutGateway)
  const activeMethods = activeGateway?.methods ?? []
  const chosenMethod = activeMethods.find((m) => m.id === checkoutMethod) ?? activeMethods[0]

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
        <Panel title="Payment region" subtitle="Determines the payment providers and currencies offered.">
          <div className="billing-region-card">
            <div className="billing-region-current">
              <span className="billing-region-flag">{meta?.country || '—'}</span>
              <div>
                <strong>{meta?.countries.find((c) => c.code === meta.country)?.name || 'Not set'}</strong>
                {meta?.detectedCountry && meta.detectedCountry !== meta?.country ? <small className="muted">Detected from your location: {meta.detectedCountry}</small> : <small className="muted">Set by your organization owner.</small>}
              </div>
            </div>
            <div className="billing-region-gateways">
              {meta?.gateways.map((g) => <span key={g.slug} className={`gateway-chip ${g.enabled ? '' : 'disabled'}`}><GatewayBadge slug={g.slug} />{g.enabled ? g.methods.map((m) => m.label).join(' · ') : 'Unavailable'}</span>)}
            </div>
            {isOwner ? <button className="btn btn-ghost btn-sm" onClick={() => setActiveTab('payment')}><Icon name="settings" size={14} />Change region</button> : null}
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
                {p === 0 ? 'Free' : <>{formatCents(p, currency)}<span className="billing-plan-period">/{cycle === 'annual' ? 'mo' : 'month'}</span></>}
                {p !== 0 && cycle === 'annual' ? <span className="billing-plan-annual">billed annually</span> : null}
              </div>
              {plan.max_technicians > 0 ? (
                <p className="billing-plan-limits">{plan.max_technicians < 0 ? 'Unlimited' : plan.max_technicians} technicians · {plan.max_devices < 0 ? 'Unlimited' : plan.max_devices} devices</p>
              ) : null}
              <ul className="billing-plan-features">
                {plan.features.map((f, i) => <li key={i}><Icon name="check" size={13} />{f}</li>)}
              </ul>
              {isOwner && !isCurrent ? (
                p === 0
                  ? <button className="btn btn-primary billing-plan-btn" onClick={() => void handleChangePlan(plan.slug)} disabled={changing === plan.slug}>{changing === plan.slug ? 'Switching…' : 'Get started'}</button>
                  : <button className="btn btn-primary billing-plan-btn" onClick={() => openCheckout(plan)}>{sub ? 'Switch plan' : 'Choose plan'}</button>
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
          <div><h2 className="billing-section-title">Payment region</h2><p className="billing-section-subtitle">Pick the region this organization bills from — it decides which providers and local payment methods are offered.</p></div>
          <button className="btn btn-primary btn-sm" onClick={() => void saveRegion()} disabled={savingRegion || !regionDraft || regionDraft === meta?.country}><Icon name="check" size={14} />{savingRegion ? 'Saving…' : 'Save region'}</button>
        </div>
        <div className="billing-region-editor">
          <div className="billing-region-field">
            <label className="field-label">Billing country</label>
            <select className="field-input" value={regionDraft} onChange={(e) => setRegionDraft(e.target.value)}>
              {meta?.countries.map((c) => <option key={c.code} value={c.code}>{c.name} ({c.code}) — {c.gateway === 'paystack' ? 'Paystack' : 'Stripe'}</option>)}
            </select>
            {meta?.detectedCountry && meta.detectedCountry !== meta?.country ? <p className="field-hint">We detected <strong>{meta.detectedCountry}</strong> from your connection — you can override it for this organization.</p> : null}
          </div>
          <div className="billing-region-preview">
            {meta?.gateways.map((g) => (
              <div key={g.slug} className={`billing-gateway-card ${g.enabled ? '' : 'disabled'}`}>
                <div className="billing-gateway-head"><GatewayBadge slug={g.slug} /><span className="billing-gateway-status">{g.enabled ? 'Available' : 'Not configured'}</span></div>
                <ul className="billing-gateway-methods">
                  {g.methods.map((m) => <li key={m.id}><Icon name="check" size={13} />{m.label}{m.note ? <span className="muted"> — {m.note}</span> : null}</li>)}
                </ul>
              </div>
            ))}
          </div>
        </div>

        <div className="billing-section-header billing-section-spacer">
          <div><h2 className="billing-section-title">Payment methods</h2><p className="billing-section-subtitle">Cards and authorizations on file for subscription charges.</p></div>
          {isOwner && <button className="btn btn-ghost btn-sm" onClick={() => setShowAddCard((open) => !open)}><Icon name="add" size={14} />{showAddCard ? 'Cancel' : 'Add card manually'}</button>}
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
          <p className="dash-empty">No payment methods on file. Adding a card happens when you complete a secure checkout.</p>
        ) : (
          <div className="billing-methods-list">
            {methods.map((m) => (
              <div key={m.id} className="billing-method-row">
                <CardBrand brand={m.brand} />
                <span className="billing-method-details">
                  {m.brand.toUpperCase()} •••• {m.last4}
                  {m.exp_month && m.exp_year ? <span className="muted"> · Expires {m.exp_month}/{m.exp_year}</span> : null}
                  {m.gateway && m.gateway !== 'manual' ? <span className="muted"> · via {m.gateway}</span> : null}
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
                <span className="mono">{formatCents(inv.amount_cents, inv.currency || currency)}</span>
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

      {/* Hosted checkout modal — pick gateway + method for the chosen plan */}
      {checkoutPlan ? (
        <div className="modal-backdrop" onClick={() => setCheckoutPlan(null)}>
          <div className="modal billing-checkout-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Checkout — {checkoutPlan.name}</h3>
            <p className="modal-desc">
              {formatCents(price(checkoutPlan), currency)}/{cycle === 'annual' ? 'mo, billed annually' : 'month'}
              {sub ? ' · your current plan will be upgraded on payment.' : ' · starts your subscription today.'}
            </p>

            <div className="billing-checkout-region">
              <span className="field-label">Payment region</span>
              <div className="billing-checkout-region-row">
                <span className="billing-region-flag">{meta?.country || '—'}</span>
                <span>{meta?.countries.find((c) => c.code === meta.country)?.name || 'Not set'}</span>
              </div>
            </div>

            <div className="billing-checkout-gateways">
              {gatewaysForRegion.filter((g) => g.enabled).map((g) => (
                <label key={g.slug} className={`billing-gateway-option ${checkoutGateway === g.slug ? 'selected' : ''}`}>
                  <input type="radio" name="gateway" value={g.slug} checked={checkoutGateway === g.slug} onChange={() => { setCheckoutGateway(g.slug); setCheckoutMethod('') }} />
                  <span className="billing-gateway-option-head"><GatewayBadge slug={g.slug} /><span className="muted">{g.methods.length} methods</span></span>
                  {checkoutGateway === g.slug ? (
                    <span className="billing-checkout-methods">
                      {g.methods.map((m) => (
                        <button key={m.id} type="button" className={`billing-method-pill ${checkoutMethod === m.id ? 'selected' : ''}`} onClick={() => setCheckoutMethod(m.id)}>
                          {m.label}{m.note ? <small> · {m.note}</small> : null}
                        </button>
                      ))}
                    </span>
                  ) : null}
                </label>
              ))}
            </div>

            {activeGateway?.slug === 'manual' || checkoutGateway === 'manual' ? (
              <p className="billing-checkout-note"><Icon name="alert" size={13} />Offline payment: we'll email an invoice; your plan activates once we confirm the transfer.</p>
            ) : (
              <p className="billing-checkout-note"><Icon name="lock" size={13} />You'll be redirected to {activeGateway?.label ?? 'our payment provider'} to complete payment securely. {meta?.paystackPublicKey ? 'Paystack handles all local payment methods.' : ''}</p>
            )}

            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setCheckoutPlan(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={() => void beginCheckout()} disabled={startingCheckout}>
                <Icon name="lock" size={14} />{startingCheckout ? 'Redirecting…' : `Pay with ${activeGateway?.label ?? 'gateway'}${chosenMethod ? ` · ${chosenMethod.label}` : ''}`}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </Shell>
  )
}