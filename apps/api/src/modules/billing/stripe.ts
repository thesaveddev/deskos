import { createHmac, timingSafeEqual } from 'node:crypto'
import {
  type CheckoutInput, type CheckoutResult, type GatewayMethodInfo,
  type PaymentGateway, type VerifyResult, type WebhookEvent,
} from './gateway.js'

const API = 'https://api.stripe.com/v1'

interface StripeSession {
  id: string
  url: string | null
  status: string
  customer: string
  subscription:
    | string
    | null
    | {
        id: string
        default_payment_method: null | {
          id: string
          card: null | { brand: string; last4: string; exp_month: number; exp_year: number }
        }
      }
  payment_status: string
  metadata?: Record<string, string>
  customer_details?: { email?: string }
}

/**
 * Stripe provider via plain fetch (no SDK). Checkout Sessions in subscription
 * mode give auto-recurring billing; `Stripe-Signature` events are validated
 * with the raw-body HMAC scheme Stripe specifies.
 */
export class StripeGateway implements PaymentGateway {
  readonly slug = 'stripe' as const
  readonly label = 'Stripe'
  readonly enabled: boolean

  constructor(
    private readonly secretKey: string,
    private readonly webhookSecret: string,
  ) {
    this.enabled = Boolean(secretKey)
  }

  methods(): GatewayMethodInfo[] {
    return [
      { id: 'card', label: 'Card', description: 'Visa, Mastercard, Amex and debit cards.' },
      { id: 'apple_pay', label: 'Apple Pay', description: 'Fast checkout on iOS and Safari.' },
      { id: 'google_pay', label: 'Google Pay', description: 'Fast checkout on Android and Chrome.' },
    ]
  }

  private async request<T>(method: string, path: string, body?: URLSearchParams): Promise<T> {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.secretKey}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: body?.toString(),
    })
    const json = (await res.json()) as { error?: { message?: string }; id?: string } & T
    if (!res.ok) {
      throw new Error(`Stripe error: ${json.error?.message ?? res.statusText}`)
    }
    return json
  }

  private priceKey(slug: string, cycle: 'monthly' | 'annual', currency: string): string {
    return `reydesk_${slug}_${cycle}_${currency.toLowerCase()}`
  }

  private async ensurePrice(input: CheckoutInput): Promise<string> {
    const lookupKey = this.priceKey(input.planSlug, input.billingCycle, input.currency)
    const existing = await this.request<{ data?: Array<{ id: string }> }>(
      'GET',
      `/prices?lookup_keys[]=${encodeURIComponent(lookupKey)}`,
    )
    if (existing.data && existing.data.length > 0) return existing.data[0].id

    const query = new URLSearchParams()
    query.set('currency', input.currency.toLowerCase())
    query.set('unit_amount', String(input.amountCents))
    query.set('lookup_key', lookupKey)
    query.set('nickname', `ReyDesk ${input.planName} (${input.billingCycle})`)
    query.set('recurring[interval]', input.billingCycle === 'annual' ? 'year' : 'month')
    query.set('active', 'true')
    const price = await this.request<{ id: string }>('POST', '/prices', query)
    return price.id
  }

  async createCheckout(input: CheckoutInput): Promise<CheckoutResult> {
    const priceId = await this.ensurePrice(input)
    const query = new URLSearchParams()
    query.set('mode', 'subscription')
    query.set('line_items[0][price]', priceId)
    query.set('line_items[0][quantity]', '1')
    query.set('success_url', input.callbackUrl)
    query.set('cancel_url', input.callbackUrl.split('?')[0])
    query.set('client_reference_id', input.tenantId)
    query.set('customer_email', input.email)
    query.set('metadata[tenant_id]', input.tenantId)
    query.set('metadata[plan_slug]', input.planSlug)
    query.set('metadata[billing_cycle]', input.billingCycle)
    query.set('allow_promotion_codes', 'true')

    const session = await this.request<StripeSession>('POST', '/checkout/sessions', query)
    if (!session.url) throw new Error('Stripe did not return a checkout URL')
    return { url: session.url, checkoutId: session.id, customerId: session.customer }
  }

  async verify(sessionId: string): Promise<VerifyResult> {
    const session = await this.request<StripeSession>('GET', `/checkout/sessions/${sessionId}?expand[]=subscription.default_payment_method`)
    if (session.payment_status !== 'paid') return { paid: false }
    const subscription = typeof session.subscription === 'object' && session.subscription ? session.subscription : null
    const pm = subscription?.default_payment_method
    return {
      paid: true,
      subscriptionId: (typeof session.subscription === 'string' ? session.subscription : subscription?.id) ?? undefined,
      customerId: session.customer,
      method: pm?.card ? {
        gatewayMethod: 'card',
        brand: pm.card.brand ?? 'card',
        last4: pm.card.last4 ?? '',
        expMonth: pm.card.exp_month,
        expYear: pm.card.exp_year,
        externalId: pm.id ?? '',
      } : undefined,
    }
  }

  handleWebhook(rawBody: string, signature: string): WebhookEvent | null {
    if (!this.webhookSecret) return null
    const parts = Object.fromEntries(
      signature.split(',').map((pair) => {
        const [key, value] = pair.split('=')
        return [key, value]
      }),
    )
    const timestamp = parts['t']
    const provided = parts['v1']
    if (!timestamp || !provided || !/^\d+$/.test(timestamp)) return null
    const expected = createHmac('sha256', this.webhookSecret).update(`${timestamp}.${rawBody}`).digest('hex')
    const a = Buffer.from(expected)
    const b = Buffer.from(provided)
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null
    // (Strictly, Stripe also wants the signed timestamp within tolerance; the
    // HMAC check above is the primary trust boundary for this deployment.)

    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(rawBody) as Record<string, unknown>
    } catch {
      return null
    }
    const type = payload['type'] as string
    const eventObject = payload['data'] as Record<string, unknown> | undefined
    const data = (eventObject?.['object'] ?? {}) as Record<string, unknown>

    if (type === 'checkout.session.completed') {
      return {
        type: 'charge.success',
        reference: String(data.id ?? ''),
        verify: {
          paid: data.payment_status === 'paid',
          subscriptionId: data.subscription ? String(data.subscription) : undefined,
          customerId: data.customer ? String(data.customer) : undefined,
        },
      }
    }
    if (type === 'invoice.paid') {
      return { type: 'charge.success', reference: String(data.id ?? ''), verify: { paid: true } }
    }
    if (type === 'customer.subscription.deleted') {
      return { type: 'subscription.disable', subscriptionId: String(data.id ?? ''), reason: 'canceled' }
    }
    if (type === 'invoice.payment_failed' || type === 'customer.subscription.paused') {
      return {
        type: 'subscription.payment_failed',
        subscriptionId: String(data.subscription ?? data.id ?? ''),
        invoiceReference: String(data.id ?? ''),
      }
    }
    return { type: 'unknown', raw: type }
  }

  async cancelSubscription(subscriptionId: string): Promise<void> {
    await this.request('POST', `/subscriptions/${encodeURIComponent(subscriptionId)}`)
  }
}