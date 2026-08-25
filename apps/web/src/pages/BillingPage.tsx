/* Hallmark · macrostructure: Workbench · genre: modern-minimal · theme: Coral
 * enrichment: none (typography only)
 * diff from previous: stat-led layout, usage-bar hero, card-based payment methods
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Icon } from '../components/Icons.js'
import { Alert, PageHeader } from '../components/ui.js'
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

/* ── tiny helpers ─────────────────────────────────────────────── */

function StatusPill({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    active: { label: 'Active', cls: 'b-status-active' },
    trialing: { label: 'Trial', cls: 'b-status-trial' },
    past_due: { label: 'Past due', cls: 'b-status-past-due' },
    canceled: { label: 'Canceled', cls: 'b-status-canceled' },
    open: { label: 'Open', cls: 'b-status-open' },
    paid: { label: 'Paid', cls: 'b-status-paid' },
    draft: { label: 'Draft', cls: 'b-status-draft' },
  }
  const s = map[status] ?? { label: status.replace('_', ' '), cls: '' }
  return <span className={`b-status ${s.cls}`}>{s.label}</span>
}

function CardChip({ brand }: { brand: string }) {
  const labels: Record<string, string> = { visa: 'VISA', mastercard: 'MC', amex: 'AMEX', discover: 'DISC' }
  return <span className={`b-card-chip b-card-${brand.toLowerCase()}`}>{labels[brand.toLowerCase()] ?? 'CARD'}</span>
}

function UsageBar({ label, used, max }: { label: string; used: number; max: number }) {
  const unlimited = max <= 0
  const pct = unlimited ? 0 : Math.min(100, Math.round((used / max) * 100))
  const over = !unlimited && used > max
  return (
    <div className="b-usage">
      <div className="b-usage-head"><span>{label}</span><span className="mono">{unlimited ? 'Unlimited' : `${used} / ${max}`}</span></div>
      {!unlimited && <div className="b-usage-track"><div className={`b-usage-fill${over ? ' b-usage-over' : ''}`} style={{ width: `${pct}%` }} /></div>}
    </div>
  )
}

function GatewayBadge({ slug }: { slug: string }) {
  return <span className={`b-gw-badge b-gw-${slug}`}>{slug === 'paystack' ? 'Paystack' : slug === 'stripe' ? 'Stripe' : 'Invoice'}</span>
}

/* ── main component ───────────────────────────────────────────── */

type BillingTab = 'overview' | 'plans' | 'payment' | 'invoices'

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
  const [tab, setTab] = useState<BillingTab>('overview')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  /* ── region / checkout state ─────────────────── */
  const [meta, setMeta] = useState<{ country: string; detectedCountry: string; currency: string | null; gateways: GatewayInfo[]; countries: Array<{ code: string; name: string; gateway: string }>; paystackPublicKey: string } | null>(null)
  const [regionDraft, setRegionDraft] = useState('')
  const [savingRegion, setSavingRegion] = useState(false)
  const [checkoutPlan, setCheckoutPlan] = useState<Plan | null>(null)
  const [checkoutGateway, setCheckoutGateway] = useState('auto')
  const [checkoutMethod, setCheckoutMethod] = useState('')
  const [startingCheckout, setStartingCheckout] = useState(false)
  const [showCancel, setShowCancel] = useState(false)
  const [changing, setChanging] = useState<string | null>(null)
  const [showAddCard, setShowAddCard] = useState(false)
  const [newCard, setNewCard] = useState({ brand: 'visa', last4: '', exp_month: '', exp_year: '' })

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

    const params = new URLSearchParams(window.location.search)
    const reference = params.get('reference')
    if (params.get('checkout') && reference) {
      checkoutStatus(reference).then((res) => {
        if (res.ok && res.paid) { setNotice('Payment successful — your subscription is now active.'); void refreshBilling() }
        else if (res.ok && res.status === 'incomplete') setNotice('Checkout was not completed. No payment was taken.')
      }).catch(() => setNotice('We could not confirm your payment yet. Check your invoices shortly.'))
      window.history.replaceState({}, '', window.location.pathname)
    }
  }, [refreshBilling])

  /* ── handlers ─────────────────────────────────── */

  const handleChangePlan = async (slug: string) => {
    if (!isOwner) return
    setChanging(slug)
    try {
      if (sub) { const { subscription } = await changePlan(slug); setSub(subscription) }
      else { const { subscription } = await createSubscription(slug, cycle); setSub(subscription) }
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not change plan') }
    setChanging(null)
  }

  const handleCancel = async () => {
    if (!isOwner) return
    try { await cancelSubscription(); setSub((p) => p ? { ...p, status: 'canceled' } : null); setShowCancel(false) }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not cancel') }
  }

  const handleAddCard = async () => {
    if (!newCard.last4 || newCard.last4.length < 4) return
    try {
      const { method } = await addPaymentMethod({ brand: newCard.brand, last4: newCard.last4, exp_month: newCard.exp_month ? Number(newCard.exp_month) : undefined, exp_year: newCard.exp_year ? Number(newCard.exp_year) : undefined })
      setMethods((p) => [method, ...p]); setNewCard({ brand: 'visa', last4: '', exp_month: '', exp_year: '' }); setShowAddCard(false)
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not add card') }
  }

  const handleRemoveCard = async (id: number) => {
    try { await removePaymentMethod(id); setMethods((p) => p.filter((m) => m.id !== id)) }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not remove') }
  }

  const handleSetDefault = async (id: number) => {
    try { await setDefaultPaymentMethod(id); setMethods((p) => p.map((m) => ({ ...m, is_default: m.id === id }))) }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not update') }
  }

  const saveRegion = async () => {
    if (!regionDraft || regionDraft === meta?.country) return
    setSavingRegion(true)
    try { const res = await setBillingCountry(regionDraft); setMeta((p) => p ? { ...p, country: res.billing.country, currency: res.billing.currency || p.currency, gateways: res.gateways } : p); setNotice(`Payment region set to ${regionDraft.toUpperCase()}.`) }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not update region') }
    setSavingRegion(false)
  }

  const openCheckout = (plan: Plan) => { setCheckoutPlan(plan); setCheckoutGateway('auto'); setCheckoutMethod('') }

  const beginCheckout = async () => {
    if (!checkoutPlan) return
    setStartingCheckout(true)
    try {
      const res = await startCheckout(checkoutPlan.slug, cycle)
      if (res.gateway === 'manual') { setCheckoutPlan(null); setNotice(`You're on the ${checkoutPlan.name} plan — an offline invoice has been raised.`); void refreshBilling() }
      else window.location.href = res.url
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not start checkout'); setStartingCheckout(false) }
  }

  /* ── derived data ─────────────────────────────── */

  const currentPlan = plans.find((p) => p.slug === sub?.plan_slug)
  const price = (plan: Plan) => cycle === 'annual' ? plan.price_annual_cents : plan.price_monthly_cents
  const currency = meta?.currency ?? 'USD'
  const usedFeatures = useMemo(() => currentPlan?.features.slice(0, 4) ?? [], [currentPlan])

  const gatewaysForRegion = meta?.gateways ?? []
  const autoGateway = gatewaysForRegion.find((g) => g.enabled && g.slug !== 'manual') ?? gatewaysForRegion.find((g) => g.enabled)
  const activeGateway = checkoutGateway === 'auto' ? autoGateway : gatewaysForRegion.find((g) => g.slug === checkoutGateway)
  const activeMethods = activeGateway?.methods ?? []
  const chosenMethod = activeMethods.find((m) => m.id === checkoutMethod) ?? activeMethods[0]

  const tabs: Array<{ id: BillingTab; label: string; n?: number }> = [
    { id: 'overview', label: 'Overview' },
    { id: 'plans', label: 'Plans' },
    { id: 'payment', label: 'Payment', n: methods.length },
    { id: 'invoices', label: 'Invoices', n: invoices.length },
  ]

  if (loading) return (
    <Shell>
      <PageHeader title="Billing" subtitle="Manage your subscription, payment methods, and invoices." />
      <div className="dash-loading"><div className="loading-spinner" /><p>Loading billing…</p></div>
    </Shell>
  )

  return (
    <Shell>
      <PageHeader
        title="Billing"
        subtitle={isOwner ? 'Manage your plan, payment methods, and billing history.' : 'View your plan and billing history.'}
        actions={isOwner ? <span className="b-owner"><Icon name="shield" size={13} />Owner</span> : <span className="muted" style={{ fontSize: 12 }}>Read-only</span>}
      />

      {error ? <Alert kind="error">{error}</Alert> : null}
      {notice ? <Alert kind="info">{notice}</Alert> : null}

      {/* ── Hero: current plan + usage ───────────────────── */}
      <div className="b-hero">
        <div className="b-hero-plan">
          <span className="b-hero-eyebrow">Current plan</span>
          <div className="b-hero-title-row">
            <h2 className="b-hero-plan-name">{currentPlan?.name || 'Free'}</h2>
            {sub ? <StatusPill status={sub.status} /> : <span className="b-status b-status-draft">No subscription</span>}
          </div>
          <p className="b-hero-desc">{currentPlan?.description ?? 'Choose a plan to unlock team features.'}</p>
          <div className="b-hero-meta">
            {currentPlan ? <span><Icon name="check" size={13} />{currentPlan.max_technicians < 0 ? 'Unlimited' : `${currentPlan.max_technicians}`} technicians</span> : null}
            {currentPlan ? <span><Icon name="check" size={13} />{currentPlan.max_devices < 0 ? 'Unlimited' : `${currentPlan.max_devices}`} devices</span> : null}
            {sub ? <span><Icon name="clock" size={13} />Renews {new Date(sub.current_period_end).toLocaleDateString()}</span> : null}
            {sub?.trial_ends_at && sub.status === 'trialing' ? <span><Icon name="clock" size={13} />Trial ends {new Date(sub.trial_ends_at!).toLocaleDateString()}</span> : null}
          </div>
        </div>
        <div className="b-hero-usage">
          <UsageBar label="Technicians" used={staffCount} max={currentPlan?.max_technicians ?? 1} />
          <UsageBar label="Devices" used={deviceCount} max={currentPlan?.max_devices ?? 5} />
        </div>
        <div className="b-hero-actions">
          {isOwner && <button className="btn btn-primary btn-sm" onClick={() => setTab('plans')}><Icon name="settings" size={14} />Manage plan</button>}
          {sub && sub.status !== 'canceled' && isOwner && <button className="btn btn-ghost btn-sm" onClick={() => setShowCancel(true)}>Cancel</button>}
        </div>
      </div>

      {/* ── Tabs ─────────────────────────────────────────── */}
      <nav className="b-tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={`b-tab${tab === t.id ? ' b-tab-active' : ''}`} onClick={() => setTab(t.id)}>
            {t.label}{t.n !== undefined ? <span className="b-tab-count">{t.n}</span> : null}
          </button>
        ))}
      </nav>

      {/* ── Overview ─────────────────────────────────────── */}
      {tab === 'overview' && <OverviewTab currentPlan={currentPlan} sub={sub} usedFeatures={usedFeatures} meta={meta} isOwner={isOwner} setTab={setTab} />}

      {/* ── Plans ────────────────────────────────────────── */}
      {tab === 'plans' && <PlansTab plans={plans} sub={sub} cycle={cycle} setCycle={setCycle} isOwner={isOwner} changing={changing} price={price} currency={currency} onChangePlan={handleChangePlan} onCheckout={openCheckout} />}

      {/* ── Payment ──────────────────────────────────────── */}
      {tab === 'payment' && <PaymentTab methods={methods} meta={meta} isOwner={isOwner} regionDraft={regionDraft} setRegionDraft={setRegionDraft} savingRegion={savingRegion} saveRegion={saveRegion} showAddCard={showAddCard} setShowAddCard={setShowAddCard} newCard={newCard} setNewCard={setNewCard} onAddCard={handleAddCard} onRemove={handleRemoveCard} onSetDefault={handleSetDefault} />}

      {/* ── Invoices ─────────────────────────────────────── */}
      {tab === 'invoices' && <InvoicesTab invoices={invoices} currency={currency} />}

      {/* ── Cancel modal ─────────────────────────────────── */}
      {showCancel && (
        <div className="modal-backdrop" onClick={() => setShowCancel(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Cancel subscription?</h3>
            <p className="modal-desc">Your subscription stays active until {sub ? new Date(sub.current_period_end).toLocaleDateString() : '—'}. After that you'll be on the Free plan.</p>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setShowCancel(false)}>Keep subscription</button>
              <button className="btn btn-danger" onClick={() => void handleCancel()}>Cancel subscription</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Checkout modal ───────────────────────────────── */}
      {checkoutPlan && (
        <div className="modal-backdrop" onClick={() => setCheckoutPlan(null)}>
          <div className="modal b-checkout-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Checkout — {checkoutPlan.name}</h3>
            <p className="modal-desc">
              {formatCents(price(checkoutPlan), currency)}/{cycle === 'annual' ? 'mo, billed annually' : 'month'}
              {sub ? ' · plan upgrades on payment.' : ' · starts your subscription today.'}
            </p>
            <div className="b-checkout-region">
              <span className="field-label">Payment region</span>
              <div className="b-checkout-region-row">
                <span className="b-region-flag">{meta?.country || '—'}</span>
                <span>{meta?.countries.find((c) => c.code === meta?.country)?.name || 'Not set'}</span>
              </div>
            </div>
            <div className="b-checkout-gateways">
              {gatewaysForRegion.filter((g) => g.enabled).map((g) => (
                <label key={g.slug} className={`b-gw-option${checkoutGateway === g.slug ? ' b-gw-selected' : ''}`}>
                  <input type="radio" name="gw" value={g.slug} checked={checkoutGateway === g.slug} onChange={() => { setCheckoutGateway(g.slug); setCheckoutMethod('') }} />
                  <span className="b-gw-option-head"><GatewayBadge slug={g.slug} /><span className="muted">{g.methods.length} methods</span></span>
                  {checkoutGateway === g.slug && (
                    <span className="b-gw-methods">
                      {g.methods.map((m) => <button key={m.id} type="button" className={`b-method-pill${checkoutMethod === m.id ? ' b-method-active' : ''}`} onClick={() => setCheckoutMethod(m.id)}>{m.label}{m.note ? <small> · {m.note}</small> : null}</button>)}
                    </span>
                  )}
                </label>
              ))}
            </div>
            <p className="b-checkout-note">
              {checkoutGateway === 'manual' ? <><Icon name="alert" size={13} />Offline payment: we'll email an invoice; your plan activates on confirmation.</> : <><Icon name="lock" size={13} />Redirected to {activeGateway?.label ?? 'payment provider'} — payment is handled securely off-site.</>}
            </p>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setCheckoutPlan(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={() => void beginCheckout()} disabled={startingCheckout}>
                <Icon name="lock" size={14} />{startingCheckout ? 'Redirecting…' : `Pay with ${activeGateway?.label ?? 'gateway'}${chosenMethod ? ` · ${chosenMethod.label}` : ''}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </Shell>
  )
}

/* ── Overview tab ──────────────────────────────────────────────── */

function OverviewTab({ currentPlan, sub, usedFeatures, meta, isOwner, setTab }: {
  currentPlan: Plan | undefined; sub: Subscription | null; usedFeatures: string[];
  meta: { country: string; gateways: GatewayInfo[]; countries: Array<{ code: string; name: string }> } | null;
  isOwner: boolean; setTab: (t: BillingTab) => void;
}) {
  return (
    <div className="b-overview">
      <div className="b-overview-card">
        <span className="b-overview-label">Plan</span>
        <div className="b-overview-big">{currentPlan?.name || 'Free'}</div>
        {sub && <span className="b-overview-sub">{sub.status === 'active' ? `Renews ${new Date(sub.current_period_end).toLocaleDateString()}` : sub.status === 'trialing' ? `Trial ends ${new Date(sub.trial_ends_at!).toLocaleDateString()}` : sub.status}</span>}
        <div className="b-overview-features">{usedFeatures.map((f) => <span key={f}><Icon name="check" size={13} />{f}</span>)}</div>
        {isOwner && <button className="btn btn-ghost btn-sm" onClick={() => setTab('plans')} style={{ marginTop: 12 }}>Compare plans <Icon name="forward" size={14} /></button>}
      </div>
      <div className="b-overview-card">
        <span className="b-overview-label">Payment region</span>
        <div className="b-overview-big">{meta?.countries.find((c) => c.code === meta.country)?.name || 'Not set'}</div>
        <div className="b-overview-gateways">{meta?.gateways.map((g) => <GatewayBadge key={g.slug} slug={g.slug} />)}</div>
        {isOwner && <button className="btn btn-ghost btn-sm" onClick={() => setTab('payment')} style={{ marginTop: 12 }}>Manage <Icon name="forward" size={14} /></button>}
      </div>
      <div className="b-overview-card">
        <span className="b-overview-label">Quick actions</span>
        <div className="b-overview-actions">
          <button className="btn btn-ghost btn-sm" onClick={() => setTab('plans')}><Icon name="settings" size={14} />Plans</button>
          <button className="btn btn-ghost btn-sm" onClick={() => setTab('payment')}><Icon name="key" size={14} />Payment</button>
          <button className="btn btn-ghost btn-sm" onClick={() => setTab('invoices')}><Icon name="file" size={14} />Invoices</button>
        </div>
      </div>
    </div>
  )
}

/* ── Plans tab ─────────────────────────────────────────────────── */

function PlansTab({ plans, sub, cycle, setCycle, isOwner, changing, price, currency, onChangePlan, onCheckout }: {
  plans: Plan[]; sub: Subscription | null; cycle: 'monthly' | 'annual'; setCycle: (c: 'monthly' | 'annual') => void;
  isOwner: boolean; changing: string | null; price: (p: Plan) => number; currency: string;
  onChangePlan: (slug: string) => void; onCheckout: (plan: Plan) => void;
}) {
  return (
    <div className="b-plans">
      {isOwner && (
        <div className="b-cycle-toggle">
          <button className={`b-cycle-btn${cycle === 'monthly' ? ' b-cycle-active' : ''}`} onClick={() => setCycle('monthly')}>Monthly</button>
          <button className={`b-cycle-btn${cycle === 'annual' ? ' b-cycle-active' : ''}`} onClick={() => setCycle('annual')}>Annual <span className="b-save-badge">Save 17%</span></button>
        </div>
      )}
      <div className="b-plan-grid">
        {plans.filter((p) => p.slug !== 'enterprise').map((plan) => {
          const isCurrent = sub?.plan_slug === plan.slug
          const p = price(plan)
          const rec = plan.slug === 'pro'
          return (
            <div key={plan.id} className={`b-plan${isCurrent ? ' b-plan-current' : ''}${rec && !isCurrent ? ' b-plan-rec' : ''}`}>
              {isCurrent && <div className="b-plan-tag">Current</div>}
              {rec && !isCurrent && <div className="b-plan-tag b-plan-tag-rec">Most popular</div>}
              <h3 className="b-plan-name">{plan.name}</h3>
              <p className="b-plan-desc">{plan.description}</p>
              <div className="b-plan-price">
                {p === 0 ? 'Free' : <><span className="b-plan-amount">{formatCents(p, currency)}</span><span className="b-plan-period">/{cycle === 'annual' ? 'mo' : 'month'}</span></>}
                {p !== 0 && cycle === 'annual' && <span className="b-plan-billed">billed annually</span>}
              </div>
              <ul className="b-plan-features">
                {plan.features.map((f, i) => <li key={i}><Icon name="check" size={13} />{f}</li>)}
              </ul>
              {isOwner && !isCurrent && (
                p === 0
                  ? <button className="btn btn-primary btn-block" onClick={() => void onChangePlan(plan.slug)} disabled={changing === plan.slug}>{changing === plan.slug ? 'Switching…' : 'Get started'}</button>
                  : <button className="btn btn-primary btn-block" onClick={() => onCheckout(plan)}>{sub ? 'Switch plan' : 'Choose plan'}</button>
              )}
              {isCurrent && <button className="btn btn-ghost btn-block" disabled>Current plan</button>}
            </div>
          )
        })}
        <div className="b-plan">
          <h3 className="b-plan-name">Enterprise</h3>
          <p className="b-plan-desc">Custom deployment for large organisations.</p>
          <div className="b-plan-price"><span className="b-plan-amount">Custom</span></div>
          <ul className="b-plan-features">
            <li><Icon name="check" size={13} />Everything in Pro</li>
            <li><Icon name="check" size={13} />SAML SSO + SCIM</li>
            <li><Icon name="check" size={13} />Custom integrations</li>
            <li><Icon name="check" size={13} />Dedicated support</li>
          </ul>
          <a href="/contact" className="btn btn-ghost btn-block">Contact sales</a>
        </div>
      </div>
    </div>
  )
}

/* ── Payment tab ───────────────────────────────────────────────── */

type CardDraft = { brand: string; last4: string; exp_month: string; exp_year: string }

interface PaymentTabProps {
  methods: PaymentMethod[]
  meta: { country: string; detectedCountry: string; gateways: GatewayInfo[]; countries: Array<{ code: string; name: string; gateway: string }> } | null
  isOwner: boolean
  regionDraft: string
  setRegionDraft: (v: string) => void
  savingRegion: boolean
  saveRegion: () => void
  showAddCard: boolean
  setShowAddCard: (v: boolean | ((p: boolean) => boolean)) => void
  newCard: CardDraft
  setNewCard: (fn: (p: CardDraft) => CardDraft) => void
  onAddCard: () => void
  onRemove: (id: number) => void
  onSetDefault: (id: number) => void
}

function PaymentTab({ methods, meta, isOwner, regionDraft, setRegionDraft, savingRegion, saveRegion, showAddCard, setShowAddCard, newCard, setNewCard, onAddCard, onRemove, onSetDefault }: PaymentTabProps) {
  return (
    <div className="b-payment">
      {/* Region */}
      <div className="b-section">
        <div className="b-section-head">
          <div><h3>Payment region</h3><p>Controls which providers and local methods are offered.</p></div>
          {isOwner && <button className="btn btn-primary btn-sm" onClick={() => void saveRegion()} disabled={savingRegion || !regionDraft || regionDraft === meta?.country}><Icon name="check" size={14} />{savingRegion ? 'Saving…' : 'Save'}</button>}
        </div>
        <div className="b-region-row">
          <div className="b-region-field">
            <label className="field-label">Billing country</label>
            <select className="field-input" value={regionDraft} onChange={(e) => setRegionDraft(e.target.value)}>
              {meta?.countries.map((c) => <option key={c.code} value={c.code}>{c.name} ({c.code}) — {c.gateway === 'paystack' ? 'Paystack' : 'Stripe'}</option>)}
            </select>
            {meta?.detectedCountry && meta.detectedCountry !== meta?.country && <p className="field-hint">Detected <strong>{meta.detectedCountry}</strong> from your connection.</p>}
          </div>
          <div className="b-region-gateways">
            {meta?.gateways.map((g) => (
              <div key={g.slug} className={`b-gw-card${g.enabled ? '' : ' b-gw-disabled'}`}>
                <div className="b-gw-card-head"><GatewayBadge slug={g.slug} /><span className="muted">{g.enabled ? 'Available' : 'Unavailable'}</span></div>
                <ul className="b-gw-card-methods">{g.methods.map((m) => <li key={m.id}><Icon name="check" size={13} />{m.label}{m.note && <span className="muted"> — {m.note}</span>}</li>)}</ul>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Methods */}
      <div className="b-section b-section-spacer">
        <div className="b-section-head">
          <div><h3>Payment methods</h3><p>Cards on file for subscription charges.</p></div>
          {isOwner && <button className="btn btn-ghost btn-sm" onClick={() => setShowAddCard((p) => !p)}><Icon name="add" size={14} />{showAddCard ? 'Cancel' : 'Add card'}</button>}
        </div>
        {showAddCard && (
          <div className="b-add-card">
            <select className="field-input" value={newCard.brand} onChange={(e) => setNewCard((p) => ({ ...p, brand: e.target.value }))}>
              <option value="visa">Visa</option><option value="mastercard">Mastercard</option><option value="amex">American Express</option>
            </select>
            <input className="field-input" placeholder="Last 4 digits" value={newCard.last4} onChange={(e) => setNewCard((p) => ({ ...p, last4: e.target.value.replace(/\D/g, '').slice(0, 4) }))} maxLength={4} />
            <input className="field-input" placeholder="MM" value={newCard.exp_month} onChange={(e) => setNewCard((p) => ({ ...p, exp_month: e.target.value.replace(/\D/g, '').slice(0, 2) }))} maxLength={2} style={{ maxWidth: 60 }} />
            <input className="field-input" placeholder="YY" value={newCard.exp_year} onChange={(e) => setNewCard((p) => ({ ...p, exp_year: e.target.value.replace(/\D/g, '').slice(0, 2) }))} maxLength={2} style={{ maxWidth: 60 }} />
            <button className="btn btn-primary btn-sm" onClick={() => void onAddCard()} disabled={newCard.last4.length < 4}>Add</button>
          </div>
        )}
        {methods.length === 0 ? (
          <p className="b-empty">No payment methods on file. Cards are saved when you complete a checkout.</p>
        ) : (
          <div className="b-method-list">
            {methods.map((m) => (
              <div key={m.id} className="b-method-row">
                <CardChip brand={m.brand} />
                <div className="b-method-info">
                  <span className="b-method-number">{m.brand.toUpperCase()} •••• {m.last4}</span>
                  <span className="b-method-detail">
                    {m.exp_month && m.exp_year ? `Exp ${m.exp_month}/${m.exp_year}` : null}
                    {m.gateway && m.gateway !== 'manual' ? ` · via ${m.gateway}` : null}
                  </span>
                </div>
                {m.is_default && <StatusPill status="active" />}
                {isOwner && (
                  <div className="b-method-actions">
                    {!m.is_default && <button className="btn btn-ghost btn-xs" onClick={() => void onSetDefault(m.id)}>Default</button>}
                    <button className="btn btn-ghost btn-xs" style={{ color: 'var(--crit)' }} onClick={() => void onRemove(m.id)}>Remove</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/* ── Invoices tab ──────────────────────────────────────────────── */

function InvoicesTab({ invoices, currency }: { invoices: Invoice[]; currency: string }) {
  return (
    <div className="b-section">
      <div className="b-section-head"><div><h3>Invoices</h3><p>Subscription charges for this organization.</p></div></div>
      {invoices.length === 0 ? (
        <p className="b-empty">No invoices yet.</p>
      ) : (
        <table className="b-invoice-table">
          <thead><tr><th>Invoice</th><th>Date</th><th>Amount</th><th>Status</th></tr></thead>
          <tbody>
            {invoices.map((inv) => (
              <tr key={inv.id}>
                <td className="mono">#{inv.number}</td>
                <td>{new Date(inv.created_at).toLocaleDateString()}</td>
                <td className="mono">{formatCents(inv.amount_cents, inv.currency || currency)}</td>
                <td><StatusPill status={inv.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
