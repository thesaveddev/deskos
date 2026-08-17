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
}

export function listPlans(): Promise<{ plans: Plan[] }> {
  return api('/billing/plans')
}

export function getSubscription(): Promise<{ subscription: Subscription | null }> {
  return api('/billing/subscription')
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

export function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
}
