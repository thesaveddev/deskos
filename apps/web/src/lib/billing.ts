import { api } from './api.js'

export interface Plan {
  id: number
  slug: string
  name: string
  description: string
  price_monthly_cents: number
  price_annual_cents: number
  max_technicians: number
  max_devices: number
  features: string[]
  is_active: boolean
}

export interface Subscription {
  id: number
  tenant_id: string
  plan_id: number
  plan_name: string
  plan_slug: string
  status: string
  billing_cycle: string
  trial_ends_at: string | null
  current_period_start: string
  current_period_end: string
  canceled_at: string | null
  created_at: string
}

export interface Invoice {
  id: number
  tenant_id: string
  subscription_id: number | null
  number: string
  status: string
  amount_cents: number
  currency: string
  description: string
  due_date: string | null
  paid_at: string | null
  created_at: string
}

export interface PaymentMethod {
  id: number
  tenant_id: string
  type: string
  brand: string
  last4: string
  exp_month: number | null
  exp_year: number | null
  is_default: boolean
  created_at: string
  gateway?: string
  gateway_method?: string
  external_id?: string
}

export interface GatewayMethodInfo {
  id: string
  label: string
  description: string
  note?: string
}

export interface GatewayInfo {
  slug: 'paystack' | 'stripe' | 'manual'
  label: string
  enabled: boolean
  methods: GatewayMethodInfo[]
}

export interface BillingMeta {
  country: string
  detectedCountry: string
  currency: string | null
  gateways: GatewayInfo[]
  countries: Array<{ code: string; name: string; gateway: string }>
  paystackPublicKey: string
}

export interface CheckoutResult {
  url: string
  reference: string
  gateway: string
  country: string
  currency: string
}

export function listPlans(): Promise<{ plans: Plan[] }> {
  return api('/billing/plans')
}

export interface EntitlementInfo {
  planName: string
  planSlug: string
  maxTechnicians: number
  maxDevices: number
  currentTechnicians: number
  currentDevices: number
  techniciansRemaining: number
  devicesRemaining: number
}

export function getSubscription(): Promise<{ subscription: Subscription | null }> {
  return api('/billing/subscription')
}

export function getEntitlement(): Promise<EntitlementInfo> {
  return api('/billing/entitlement')
}

export interface BillingAnalytics {
  snapshot: {
    mrr_cents: number
    arr_cents: number
    active_subscriptions: number
    trial_subscriptions: number
    past_due_subscriptions: number
    canceled_this_month: number
    new_this_month: number
    conversion_rate: number
  }
  by_gateway: Array<{ gateway: string; count: number; revenue_cents: number; last_payment_at: string | null }>
  by_plan: Array<{ plan_name: string; plan_slug: string; count: number; monthly_revenue_cents: number; annual_revenue_cents: number }>
  mrr_trend: Array<{ month: string; mrr_cents: number; new_mrr: number; churned_mrr: number; net_mrr: number }>
  recent_churn: Array<{ tenant_id: string; tenant_name: string; plan_name: string; canceled_at: string; reason: string | null; was_active_days: number }>
  dunning_queue: Array<{ tenant_id: string; tenant_name: string; email: string; plan_name: string; past_since: string; days_past_due: number; retry_count: number; next_retry_at: string | null }>
}

export function getBillingAnalytics(): Promise<BillingAnalytics> {
  return api('/billing/analytics')
}

export function createSubscription(plan: string, billing_cycle?: string): Promise<{ subscription: Subscription }> {
  return api('/billing/subscription', { method: 'POST', body: { plan, billing_cycle } })
}

export function changePlan(plan: string): Promise<{ subscription: Subscription }> {
  return api('/billing/subscription', { method: 'PATCH', body: { plan } })
}

export function cancelSubscription(): Promise<{ ok: boolean }> {
  return api('/billing/subscription', { method: 'DELETE' })
}

export function listInvoices(): Promise<{ invoices: Invoice[] }> {
  return api('/billing/invoices')
}

export function listPaymentMethods(): Promise<{ methods: PaymentMethod[] }> {
  return api('/billing/payment-methods')
}

export function addPaymentMethod(data: { brand?: string; last4: string; exp_month?: number; exp_year?: number }): Promise<{ method: PaymentMethod }> {
  return api('/billing/payment-methods', { method: 'POST', body: data })
}

export function removePaymentMethod(id: number): Promise<{ ok: boolean }> {
  return api(`/billing/payment-methods/${id}`, { method: 'DELETE' })
}

export function setDefaultPaymentMethod(id: number): Promise<{ ok: boolean }> {
  return api(`/billing/payment-methods/${id}/default`, { method: 'PATCH' })
}

export function getBillingMeta(): Promise<{ country: string; detectedCountry: string; currency: string | null; gateways: GatewayInfo[]; countries: BillingMeta['countries']; paystackPublicKey: string }> {
  return api('/billing/meta')
}

export function setBillingCountry(country: string): Promise<{ billing: { country: string; currency: string }; gateways: GatewayInfo[] }> {
  return api('/billing/meta', { method: 'PATCH', body: { country } })
}

export function startCheckout(plan: string, billing_cycle: string): Promise<CheckoutResult> {
  return api('/billing/checkout', { method: 'POST', body: { plan, billing_cycle } })
}

export function checkoutStatus(reference: string): Promise<{ ok: boolean; paid?: boolean; status?: string; subscription?: Subscription | null; invoices?: Invoice[] }> {
  return api(`/billing/checkout/status?reference=${encodeURIComponent(reference)}`)
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$', NGN: '₦', GHS: 'GH₵', KES: 'KSh', ZAR: 'R', EGP: 'E£',
  XOF: 'CFA', UGX: 'USh', RWF: 'FRw', TZS: 'TSh', GBP: '£',
}

export function formatCents(cents: number, currency = 'USD'): string {
  const symbol = CURRENCY_SYMBOLS[currency.toUpperCase()] ?? `${currency.toUpperCase()} `
  const value = (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })
  return `${symbol}${value}`
}
